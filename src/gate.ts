/**
 * The gate itself: run the checks over a file set, then apply the policy.
 *
 * Checks never decide anything. They report findings with a severity; this module
 * is the single place that turns findings into a pass/block decision, which is why
 * the hook and the PR check can never drift apart.
 */

import { existsSync } from 'node:fs';

import { CODES, sortFindings, type Finding } from './findings.js';
import type { Policy } from './policy.js';
import { matchesAny } from './glob.js';
import { toRepoRelative } from './git.js';
import { checkRegistry } from './checks/registry.js';
import { checkSemgrep } from './checks/semgrep.js';
import type { Runner } from './exec.js';

export interface GateOptions {
  /** Absolute paths to check. */
  files: readonly string[];
  policy: Policy;
  root: string;
  /** Turn individual checks off from the command line without editing policy. */
  skipRegistry?: boolean;
  skipSemgrep?: boolean;
  fetchImpl?: typeof fetch;
  runner?: Runner;
  cacheDir?: string | null;
  now?: () => number;
}

export interface GateResult {
  /** Every finding, sorted by severity then location. */
  findings: Finding[];
  /** The subset the policy blocks on. Empty means the gate passes. */
  blocking: Finding[];
  /** Files actually checked, repo-relative, after ignore_paths. */
  checkedFiles: string[];
  /** Files skipped because of ignore_paths. */
  ignoredFiles: string[];
  durationMs: number;
}

export async function runGate(options: GateOptions): Promise<GateResult> {
  const started = (options.now ?? Date.now)();
  const { policy, root } = options;

  const checked: string[] = [];
  const ignored: string[] = [];
  const absoluteFiles: string[] = [];

  for (const file of options.files) {
    const relativePath = toRepoRelative(file, root);
    if (matchesAny(relativePath, policy.ignorePaths)) {
      ignored.push(relativePath);
      continue;
    }
    checked.push(relativePath);
    absoluteFiles.push(file);
  }

  const findings: Finding[] = [];

  // Both checks are independent and one of them is network-bound; overlap them.
  const [registryFindings, semgrepFindings] = await Promise.all([
    options.skipRegistry
      ? Promise.resolve<Finding[]>([])
      : checkRegistry({
          files: absoluteFiles,
          policy: policy.registry,
          root,
          fetchImpl: options.fetchImpl,
          cacheDir: options.cacheDir,
          now: options.now,
        }),
    options.skipSemgrep
      ? Promise.resolve<Finding[]>([])
      : checkSemgrep({ files: absoluteFiles, policy: policy.semgrep, root, runner: options.runner }),
  ]);

  findings.push(...registryFindings, ...semgrepFindings);

  for (const relativePath of checked) {
    if (!matchesAny(relativePath, policy.criticalPaths)) continue;
    findings.push({
      code: CODES.CRITICAL_PATH_TOUCHED,
      severity: 'info',
      check: 'policy',
      message: 'change touches a path the policy marks critical; warnings are escalated here',
      file: relativePath,
    });
  }

  const sorted = sortFindings(findings);
  return {
    findings: sorted,
    blocking: sorted.filter((finding) => isBlocking(finding, policy)),
    checkedFiles: checked,
    ignoredFiles: ignored,
    durationMs: (options.now ?? Date.now)() - started,
  };
}

/**
 * A finding blocks if its code is in `block_on`, or if it sits in a critical path
 * and its code is in `critical_path_block_on`.
 */
export function isBlocking(finding: Finding, policy: Policy): boolean {
  if (policy.blockOn.includes(finding.code)) return true;
  if (!finding.file) return false;
  if (!policy.criticalPathBlockOn.includes(finding.code)) return false;
  return matchesAny(finding.file, policy.criticalPaths);
}

/** Drops paths that no longer exist (deleted in a diff) and de-duplicates. */
export function existingFiles(files: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (existsSync(file)) out.push(file);
  }
  return out;
}
