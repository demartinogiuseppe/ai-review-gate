import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkSemgrep, resolveConfigs } from '../src/checks/semgrep.js';
import { DEFAULT_POLICY } from '../src/policy.js';
import { CODES } from '../src/findings.js';
import type { Runner, RunResult } from '../src/exec.js';

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'aigate-sg-'));
  mkdirSync(join(root, 'semgrep'), { recursive: true });
  writeFileSync(join(root, 'semgrep', 'rules.yml'), 'rules: []');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'const x = 1;\n');
  return root;
}

function fakeRunner(result: Partial<RunResult>, capture?: (args: readonly string[]) => void): Runner {
  return async (_command, args) => {
    capture?.(args);
    return { code: 0, stdout: '{"results":[]}', stderr: '', notFound: false, timedOut: false, ...result };
  };
}

const policy = DEFAULT_POLICY.semgrep;

test('semgrep: maps results to codes and locations', async () => {
  const root = sandbox();
  const stdout = JSON.stringify({
    results: [
      {
        check_id: 'semgrep.rules.aigate-eval-on-input',
        path: 'src/app.ts',
        start: { line: 12, col: 5 },
        extra: { message: 'eval on\n  a variable', severity: 'ERROR' },
      },
      {
        check_id: 'aigate-empty-catch',
        path: join(root, 'src', 'app.ts'),
        start: { line: 30, col: 1 },
        extra: { message: 'swallowed error', severity: 'WARNING' },
      },
      { check_id: 'aigate-todo', path: 'src/app.ts', start: { line: 1 }, extra: { message: 'todo', severity: 'INFO' } },
    ],
  });

  const findings = await checkSemgrep({
    files: [join(root, 'src', 'app.ts')],
    policy,
    root,
    runner: fakeRunner({ stdout }),
  });

  assert.deepEqual(findings.map((f) => f.code), [CODES.SEMGREP_ERROR, CODES.SEMGREP_WARNING, CODES.SEMGREP_INFO]);
  assert.equal(findings[0]!.message, 'aigate-eval-on-input: eval on a variable');
  assert.equal(findings[0]!.file, 'src/app.ts');
  assert.equal(findings[0]!.line, 12);
  assert.equal(findings[0]!.column, 5);
  assert.equal(findings[1]!.file, 'src/app.ts', 'absolute paths are made repo-relative');
});

test('semgrep: a missing binary is informational, never a block', async () => {
  const root = sandbox();
  const findings = await checkSemgrep({
    files: [join(root, 'src', 'app.ts')],
    policy,
    root,
    runner: fakeRunner({ notFound: true, code: null }),
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.code, CODES.SEMGREP_UNAVAILABLE);
  assert.equal(findings[0]!.severity, 'info');
});

test('semgrep: a timeout degrades instead of failing the run', async () => {
  const root = sandbox();
  const findings = await checkSemgrep({
    files: [join(root, 'src', 'app.ts')],
    policy,
    root,
    runner: fakeRunner({ timedOut: true, stdout: '' }),
  });

  assert.equal(findings[0]!.code, CODES.SEMGREP_UNAVAILABLE);
  assert.match(findings[0]!.message, /timed out/);
});

test('semgrep: unparsable output degrades instead of throwing', async () => {
  const root = sandbox();
  const findings = await checkSemgrep({
    files: [join(root, 'src', 'app.ts')],
    policy,
    root,
    runner: fakeRunner({ stdout: 'Traceback (most recent call last):', code: 2, stderr: 'boom' }),
  });

  assert.equal(findings[0]!.code, CODES.SEMGREP_UNAVAILABLE);
  assert.equal(findings[0]!.severity, 'info');
});

test('semgrep: only the given files are scanned', async () => {
  const root = sandbox();
  let seen: readonly string[] = [];
  await checkSemgrep({
    files: [join(root, 'src', 'app.ts'), join(root, 'src', 'gone.ts')],
    policy,
    root,
    runner: fakeRunner({}, (args) => {
      seen = args;
    }),
  });

  const afterSeparator = seen.slice(seen.indexOf('--') + 1);
  assert.deepEqual(afterSeparator, [join(root, 'src', 'app.ts')], 'deleted files are dropped, no directory is passed');
  assert.ok(seen.includes('--json'));
  assert.ok(seen.includes('--config'));
});

test('semgrep: registry packs pass through, local paths must exist', () => {
  const root = sandbox();
  assert.deepEqual(resolveConfigs(['p/secrets', 'auto', 'https://x/y.yml'], root), ['p/secrets', 'auto', 'https://x/y.yml']);
  assert.deepEqual(resolveConfigs(['semgrep/rules.yml'], root), [join(root, 'semgrep', 'rules.yml')]);
  assert.deepEqual(resolveConfigs(['semgrep/nope.yml'], root), []);
});

test('semgrep: disabled by policy runs nothing', async () => {
  const root = sandbox();
  let called = false;
  const findings = await checkSemgrep({
    files: [join(root, 'src', 'app.ts')],
    policy: { ...policy, enabled: false },
    root,
    runner: fakeRunner({}, () => {
      called = true;
    }),
  });
  assert.deepEqual(findings, []);
  assert.equal(called, false);
});
