import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { runGate, isBlocking } from '../src/gate.js';
import { DEFAULT_POLICY, type Policy } from '../src/policy.js';
import { CODES, type Finding } from '../src/findings.js';
import { formatReport, exitCodeFor } from '../src/report.js';
import { parseArgs, main, EXIT_PASS, EXIT_BLOCK, EXIT_TOOL_ERROR, type Io } from '../src/cli.js';
import { changedFiles, rangeArgs, GitError } from '../src/git.js';
import type { Runner } from '../src/exec.js';

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'aigate-gate-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0' } }));
  // The default policy points semgrep at semgrep/rules.yml; without it the check
  // short-circuits before the runner is ever consulted.
  mkdirSync(join(root, 'semgrep'), { recursive: true });
  writeFileSync(join(root, 'semgrep', 'rules.yml'), 'rules: []');
  return root;
}

function write(root: string, relativePath: string, content: string): string {
  const full = join(root, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  return full;
}

/** Everything resolves except names containing "ghost" or "made-up". */
const fakeNpm = (async (input: string | URL | Request) => {
  const url = String(input);
  const missing = url.includes('ghost') || url.includes('made-up');
  return new Response(null, { status: missing ? 404 : 200 });
}) as unknown as typeof fetch;
const noSemgrep: Runner = async () => ({ code: null, stdout: '', stderr: '', notFound: true, timedOut: false });

function policyWith(overrides: Partial<Policy>): Policy {
  return { ...structuredClone(DEFAULT_POLICY), ...overrides };
}

test('gate: ignore_paths are never checked', async () => {
  const root = sandbox();
  const ignored = write(root, 'dist/bundle.js', "require('totally-made-up-pkg');");
  const checked = write(root, 'src/app.ts', "import express from 'express';");

  const result = await runGate({
    files: [ignored, checked],
    policy: DEFAULT_POLICY,
    root,
    cacheDir: null,
    fetchImpl: fakeNpm,
    runner: noSemgrep,
  });

  assert.deepEqual(result.ignoredFiles, ['dist/bundle.js']);
  assert.deepEqual(result.checkedFiles, ['src/app.ts']);
  assert.equal(result.findings.some((f) => f.code === CODES.REGISTRY_MISSING_PACKAGE), false);
});

test('gate: critical paths are flagged and escalate warnings', async () => {
  const root = sandbox();
  const file = write(root, 'src/auth/login.ts', 'const x = 1;');

  const semgrepWarning: Runner = async () => ({
    code: 0,
    stdout: JSON.stringify({
      results: [
        { check_id: 'aigate-empty-catch', path: 'src/auth/login.ts', start: { line: 3 }, extra: { message: 'swallowed', severity: 'WARNING' } },
      ],
    }),
    stderr: '',
    notFound: false,
    timedOut: false,
  });

  const result = await runGate({
    files: [file],
    policy: DEFAULT_POLICY,
    root,
    cacheDir: null,
    fetchImpl: fakeNpm,
    runner: semgrepWarning,
  });

  assert.ok(result.findings.some((f) => f.code === CODES.CRITICAL_PATH_TOUCHED));
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0]!.code, CODES.SEMGREP_WARNING);
});

test('gate: the same warning outside a critical path does not block', async () => {
  const root = sandbox();
  const file = write(root, 'src/util/helper.ts', 'const x = 1;');

  const semgrepWarning: Runner = async () => ({
    code: 0,
    stdout: JSON.stringify({
      results: [
        { check_id: 'aigate-empty-catch', path: 'src/util/helper.ts', start: { line: 3 }, extra: { message: 'swallowed', severity: 'WARNING' } },
      ],
    }),
    stderr: '',
    notFound: false,
    timedOut: false,
  });

  const result = await runGate({
    files: [file],
    policy: DEFAULT_POLICY,
    root,
    cacheDir: null,
    fetchImpl: fakeNpm,
    runner: semgrepWarning,
  });

  assert.equal(result.blocking.length, 0);
  assert.equal(exitCodeFor(result), 0);
});

