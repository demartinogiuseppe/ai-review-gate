/**
 * Optional LLM review pass — CI only, off unless explicitly configured.
 *
 * Deliberately narrow. The deterministic checks own everything they can decide,
 * and this pass is told not to repeat them: no missing-package claims, no secret
 * scanning, no style. It exists for the class of bug an agent produces that no
 * rule can express — logic that contradicts the diff's own stated intent.
 *
 * It speaks the OpenAI chat-completions shape, which is what almost every local
 * and hosted endpoint emulates (llama.cpp, vLLM, Ollama, OpenRouter, Azure).
 *
 * The output of this pass is advisory by default: LLM_ISSUE is not in `block_on`,
 * so a model having a bad day cannot fail anyone's PR until a team opts in.
 */

import { CODES, type Finding, type Severity } from '../findings.js';
import type { LlmPolicy } from '../policy.js';

export interface LlmConfig {
  enabled: boolean;
  url: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxDiffBytes: number;
}

export interface ReviewOptions {
  diff: string;
  config: LlmConfig;
  root: string;
  fetchImpl?: typeof fetch;
}

const SYSTEM_PROMPT = `You review diffs produced by AI coding agents.

Deterministic tools already ran and already report these — never repeat them:
- packages that do not exist on the registry
- hardcoded secrets and key material
- eval, shell and SQL injection patterns
- disabled TLS verification
- style, formatting, naming, import order

Report only high-signal defects a static rule cannot express:
- logic that contradicts what the change says it does
- state mutated in one path but not a sibling path
- an error case handled in a way that silently produces wrong data
- an async boundary where the result is not awaited or the failure is dropped
- a security-relevant check that the diff removes or bypasses

Rules:
- Only report a problem you can point at a specific added line for.
- If the diff is fine, return an empty list. An empty list is a good answer.
- At most 5 findings, most severe first.

Respond with JSON only, no prose, in exactly this shape:
{"findings":[{"file":"src/x.ts","line":42,"severity":"error|warning","message":"what is wrong","fix":"what to do"}]}`;

/** Merges policy with environment. Env wins, so CI can enable the pass without a policy edit. */
export function llmConfigFromEnv(policy: LlmPolicy, env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const url = env['AIGATE_LLM_URL'] ?? policy.url;
  const apiKey = env['AIGATE_LLM_API_KEY'] ?? env['OPENAI_API_KEY'] ?? '';
  return {
    // A URL is what actually turns this on: no endpoint, no pass.
    enabled: (policy.enabled || env['AIGATE_LLM_URL'] !== undefined) && url !== '',
    url,
    apiKey,
    model: env['AIGATE_LLM_MODEL'] ?? policy.model,
    timeoutMs: policy.timeoutMs,
    maxDiffBytes: policy.maxDiffBytes,
  };
}

export async function reviewWithLlm(options: ReviewOptions): Promise<Finding[]> {
  const { config } = options;

  if (!config.enabled) {
    return [
      {
        code: CODES.LLM_UNAVAILABLE,
        severity: 'info',
        check: 'llm',
        message: 'LLM review is disabled',
        fix: 'set AIGATE_LLM_URL (and AIGATE_LLM_API_KEY if the endpoint needs one) to enable it',
      },
    ];
  }

  const diff = truncateDiff(options.diff, config.maxDiffBytes);
  if (diff.trim() === '') return [];

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Review this diff:\n\n${diff}` },
        ],
      }),
    });

    if (!response.ok) {
      return [unavailable(`endpoint returned ${response.status} ${response.statusText}`)];
    }

    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return [unavailable('endpoint returned no content')];

    return parseFindings(content);
  } catch (error) {
    const reason = (error as Error).name === 'AbortError' ? `timed out after ${config.timeoutMs}ms` : (error as Error).message;
    return [unavailable(reason)];
  } finally {
    clearTimeout(timer);
  }
}

function unavailable(reason: string): Finding {
  return {
    code: CODES.LLM_UNAVAILABLE,
    severity: 'info',
    check: 'llm',
    message: `LLM review did not run: ${reason}`,
  };
}

/**
 * Models wrap JSON in prose and fences no matter what the prompt says, so the
 * parser is forgiving about the envelope and strict about the contents.
 */
export function parseFindings(content: string): Finding[] {
  const json = extractJsonObject(content);
  if (!json) return [unavailable('response was not JSON')];

  let payload: { findings?: unknown };
  try {
    payload = JSON.parse(json) as { findings?: unknown };
  } catch {
    return [unavailable('response was not valid JSON')];
  }

  const raw = Array.isArray(payload.findings) ? payload.findings : [];
  const findings: Finding[] = [];

  for (const item of raw.slice(0, 5)) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const message = typeof record['message'] === 'string' ? record['message'].trim() : '';
    if (message === '') continue;

    findings.push({
      code: CODES.LLM_ISSUE,
      severity: normalizeSeverity(record['severity']),
      check: 'llm',
      message,
      file: typeof record['file'] === 'string' ? record['file'] : undefined,
      line: typeof record['line'] === 'number' && Number.isFinite(record['line']) ? record['line'] : undefined,
      fix: typeof record['fix'] === 'string' ? record['fix'] : undefined,
    });
  }

  return findings;
}

function normalizeSeverity(value: unknown): Severity {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  if (text === 'error' || text === 'high' || text === 'critical') return 'error';
  if (text === 'info' || text === 'low') return 'info';
  return 'warning';
}

/** Finds the outermost balanced `{...}`, ignoring braces inside strings. */
function extractJsonObject(content: string): string | null {
  const start = content.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < content.length; i++) {
    const ch = content[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return content.slice(start, i + 1);
    }
  }
  return null;
}

/** Keeps the head of the diff: the first hunks carry the intent of the change. */
export function truncateDiff(diff: string, maxBytes: number): string {
  if (Buffer.byteLength(diff, 'utf8') <= maxBytes) return diff;
  const truncated = Buffer.from(diff, 'utf8').subarray(0, maxBytes).toString('utf8');
  const lastHunk = truncated.lastIndexOf('\ndiff --git ');
  const cut = lastHunk > maxBytes / 2 ? truncated.slice(0, lastHunk) : truncated;
  return `${cut}\n\n[diff truncated at ${maxBytes} bytes]`;
}
