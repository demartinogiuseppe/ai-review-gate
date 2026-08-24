import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reviewWithLlm, llmConfigFromEnv, parseFindings, truncateDiff, type LlmConfig } from '../src/llm/review.js';
import { DEFAULT_POLICY } from '../src/policy.js';
import { CODES } from '../src/findings.js';

const config: LlmConfig = {
  enabled: true,
  url: 'https://llm.test/v1/chat/completions',
  apiKey: 'key',
  model: 'test-model',
  timeoutMs: 5000,
  maxDiffBytes: 60_000,
};

function respondWith(content: string, capture?: (body: unknown) => void): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    capture?.(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

test('llm: off by default, and a URL is what turns it on', () => {
  assert.equal(llmConfigFromEnv(DEFAULT_POLICY.llm, {}).enabled, false);
  assert.equal(llmConfigFromEnv(DEFAULT_POLICY.llm, { AIGATE_LLM_URL: 'https://x/v1' }).enabled, true);
  assert.equal(
    llmConfigFromEnv({ ...DEFAULT_POLICY.llm, enabled: true }, {}).enabled,
    false,
    'enabled with no endpoint is still off — there is nothing to call',
  );

  const fromEnv = llmConfigFromEnv(DEFAULT_POLICY.llm, {
    AIGATE_LLM_URL: 'https://x/v1',
    AIGATE_LLM_MODEL: 'llama-3',
    AIGATE_LLM_API_KEY: 'secret',
  });
  assert.equal(fromEnv.model, 'llama-3', 'env wins so CI can enable the pass without a policy edit');
  assert.equal(fromEnv.apiKey, 'secret');
});

test('llm: disabled reports itself instead of silently doing nothing', async () => {
  const findings = await reviewWithLlm({ diff: 'diff --git a b', config: { ...config, enabled: false }, root: '.' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.code, CODES.LLM_UNAVAILABLE);
  assert.equal(findings[0]!.severity, 'info');
});

test('llm: findings are advisory — the default policy does not block on them', () => {
  assert.equal(DEFAULT_POLICY.blockOn.includes(CODES.LLM_ISSUE), false);
});

test('llm: parses a well-formed response', async () => {
  let sentBody: unknown;
  const findings = await reviewWithLlm({
    diff: 'diff --git a/src/a.ts b/src/a.ts',
    config,
    root: '.',
    fetchImpl: respondWith(
      JSON.stringify({
        findings: [{ file: 'src/a.ts', line: 12, severity: 'error', message: 'token refresh is never awaited', fix: 'await it' }],
      }),
      (body) => {
        sentBody = body;
      },
    ),
  });

  assert.equal(findings.length, 1);
  assert.deepEqual(
    { ...findings[0] },
    {
      code: CODES.LLM_ISSUE,
      severity: 'error',
      check: 'llm',
      message: 'token refresh is never awaited',
      file: 'src/a.ts',
      line: 12,
      fix: 'await it',
    },
  );

  const body = sentBody as { model: string; temperature: number; messages: Array<{ role: string; content: string }> };
  assert.equal(body.model, 'test-model');
  assert.equal(body.temperature, 0);
  assert.match(body.messages[0]!.content, /never repeat them/, 'the prompt must forbid duplicating the deterministic checks');
});

test('llm: survives the ways models actually reply', () => {
  const fenced = parseFindings('Sure!\n```json\n{"findings":[{"message":"m","severity":"warning"}]}\n```\nHope that helps.');
  assert.equal(fenced.length, 1);
  assert.equal(fenced[0]!.severity, 'warning');

  const braceInString = parseFindings('{"findings":[{"message":"use ${x} carefully","severity":"info"}]}');
  assert.equal(braceInString[0]!.message, 'use ${x} carefully');
  assert.equal(braceInString[0]!.severity, 'info');

  assert.equal(parseFindings('{"findings":[]}').length, 0, 'an empty list is a good answer');
  assert.equal(parseFindings('I could not find anything wrong.')[0]!.code, CODES.LLM_UNAVAILABLE);
  assert.equal(parseFindings('{not json at all}')[0]!.code, CODES.LLM_UNAVAILABLE);
  assert.equal(parseFindings('{"findings":[{"message":""},{"nope":1}]}').length, 0, 'entries with no message are dropped');

  const many = parseFindings(JSON.stringify({ findings: Array.from({ length: 20 }, (_, i) => ({ message: `m${i}` })) }));
  assert.equal(many.length, 5, 'capped so one bad response cannot flood the report');
  assert.equal(many[0]!.severity, 'warning', 'unknown severity falls back to warning');
});

test('llm: an unhappy endpoint degrades to info, never to a block', async () => {
  const failing = (async () => new Response('nope', { status: 500, statusText: 'Server Error' })) as unknown as typeof fetch;
  const http = await reviewWithLlm({ diff: 'x', config, root: '.', fetchImpl: failing });
  assert.equal(http[0]!.code, CODES.LLM_UNAVAILABLE);
  assert.match(http[0]!.message, /500/);

  const throwing = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const network = await reviewWithLlm({ diff: 'x', config, root: '.', fetchImpl: throwing });
  assert.equal(network[0]!.code, CODES.LLM_UNAVAILABLE);
  assert.match(network[0]!.message, /ECONNREFUSED/);

  const empty = await reviewWithLlm({ diff: 'x', config, root: '.', fetchImpl: respondWith('') });
  assert.equal(empty[0]!.code, CODES.LLM_UNAVAILABLE);
});

test('llm: an empty diff costs nothing', async () => {
  let called = false;
  const findings = await reviewWithLlm({
    diff: '   \n',
    config,
    root: '.',
    fetchImpl: respondWith('{"findings":[]}', () => {
      called = true;
    }),
  });
  assert.deepEqual(findings, []);
  assert.equal(called, false);
});

test('llm: long diffs are cut at a file boundary', () => {
  const short = 'diff --git a/a b/a\n+x\n';
  assert.equal(truncateDiff(short, 1000), short);

  const long = `diff --git a/a b/a\n${'+x\n'.repeat(400)}\ndiff --git a/b b/b\n${'+y\n'.repeat(400)}`;
  const cut = truncateDiff(long, 900);
  assert.ok(cut.length < long.length);
  assert.match(cut, /\[diff truncated at 900 bytes\]/);
  assert.equal(cut.includes('diff --git a/b'), false, 'cut at the file boundary, not mid-hunk');
});
