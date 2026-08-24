/**
 * Semgrep check.
 *
 * Semgrep is an optional peer tool, not a dependency: if it is missing the gate
 * reports SEMGREP_UNAVAILABLE (info) and keeps going, so a developer without it
 * still gets the registry check in-session. CI installs it and gets the full set.
 *
 * Only changed files are ever scanned — in-session that is the file being written,
 * in CI it is the diff. Scanning the whole repo on every write is what makes gates
 * get switched off.
 */

import { existsSync } from 'node:fs';

import { CODES, type Finding, type Severity } from '../findings.js';
import type { SemgrepPolicy } from '../policy.js';
import { resolveFromRoot } from '../policy.js';
import { normalizePath } from '../glob.js';
import { run, type Runner } from '../exec.js';
import { resolve } from 'node:path';

export interface SemgrepCheckOptions {
  /** Absolute paths to scan. */
  files: readonly string[];
  policy: SemgrepPolicy;
  root: string;
  runner?: Runner;
  /** Overrides the binary name; defaults to $AIGATE_SEMGREP_BIN or `semgrep`. */
  binary?: string;
}

interface SemgrepResult {
  check_id?: string;
  path?: string;
  start?: { line?: number; col?: number };
  extra?: { message?: string; severity?: string; metadata?: { fix?: string; references?: string[] } };
}

interface SemgrepOutput {
  results?: SemgrepResult[];
  errors?: Array<{ message?: string; level?: string }>;
}

/** Command lines have a length limit on every OS; scan in batches. */
const FILES_PER_INVOCATION = 100;

export async function checkSemgrep(options: SemgrepCheckOptions): Promise<Finding[]> {
  const { policy, root } = options;
  if (!policy.enabled) return [];

  const files = options.files.filter((file) => existsSync(file));
  if (files.length === 0) return [];

  const configs = resolveConfigs(policy.config, root);
  if (configs.length === 0) {
    return [
      {
        code: CODES.SEMGREP_UNAVAILABLE,
        severity: 'info',
        check: 'semgrep',
        message: 'no semgrep config resolved; nothing scanned',
        fix: 'point semgrep.config in policy.yml at a rules file or a registry pack such as p/secrets',
      },
    ];
  }

  const runner = options.runner ?? run;
  const binary = options.binary ?? process.env['AIGATE_SEMGREP_BIN'] ?? 'semgrep';
  const findings: Finding[] = [];

  for (let i = 0; i < files.length; i += FILES_PER_INVOCATION) {
    const batch = files.slice(i, i + FILES_PER_INVOCATION);
    const args = [
      '--json',
      '--quiet',
      '--disable-version-check',
      '--metrics=off',
      // The gate is told exactly which files to look at; repo ignore rules must not veto that.
      '--no-git-ignore',
      ...configs.flatMap((config) => ['--config', config]),
      '--',
      ...batch,
    ];

    const result = await runner(binary, args, { cwd: root, timeoutMs: policy.timeoutMs });

    if (result.notFound) {
      return [
        {
          code: CODES.SEMGREP_UNAVAILABLE,
          severity: 'info',
          check: 'semgrep',
          message: `semgrep is not installed; static analysis was skipped (${binary})`,
          fix: 'install it with "pipx install semgrep" (or set semgrep.enabled: false in policy.yml)',
        },
      ];
    }

    if (result.timedOut) {
      findings.push({
        code: CODES.SEMGREP_UNAVAILABLE,
        severity: 'info',
        check: 'semgrep',
        message: `semgrep timed out after ${policy.timeoutMs}ms on ${batch.length} file(s)`,
        fix: 'raise semgrep.timeout_ms in policy.yml or narrow semgrep.config',
      });
      continue;
    }

    let parsed: SemgrepOutput;
    try {
      parsed = JSON.parse(result.stdout) as SemgrepOutput;
    } catch {
      findings.push({
        code: CODES.SEMGREP_UNAVAILABLE,
        severity: 'info',
        check: 'semgrep',
        message: `semgrep produced no parsable output (exit ${result.code}): ${firstLine(result.stderr)}`,
        fix: 'run the same semgrep command by hand to see what it is complaining about',
      });
      continue;
    }

    for (const finding of parsed.results ?? []) {
      findings.push(toFinding(finding, root));
    }

    for (const error of parsed.errors ?? []) {
      if (!error.message) continue;
      findings.push({
        code: CODES.SEMGREP_UNAVAILABLE,
        severity: 'info',
        check: 'semgrep',
        message: `semgrep reported a problem: ${firstLine(error.message)}`,
      });
    }
  }

  return findings;
}

function toFinding(result: SemgrepResult, root: string): Finding {
  const severity = mapSeverity(result.extra?.severity);
  const code =
    severity === 'error' ? CODES.SEMGREP_ERROR : severity === 'warning' ? CODES.SEMGREP_WARNING : CODES.SEMGREP_INFO;

  const ruleId = shortRuleId(result.check_id ?? 'unknown-rule');
  const message = collapse(result.extra?.message ?? 'no message');

  return {
    code,
    severity,
    check: 'semgrep',
    message: `${ruleId}: ${message}`,
    file: result.path ? relative(result.path, root) : undefined,
    line: result.start?.line,
    column: result.start?.col,
    fix: result.extra?.metadata?.fix,
  };
}

/** `rules.aigate-eval-on-input` and long registry ids both read better trimmed. */
function shortRuleId(checkId: string): string {
  const parts = checkId.split('.');
  return parts[parts.length - 1] ?? checkId;
}

function mapSeverity(severity: string | undefined): Severity {
  switch ((severity ?? '').toUpperCase()) {
    case 'ERROR':
    case 'HIGH':
    case 'CRITICAL':
      return 'error';
    case 'WARNING':
    case 'MEDIUM':
      return 'warning';
    default:
      return 'info';
  }
}

/**
 * Local rule files are resolved against the policy root; anything else (`p/secrets`,
 * `r/javascript`, a URL) is passed through to semgrep untouched.
 */
export function resolveConfigs(configs: readonly string[], root: string): string[] {
  const out: string[] = [];
  for (const config of configs) {
    if (config.startsWith('p/') || config.startsWith('r/') || /^https?:/.test(config) || config === 'auto') {
      out.push(config);
      continue;
    }
    const resolved = resolveFromRoot(root, config);
    if (existsSync(resolved)) out.push(resolved);
  }
  return out;
}

function relative(file: string, root: string): string {
  const normalizedRoot = normalizePath(resolve(root)) + '/';
  const normalizedFile = normalizePath(resolve(root, file));
  return normalizedFile.startsWith(normalizedRoot) ? normalizedFile.slice(normalizedRoot.length) : normalizedFile;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function firstLine(text: string): string {
  return collapse(text.split('\n').find((line) => line.trim() !== '') ?? '');
}
