import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractImports, toPackageName, isValidPackageName, stripComments } from '../src/checks/imports.js';
import { checkRegistry } from '../src/checks/registry.js';
import { DEFAULT_POLICY } from '../src/policy.js';
import { CODES } from '../src/findings.js';

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), 'aigate-reg-'));
}

function write(root: string, relativePath: string, content: string): string {
  const full = join(root, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  return full;
}

/** A registry that only knows about the packages it is given. */
function fakeRegistry(known: readonly string[], onCall?: (url: string) => void): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    onCall?.(url);
    const name = decodeURIComponent(url.slice(url.indexOf('registry.test/') + 'registry.test/'.length));
    return new Response(null, { status: known.includes(name) ? 200 : 404 });
  }) as unknown as typeof fetch;
}

const registryPolicy = { ...DEFAULT_POLICY.registry, registryUrl: 'https://registry.test' };

test('imports: extracts every syntax form and skips the rest', () => {
  const refs = extractImports(
    [
      "import express from 'express';",
      'import type { Foo } from "@scope/types";',
      "import './styles.css';",
      "import x from '../local/util.js';",
      "const fs = require('node:fs');",
      "const lodash = require('lodash/fp');",
      "const mod = await import('some-dynamic-pkg');",
      "export { a } from 'reexported-pkg';",
      "export * from 'star-pkg';",
      "import alias from '@/components/Button';",
      "import远 from 'https://esm.sh/react';",
    ].join('\n'),
  );

  const names = refs.map((r) => r.packageName);
  assert.deepEqual(new Set(names), new Set(['express', '@scope/types', 'node:fs', 'lodash', 'some-dynamic-pkg', 'reexported-pkg', 'star-pkg']));
  assert.equal(refs.find((r) => r.packageName === 'express')?.line, 1);
  assert.equal(refs.find((r) => r.packageName === 'lodash')?.specifier, 'lodash/fp');
});

test('imports: commented-out imports are not findings', () => {
  const refs = extractImports(
    ['// import ghost from "ghost-pkg";', '/* import other from "other-pkg"; */', "import real from 'real-pkg';"].join('\n'),
  );
  assert.deepEqual(refs.map((r) => r.packageName), ['real-pkg']);
});

test('imports: stripComments preserves line numbers', () => {
  const stripped = stripComments('/* a\nb\nc */\nimport x from "p";');
  assert.equal(stripped.split('\n').length, 4);
  assert.equal(stripped.split('\n')[3], 'import x from "p";');
});

test('imports: a comment marker inside a string is not a comment', () => {
  const refs = extractImports(['const url = "http://example.com/#/x";', "import real from 'real-pkg';"].join('\n'));
  assert.deepEqual(refs.map((r) => r.packageName), ['real-pkg']);
});

test('imports: package name derivation and validity', () => {
  assert.equal(toPackageName('lodash/fp/get'), 'lodash');
  assert.equal(toPackageName('@scope/pkg/sub/path'), '@scope/pkg');
  assert.equal(isValidPackageName('react-dom'), true);
  assert.equal(isValidPackageName('@scope/pkg'), true);
  assert.equal(isValidPackageName('React'), false);
  assert.equal(isValidPackageName('.hidden'), false);
});

test('registry: a hallucinated package blocks, a real one does not', async () => {
  const root = sandbox();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0' } }));
  const file = write(root, 'src/app.ts', ["import express from 'express';", "import magic from 'super-ai-toolkit-9000';"].join('\n'));

  const findings = await checkRegistry({
    files: [file],
    policy: registryPolicy,
    root,
    cacheDir: null,
    fetchImpl: fakeRegistry(['express']),
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.code, CODES.REGISTRY_MISSING_PACKAGE);
  assert.equal(findings[0]!.severity, 'error');
  assert.equal(findings[0]!.file, 'src/app.ts');
  assert.equal(findings[0]!.line, 2);
  assert.match(findings[0]!.message, /super-ai-toolkit-9000/);
});

test('registry: node builtins and allowlisted packages never hit the network', async () => {
  const root = sandbox();
  writeFileSync(join(root, 'package.json'), '{}');
  const file = write(root, 'src/app.ts', ["import fs from 'node:fs';", "import path from 'path';", "import internal from '@acme/internal';"].join('\n'));

  const calls: string[] = [];
  const findings = await checkRegistry({
    files: [file],
    policy: { ...registryPolicy, allowlist: ['@acme/internal'] },
    root,
    cacheDir: null,
    fetchImpl: fakeRegistry([], (url) => calls.push(url)),
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(findings, []);
});

test('registry: a package installed in node_modules is proof enough', async () => {
  const root = sandbox();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'local-only': '1.0.0' } }));
  write(root, 'node_modules/local-only/package.json', '{"name":"local-only"}');
  const file = write(root, 'src/app.ts', "import x from 'local-only';");

  const calls: string[] = [];
  const findings = await checkRegistry({
    files: [file],
    policy: registryPolicy,
    root,
    cacheDir: null,
    fetchImpl: fakeRegistry([], (url) => calls.push(url)),
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(findings, []);
});

test('registry: an unreachable registry warns instead of blocking', async () => {
  const root = sandbox();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0' } }));
  const file = write(root, 'src/app.ts', "import express from 'express';");

  const offline = (async () => {
    throw new Error('ENOTFOUND');
  }) as unknown as typeof fetch;

  const findings = await checkRegistry({ files: [file], policy: registryPolicy, root, cacheDir: null, fetchImpl: offline });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.code, CODES.REGISTRY_UNVERIFIED);
  assert.equal(findings[0]!.severity, 'warning');
});

