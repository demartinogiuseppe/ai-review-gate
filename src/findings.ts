/**
 * The finding model every check produces.
 *
 * Findings are the contract between aigate and the coding agent that triggered it:
 * each one renders as `CODE: message`, which is a shape an LLM can parse out of a
 * failed hook and act on without any further prompting.
 */

export type Severity = 'error' | 'warning' | 'info';

export type CheckName = 'registry' | 'semgrep' | 'llm' | 'policy';

export interface Finding {
  /** Stable machine code, e.g. `REGISTRY_MISSING_PACKAGE`. Policy blocks on these. */
  code: string;
  message: string;
  severity: Severity;
  check: CheckName;
  file?: string;
  line?: number;
  column?: number;
  /** One-line instruction aimed at the agent, e.g. "remove the import or install a real package". */
  fix?: string;
}

export const CODES = {
  /** A bare import resolves to a package that does not exist on the registry. */
  REGISTRY_MISSING_PACKAGE: 'REGISTRY_MISSING_PACKAGE',
  /** The package exists on the registry but is absent from package.json. */
  REGISTRY_UNDECLARED_PACKAGE: 'REGISTRY_UNDECLARED_PACKAGE',
  /** Existence could not be confirmed (offline, timeout, registry 5xx). Never blocks by default. */
  REGISTRY_UNVERIFIED: 'REGISTRY_UNVERIFIED',
  SEMGREP_ERROR: 'SEMGREP_ERROR',
  SEMGREP_WARNING: 'SEMGREP_WARNING',
  SEMGREP_INFO: 'SEMGREP_INFO',
  /** semgrep is not installed or failed to run. Informational; the gate degrades gracefully. */
  SEMGREP_UNAVAILABLE: 'SEMGREP_UNAVAILABLE',
  /** A change touches a path the policy marks critical. */
  CRITICAL_PATH_TOUCHED: 'CRITICAL_PATH_TOUCHED',
  LLM_ISSUE: 'LLM_ISSUE',
  LLM_UNAVAILABLE: 'LLM_UNAVAILABLE',
} as const;

export function formatFinding(finding: Finding): string {
  const where = finding.file
    ? `${finding.file}${finding.line ? `:${finding.line}` : ''}${finding.line && finding.column ? `:${finding.column}` : ''}`
    : '';
  const location = where ? ` [${where}]` : '';
  return `${finding.code}: ${finding.message}${location}`;
}

export function severityRank(severity: Severity): number {
  return severity === 'error' ? 0 : severity === 'warning' ? 1 : 2;
}

/** Errors first, then by file, then by line — stable output makes diffing runs easy. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      (a.file ?? '').localeCompare(b.file ?? '') ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.code.localeCompare(b.code),
  );
}
