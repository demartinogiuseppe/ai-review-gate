/**
 * Output formatting.
 *
 * Three audiences, one result object:
 *  - human:    a developer reading a terminal (and the agent reading the same text)
 *  - json:     tooling
 *  - markdown: the GitHub job summary and the single PR comment
 *
 * The human format keeps every line machine-parsable (`CODE: message [file:line]`)
 * because the most important reader is often a coding agent recovering from a
 * blocked write.
 */

import { formatFinding, type Finding } from './findings.js';
import type { GateResult } from './gate.js';
import type { Policy } from './policy.js';

export type Format = 'human' | 'json' | 'markdown';

export interface ReportContext {
  result: GateResult;
  policy: Policy;
  policySource: string | null;
  /** What was checked, for the header line: a file list or a diff range. */
  scope: string;
  warnings: readonly string[];
  color: boolean;
}

export function formatReport(context: ReportContext, format: Format): string {
  switch (format) {
    case 'json':
      return formatJson(context);
    case 'markdown':
      return formatMarkdown(context);
    default:
      return formatHuman(context);
  }
}

export function exitCodeFor(result: GateResult): 0 | 1 {
  return result.blocking.length > 0 ? 1 : 0;
}

function formatHuman(context: ReportContext): string {
  const { result, color } = context;
  const paint = makePainter(color);
  const lines: string[] = [];

  for (const warning of context.warnings) lines.push(paint.dim(`aigate: ${warning}`));

  const blocking = new Set(result.blocking);
  const nonBlocking = result.findings.filter((finding) => !blocking.has(finding));

  if (result.blocking.length > 0) {
    lines.push(paint.red(`BLOCKING (${result.blocking.length})`));
    for (const finding of result.blocking) lines.push(...findingLines(finding, paint, '  '));
  }

  if (nonBlocking.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(paint.dim(`notes (${nonBlocking.length}, not blocking)`));
    for (const finding of nonBlocking) lines.push(...findingLines(finding, paint, '  '));
  }

  if (lines.length > 0) lines.push('');
  lines.push(summaryLine(context, paint));
  return lines.join('\n');
}

function findingLines(finding: Finding, paint: Painter, indent: string): string[] {
  const color = finding.severity === 'error' ? paint.red : finding.severity === 'warning' ? paint.yellow : paint.dim;
  const lines = [`${indent}${color(formatFinding(finding))}`];
  if (finding.fix) lines.push(`${indent}  ${paint.dim(`fix: ${finding.fix}`)}`);
  return lines;
}

function summaryLine(context: ReportContext, paint: Painter): string {
  const { result } = context;
  const scope = `${result.checkedFiles.length} file(s)`;
  const timing = `${result.durationMs}ms`;

  if (result.blocking.length > 0) {
    return paint.red(`aigate: BLOCK — ${result.blocking.length} blocking finding(s) in ${scope} (${timing})`);
  }
  const notes = result.findings.length > 0 ? `, ${result.findings.length} note(s)` : '';
  return paint.green(`aigate: PASS — ${scope} clean${notes} (${timing})`);
}

function formatJson(context: ReportContext): string {
  const { result } = context;
  return JSON.stringify(
    {
      version: 1,
      decision: result.blocking.length > 0 ? 'block' : 'pass',
      exitCode: exitCodeFor(result),
      scope: context.scope,
      policySource: context.policySource,
      checkedFiles: result.checkedFiles,
      ignoredFiles: result.ignoredFiles,
      durationMs: result.durationMs,
      counts: {
        total: result.findings.length,
        blocking: result.blocking.length,
        error: result.findings.filter((f) => f.severity === 'error').length,
        warning: result.findings.filter((f) => f.severity === 'warning').length,
        info: result.findings.filter((f) => f.severity === 'info').length,
      },
      findings: result.findings.map((finding) => ({
        ...finding,
        blocking: result.blocking.includes(finding),
      })),
      warnings: context.warnings,
    },
    null,
    2,
  );
}

function formatMarkdown(context: ReportContext): string {
  const { result } = context;
  const lines: string[] = [];
  const verdict = result.blocking.length > 0 ? '❌ **ai-review: BLOCK**' : '✅ **ai-review: PASS**';

  lines.push('<!-- aigate-summary -->');
  lines.push(`### ${verdict}`);
  lines.push('');
  lines.push(`\`${context.scope}\` — ${result.checkedFiles.length} file(s) checked in ${result.durationMs}ms.`);
  lines.push('');

  if (result.findings.length === 0) {
    lines.push('No findings.');
    return lines.join('\n');
  }

  const blocking = new Set(result.blocking);
  if (result.blocking.length > 0) {
    lines.push(`#### Blocking (${result.blocking.length})`);
    lines.push('');
    lines.push('| Code | Location | Message |');
    lines.push('| --- | --- | --- |');
    for (const finding of result.blocking) lines.push(markdownRow(finding));
    lines.push('');
  }

  const notes = result.findings.filter((finding) => !blocking.has(finding));
  if (notes.length > 0) {
    lines.push(`<details><summary>Notes (${notes.length}, not blocking)</summary>`);
    lines.push('');
    lines.push('| Code | Location | Message |');
    lines.push('| --- | --- | --- |');
    for (const finding of notes) lines.push(markdownRow(finding));
    lines.push('');
    lines.push('</details>');
  }

  return lines.join('\n');
}

function markdownRow(finding: Finding): string {
  const location = finding.file ? `\`${finding.file}${finding.line ? `:${finding.line}` : ''}\`` : '—';
  const message = escapePipes(finding.fix ? `${finding.message} — _fix: ${finding.fix}_` : finding.message);
  return `| \`${finding.code}\` | ${location} | ${message} |`;
}

function escapePipes(text: string): string {
  return text.replace(/\|/g, '\\|');
}

interface Painter {
  red: (text: string) => string;
  green: (text: string) => string;
  yellow: (text: string) => string;
  dim: (text: string) => string;
}

function makePainter(color: boolean): Painter {
  if (!color) {
    const plain = (text: string): string => text;
    return { red: plain, green: plain, yellow: plain, dim: plain };
  }
  const wrap = (code: string) => (text: string) => `[${code}m${text}[0m`;
  return { red: wrap('31'), green: wrap('32'), yellow: wrap('33'), dim: wrap('2') };
}