test('registry: allow_offline false turns unverified into an error', async () => {
  const root = sandbox();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0' } }));
  const file = write(root, 'src/app.ts', "import express from 'express';");

  const offline = (async () => {
    throw new Error('ENOTFOUND');
  }) as unknown as typeof fetch;

  const findings = await checkRegistry({
    files: [file],
    policy: { ...registryPolicy, allowOffline: false },
    root,
    cacheDir: null,
    fetchImpl: offline,
  });

  assert.equal(findings[0]!.severity, 'error');
});

test('registry: a real but undeclared package is a warning, not a block', async () => {
  const root = sandbox();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: {} }));
  const file = write(root, 'src/app.ts', "import chalk from 'chalk';");

  const findings = await checkRegistry({
    files: [file],
    policy: registryPolicy,
    root,
    cacheDir: null,
    fetchImpl: fakeRegistry(['chalk']),
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.code, CODES.REGISTRY_UNDECLARED_PACKAGE);
  assert.equal(findings[0]!.severity, 'warning');
});

test('registry: the cache spares the network on the second run', async () => {
  const root = sandbox();
  const cacheDir = join(root, '.aigate-cache');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { ghost: '1.0.0' } }));
  const file = write(root, 'src/app.ts', "import ghost from 'ghost-that-never-was';");

  const calls: string[] = [];
  const fetchImpl = fakeRegistry([], (url) => calls.push(url));

  const first = await checkRegistry({ files: [file], policy: registryPolicy, root, cacheDir, fetchImpl });
  const second = await checkRegistry({ files: [file], policy: registryPolicy, root, cacheDir, fetchImpl });

  assert.equal(calls.length, 1, 'second run must be served from cache');
  assert.equal(first[0]!.code, CODES.REGISTRY_MISSING_PACKAGE);
  assert.equal(second[0]!.code, CODES.REGISTRY_MISSING_PACKAGE);
  assert.match(second[0]!.message, /cached/);
});

test('registry: an expired negative cache entry is re-checked', async () => {
  const root = sandbox();
  const cacheDir = join(root, '.aigate-cache');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'later-published': '1.0.0' } }));
  const file = write(root, 'src/app.ts', "import x from 'later-published';");

  let known: string[] = [];
  const calls: string[] = [];
  const fetchImpl = fakeRegistry([], (url) => calls.push(url));
  const publishedFetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(null, { status: known.includes('later-published') ? 200 : 404 });
  }) as unknown as typeof fetch;

  let clock = 1_000_000;
  await checkRegistry({ files: [file], policy: registryPolicy, root, cacheDir, fetchImpl, now: () => clock });

  known = ['later-published'];
  clock += 2 * 60 * 60 * 1000; // past the one-hour negative TTL
  const findings = await checkRegistry({
    files: [file],
    policy: registryPolicy,
    root,
    cacheDir,
    fetchImpl: publishedFetch,
    now: () => clock,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(findings, [], 'now that it exists and is declared, nothing to report');
});

test('registry: non-source and deleted files are skipped', async () => {
  const root = sandbox();
  writeFileSync(join(root, 'package.json'), '{}');
  const readme = write(root, 'README.md', "import ghost from 'ghost-pkg';");

  const findings = await checkRegistry({
    files: [readme, join(root, 'src', 'deleted.ts')],
    policy: registryPolicy,
    root,
    cacheDir: null,
    fetchImpl: fakeRegistry([]),
  });

  assert.deepEqual(findings, []);
});