test('gate: block_on decides, severity does not', () => {
  const error: Finding = { code: CODES.SEMGREP_ERROR, severity: 'error', check: 'semgrep', message: 'x', file: 'src/a.ts' };
  const permissive = policyWith({ blockOn: [], criticalPathBlockOn: [] });
  assert.equal(isBlocking(error, DEFAULT_POLICY), true);
  assert.equal(isBlocking(error, permissive), false, 'an error the policy does not list must not block');

  const info: Finding = { code: 'CUSTOM_CODE', severity: 'info', check: 'policy', message: 'x', file: 'src/a.ts' };
  assert.equal(isBlocking(info, policyWith({ blockOn: ['CUSTOM_CODE'] })), true, 'policy can block on anything');
});

test('gate: a finding with no file cannot be escalated by critical paths', () => {
  const finding: Finding = { code: CODES.SEMGREP_WARNING, severity: 'warning', check: 'semgrep', message: 'x' };
  assert.equal(isBlocking(finding, DEFAULT_POLICY), false);
});

test('report: human output stays machine-parsable', async () => {
  const root = sandbox();
  const file = write(root, 'src/app.ts', "import ghost from 'ghost-pkg-xyz';");

  const result = await runGate({ files: [file], policy: DEFAULT_POLICY, root, cacheDir: null, fetchImpl: fakeNpm, runner: noSemgrep });
  const text = formatReport(
    { result, policy: DEFAULT_POLICY, policySource: null, scope: '1 file(s)', warnings: [], color: false },
    'human',
  );

  assert.match(text, /^BLOCKING \(1\)$/m);
  assert.match(text, /REGISTRY_MISSING_PACKAGE: "ghost-pkg-xyz" .* \[src\/app\.ts:1\]/);
  assert.match(text, /aigate: BLOCK/);
  assert.doesNotMatch(text, /\[/, 'no ANSI when colour is off');
});

test('report: markdown carries a stable marker for comment updates', async () => {
  const root = sandbox();
  const file = write(root, 'src/app.ts', "import ghost from 'ghost-pkg-xyz';");
  const result = await runGate({ files: [file], policy: DEFAULT_POLICY, root, cacheDir: null, fetchImpl: fakeNpm, runner: noSemgrep });

  const text = formatReport(
    { result, policy: DEFAULT_POLICY, policySource: null, scope: 'main...HEAD', warnings: [], color: false },
    'markdown',
  );

  assert.match(text, /<!-- aigate-summary -->/);
  assert.match(text, /ai-review: BLOCK/);
  assert.match(text, /\| `REGISTRY_MISSING_PACKAGE` \| `src\/app\.ts:1` \|/);
});

test('cli: parses commands, repeated file values and formats', () => {
  const args = parseArgs(['check', '--files', 'a.ts', 'b.ts', '--format', 'json', '--no-semgrep']);
  assert.equal(args.command, 'check');
  assert.deepEqual(args.files, ['a.ts', 'b.ts']);
  assert.equal(args.format, 'json');
  assert.equal(args.noSemgrep, true);

  assert.equal(parseArgs(['check', '--json']).format, 'json');
  assert.throws(() => parseArgs(['check', '--nope']), /unknown option/);
  assert.throws(() => parseArgs(['check', '--format', 'yaml']), /unknown format/);
  assert.throws(() => parseArgs(['check', '--diff']), /needs a value/);
});

test('cli: exit codes are 0 pass, 1 block, 2 tool error', async () => {
  const root = sandbox();
  write(root, 'policy.yml', 'semgrep:\n  enabled: false\nregistry:\n  allowlist: ["express"]\n');
  write(root, 'src/clean.ts', "import express from 'express';");
  write(root, 'src/dirty.ts', "import ghost from 'ghost-pkg-that-cannot-exist-xyz';");

  const quiet = captureIo();
  try {
    assert.equal(await main(['check', '--files', 'src/clean.ts', '--cwd', root, '--no-registry'], quiet.io), EXIT_PASS);
    assert.equal(await main(['nonsense', '--cwd', root], quiet.io), EXIT_TOOL_ERROR);
    assert.equal(await main(['check', '--cwd', root], quiet.io), EXIT_TOOL_ERROR, 'no target is a usage error');
    assert.equal(await main(['check', '--files', 'x.ts', '--policy', 'missing.yml', '--cwd', root], quiet.io), EXIT_TOOL_ERROR);
    assert.equal(await main(['print-policy', '--cwd', root], quiet.io), EXIT_PASS);
    assert.equal(await main(['--version'], quiet.io), EXIT_PASS);
  } finally {
    /* nothing to restore */
  }
});

test('cli: a file set that is entirely ignored passes', async () => {
  const root = sandbox();
  write(root, 'dist/x.js', "require('ghost-pkg-xyz')");
  const quiet = captureIo();
  try {
    assert.equal(await main(['check', '--files', 'dist/x.js', '--cwd', root, '--no-semgrep'], quiet.io), EXIT_PASS);
  } finally {
    /* nothing to restore */
  }
  assert.match(quiet.text(), /PASS/);
});

test('cli: blocks on a hallucinated import end to end', async () => {
  // A real HTTP server, so this exercises the actual fetch path the CLI uses.
  const registry = createServer((request, response) => {
    response.writeHead(request.url?.includes('ghost') ? 404 : 200).end();
  });
  await new Promise<void>((done) => registry.listen(0, '127.0.0.1', done));
  const port = (registry.address() as AddressInfo).port;

  const root = sandbox();
  write(root, 'policy.yml', ['registry:', `  registry_url: "http://127.0.0.1:${port}"`, 'semgrep:', '  enabled: false'].join('\n'));
  write(root, 'src/dirty.ts', "import ghost from 'ghost-pkg-that-cannot-exist-xyz';");

  const quiet = captureIo();
  let code: number;
  try {
    code = await main(['check', '--files', 'src/dirty.ts', '--cwd', root, '--no-color'], quiet.io);
  } finally {
    /* nothing to restore */
    registry.close();
  }

  assert.equal(code, EXIT_BLOCK);
  assert.match(quiet.text(), /REGISTRY_MISSING_PACKAGE/);
  assert.match(quiet.text(), /aigate: BLOCK/);
});

test('cli: a clean file against the same registry passes', async () => {
  const registry = createServer((_request, response) => response.writeHead(200).end());
  await new Promise<void>((done) => registry.listen(0, '127.0.0.1', done));
  const port = (registry.address() as AddressInfo).port;

  const root = sandbox();
  write(root, 'policy.yml', ['registry:', `  registry_url: "http://127.0.0.1:${port}"`, 'semgrep:', '  enabled: false'].join('\n'));
  write(root, 'src/clean.ts', "import express from 'express';");

  const quiet = captureIo();
  let code: number;
  try {
    code = await main(['check', '--files', 'src/clean.ts', '--cwd', root, '--no-color'], quiet.io);
  } finally {
    /* nothing to restore */
    registry.close();
  }

  assert.equal(code, EXIT_PASS);
  assert.match(quiet.text(), /aigate: PASS/);
});

test('git: ranges are passed through, junk is rejected', () => {
  assert.deepEqual(rangeArgs('main...HEAD'), ['main...HEAD']);
  assert.deepEqual(rangeArgs('  main..HEAD  '), ['main..HEAD']);
  assert.throws(() => rangeArgs(''), GitError);
  assert.throws(() => rangeArgs('--upload-pack=evil'), GitError);
});

test('git: changed files come back absolute, deletions excluded by the filter', async () => {
  const root = sandbox();
  let seenArgs: readonly string[] = [];
  const runner: Runner = async (_cmd, args) => {
    seenArgs = args;
    return { code: 0, stdout: 'src/a.ts\nsrc/b.ts\n\n', stderr: '', notFound: false, timedOut: false };
  };

  const files = await changedFiles('main...HEAD', { cwd: root, runner });
  assert.deepEqual(files, [join(root, 'src', 'a.ts'), join(root, 'src', 'b.ts')]);
  assert.ok(seenArgs.includes('--diff-filter=ACMR'));
});

test('git: a failing git command is a tool error, not a block', async () => {
  const runner: Runner = async () => ({ code: 128, stdout: '', stderr: 'fatal: bad revision', notFound: false, timedOut: false });
  await assert.rejects(() => changedFiles('nope...HEAD', { cwd: process.cwd(), runner }), GitError);
});

/** Collects CLI output through the injected sink; no globals are touched. */
function captureIo(): { text: () => string; io: Io } {
  let buffer = '';
  const sink = (text: string): void => {
    buffer += text;
  };
  return { text: () => buffer, io: { out: sink, err: sink } };
}
