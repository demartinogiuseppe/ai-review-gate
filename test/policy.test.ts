import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseYaml } from '../src/yaml.js';
import { matchesGlob, matchesAny } from '../src/glob.js';
import { loadPolicy, findPolicyFile, DEFAULT_POLICY, PolicyError } from '../src/policy.js';

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), 'aigate-test-'));
}

test('yaml: nested maps, lists and scalars', () => {
  const parsed = parseYaml(
    [
      '# leading comment',
      'version: 1',
      'block_on:',
      '  - A_CODE',
      '  - "B_CODE"  # trailing comment',
      'registry:',
      '  enabled: true',
      '  timeout_ms: 4000',
      '  allowlist: []',
      '  url: "https://example.com/#anchor"',
      'llm:',
      '  enabled: false',
      '  ratio: 0.5',
      '  empty:',
    ].join('\n'),
  ) as Record<string, unknown>;

  assert.equal(parsed['version'], 1);
  assert.deepEqual(parsed['block_on'], ['A_CODE', 'B_CODE']);
  assert.deepEqual(parsed['registry'], {
    enabled: true,
    timeout_ms: 4000,
    allowlist: [],
    url: 'https://example.com/#anchor',
  });
  assert.deepEqual(parsed['llm'], { enabled: false, ratio: 0.5, empty: null });
});

test('yaml: list of maps', () => {
  const parsed = parseYaml(['rules:', '  - id: one', '    severity: ERROR', '  - id: two', '    severity: WARNING'].join('\n')) as {
    rules: unknown[];
  };
  assert.deepEqual(parsed.rules, [
    { id: 'one', severity: 'ERROR' },
    { id: 'two', severity: 'WARNING' },
  ]);
});

test('glob: star does not cross directory separators, globstar does', () => {
  assert.equal(matchesGlob('src/auth/login.ts', 'src/auth/**'), true);
  assert.equal(matchesGlob('src/auth/deep/nested/x.ts', 'src/auth/**'), true);
  assert.equal(matchesGlob('src/payments/x.ts', 'src/auth/**'), false);
  assert.equal(matchesGlob('src/a.min.js', '**/*.min.js'), true);
  assert.equal(matchesGlob('a.min.js', '**/*.min.js'), true, 'leading **/ must match zero segments');
  assert.equal(matchesGlob('src/x.ts', 'src/*'), true);
  assert.equal(matchesGlob('src/deep/x.ts', 'src/*'), false);
  assert.equal(matchesGlob('src/x.tsx', 'src/*.{ts,tsx}'), true);
  assert.equal(matchesAny('node_modules/pkg/index.js', DEFAULT_POLICY.ignorePaths), true);
});

test('glob: normalises windows separators', () => {
  assert.equal(matchesGlob('src\\auth\\login.ts', 'src/auth/**'), true);
});

test('policy: defaults apply when no file exists', () => {
  const dir = sandbox();
  const loaded = loadPolicy({ cwd: dir });
  assert.equal(loaded.source, null);
  assert.deepEqual(loaded.policy.blockOn, DEFAULT_POLICY.blockOn);
});

test('policy: file overrides merge over defaults', () => {
  const dir = sandbox();
  writeFileSync(
    join(dir, 'policy.yml'),
    ['version: 1', 'block_on:', '  - SEMGREP_WARNING', 'registry:', '  timeout_ms: 1234'].join('\n'),
  );

  const { policy, source } = loadPolicy({ cwd: dir });
  assert.ok(source?.endsWith('policy.yml'));
  assert.deepEqual(policy.blockOn, ['SEMGREP_WARNING'], 'lists replace, they do not append');
  assert.equal(policy.registry.timeoutMs, 1234);
  assert.equal(policy.registry.enabled, true, 'untouched keys keep their default');
  assert.deepEqual(policy.criticalPaths, DEFAULT_POLICY.criticalPaths);
});

test('policy: is discovered from a nested working directory', () => {
  const dir = sandbox();
  writeFileSync(join(dir, 'policy.yml'), 'version: 1');
  const nested = join(dir, 'src', 'deep');
  mkdirSync(nested, { recursive: true });
  assert.equal(findPolicyFile(nested), join(dir, 'policy.yml'));
});

test('policy: unknown keys warn instead of failing', () => {
  const dir = sandbox();
  writeFileSync(join(dir, 'policy.yml'), ['block_onn:', '  - X', 'registry:', '  timeoutms: 10'].join('\n'));
  const { warnings } = loadPolicy({ cwd: dir });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0]!, /block_onn/);
  assert.match(warnings[1]!, /registry\.timeoutms/);
});

test('policy: wrong types fail loudly', () => {
  const dir = sandbox();
  writeFileSync(join(dir, 'policy.yml'), 'registry:\n  enabled: maybe');
  assert.throws(() => loadPolicy({ cwd: dir }), PolicyError);
});

test('policy: a missing explicit path is an error, not a silent default', () => {
  const dir = sandbox();
  assert.throws(() => loadPolicy({ cwd: dir, policyPath: 'nope.yml' }), PolicyError);
});
