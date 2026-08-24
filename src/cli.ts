#!/usr/bin/env node
/**
 * aigate — one gate, two entry points.
 *
 *   aigate check --files a.ts b.ts     fast, in-session (Claude Code hook)
 *   aigate check --diff main...HEAD    the same policy, on a PR
 *   aigate print-policy                what is actually in effect, and from where
 *   aigate review --diff main...HEAD   optional LLM pass, CI only
 *
 * Exit codes are the contract: 0 pass, 1 blocked by policy, 2 the gate itself broke.
 * A tool error must never look like a clean run, and must never look like a block —
 * a broken gate that fails PRs gets deleted within a week.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadPolicy, PolicyError, type Policy } from './policy.js';
import { runGate } from './gate.js';
import { changedFiles, diffText, GitError } from './git.js';
import { exitCodeFor, formatReport, type Format } from './report.js';
import { reviewWithLlm, llmConfigFromEnv } from './llm/review.js';
import { sortFindings } from './findings.js';

export const EXIT_PASS = 0;
export const EXIT_BLOCK = 1;
export const EXIT_TOOL_ERROR = 2;

/**
 * Output sink. Injectable so tests can assert on what the CLI prints without
 * monkeypatching process.stdout, which corrupts any test reporter sharing it.
 */
export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const processIo: Io = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

const USAGE = `aigate — quality gate for AI-generated code

Usage:
  aigate check --files <path...>        check specific files (fast; for editor/agent hooks)
  aigate check --diff <range>           check everything a diff touches (for CI)
  aigate print-policy                   print the resolved policy and where it came from
  aigate review --diff <range>          optional LLM review pass (CI only, off by default)

Options:
  --files <path...>     files to check; "-" reads newline-separated paths from stdin
  --diff <range>        git range, e.g. origin/main...HEAD
  --policy <path>       policy file to use (default: nearest policy.yml)
  --format <fmt>        human | json | markdown (default: human)
  --json                shorthand for --format json
  --output <path>       also write the report to a file
  --no-registry         skip the registry check
  --no-semgrep          skip the semgrep check
  --no-color            disable ANSI colour
  --cwd <path>          run as if from this directory
  -h, --help            show this help
  -v, --version         show the version

Exit codes: 0 pass, 1 blocked by policy, 2 tool error.`;

interface Args {
  command: string;
  files: string[];
  diff?: string;
  policy?: string;
  format: Format;
  output?: string;
  noRegistry: boolean;
  noSemgrep: boolean;
  color: boolean;
  cwd: string;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    command: '',
    files: [],
    format: 'human',
    noRegistry: false,
    noSemgrep: false,
    color: process.stdout.isTTY === true && !process.env['NO_COLOR'],
    cwd: process.cwd(),
    help: false,
    version: false,
  };

  let i = 0;
  // A leading non-flag token is the command.
  if (argv[0] !== undefined && !argv[0].startsWith('-')) {
    args.command = argv[0];
    i = 1;
  }

  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--files':
        // Consume until the next flag, so `--files a.ts b.ts` works.
        while (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) args.files.push(argv[++i]!);
        break;
      case '--diff':
        args.diff = expectValue(argv, ++i, '--diff');
        break;
      case '--policy':
        args.policy = expectValue(argv, ++i, '--policy');
        break;
      case '--format':
        args.format = parseFormat(expectValue(argv, ++i, '--format'));
        break;
      case '--json':
        args.format = 'json';
        break;
      case '--output':
        args.output = expectValue(argv, ++i, '--output');
        break;
      case '--cwd':
        args.cwd = resolve(expectValue(argv, ++i, '--cwd'));
        break;
      case '--no-registry':
        args.noRegistry = true;
        break;
      case '--no-semgrep':
        args.noSemgrep = true;
        break;
      case '--no-color':
        args.color = false;
        break;
      case '--color':
        args.color = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '-v':
      case '--version':
        args.version = true;
        break;
      default:
        if (arg.startsWith('-')) throw new UsageError(`unknown option: ${arg}`);
        args.files.push(arg);
    }
  }

  return args;
}

class UsageError extends Error {}

function expectValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
  return value;
}

function parseFormat(value: string): Format {
  if (value === 'human' || value === 'json' || value === 'markdown') return value;
  throw new UsageError(`unknown format: ${value} (expected human, json or markdown)`);
}

export async function main(argv: readonly string[], io: Io = processIo): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.err(`aigate: ${(error as Error).message}\n\n${USAGE}\n`);
    return EXIT_TOOL_ERROR;
  }

  if (args.version) {
    io.out(`${readVersion()}\n`);
    return EXIT_PASS;
  }
  if (args.help || args.command === 'help') {
    io.out(`${USAGE}\n`);
    return EXIT_PASS;
  }
  if (args.command === '') {
    // No command at all is a usage mistake, not a passing run.
    io.err(`${USAGE}\n`);
    return EXIT_TOOL_ERROR;
  }

  try {
    switch (args.command) {
      case 'check':
        return await commandCheck(args, io);
      case 'print-policy':
        return commandPrintPolicy(args, io);
      case 'review':
        return await commandReview(args, io);
      default:
        io.err(`aigate: unknown command "${args.command}"\n\n${USAGE}\n`);
        return EXIT_TOOL_ERROR;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`aigate: ${error.message}\n\n${USAGE}\n`);
      return EXIT_TOOL_ERROR;
    }
    if (error instanceof PolicyError || error instanceof GitError) {
      io.err(`aigate: ${error.message}\n`);
      return EXIT_TOOL_ERROR;
    }
    io.err(`aigate: unexpected failure: ${(error as Error).stack ?? String(error)}\n`);
    return EXIT_TOOL_ERROR;
  }
}

async function commandCheck(args: Args, io: Io): Promise<number> {
  const { policy, source, root, warnings } = loadPolicy({ policyPath: args.policy, cwd: args.cwd });
  const { files, scope } = await resolveTargets(args, root);

  if (files.length === 0) {
    // Nothing to check is a pass, not an error: most writes touch files we ignore.
    if (args.format === 'human') io.out('aigate: PASS — no files to check\n');
    else if (args.format === 'json') io.out(`${JSON.stringify({ version: 1, decision: 'pass', exitCode: 0, scope, findings: [] }, null, 2)}\n`);
    return EXIT_PASS;
  }

  const result = await runGate({
    files,
    policy,
    root,
    skipRegistry: args.noRegistry,
    skipSemgrep: args.noSemgrep,
  });

  emit(formatReport({ result, policy, policySource: source, scope, warnings, color: args.color }, args.format), args, io);
  return exitCodeFor(result);
}

async function commandReview(args: Args, io: Io): Promise<number> {
  const { policy, source, root, warnings } = loadPolicy({ policyPath: args.policy, cwd: args.cwd });
  if (!args.diff) throw new UsageError('review needs --diff <range>');

  const config = llmConfigFromEnv(policy.llm);
  const files = await changedFiles(args.diff, { cwd: root });
  const diff = await diffText(args.diff, { cwd: root });

  const findings = await reviewWithLlm({ diff, config, root });
  const sorted = sortFindings(findings);
  const result = {
    findings: sorted,
    blocking: sorted.filter((finding) => policy.blockOn.includes(finding.code)),
    checkedFiles: files.map((file) => file),
    ignoredFiles: [],
    durationMs: 0,
  };

  emit(
    formatReport({ result, policy, policySource: source, scope: args.diff, warnings, color: args.color }, args.format),
    args,
    io,
  );
  return exitCodeFor(result);
}

function commandPrintPolicy(args: Args, io: Io): number {
  const { policy, source, root, warnings } = loadPolicy({ policyPath: args.policy, cwd: args.cwd });
  const payload = { source: source ?? '(built-in defaults)', root, warnings, policy };

  if (args.format === 'json') {
    emit(JSON.stringify(payload, null, 2), args, io);
  } else {
    emit(describePolicy(policy, source, root, warnings), args, io);
  }
  return EXIT_PASS;
}

function describePolicy(policy: Policy, source: string | null, root: string, warnings: readonly string[]): string {
  const lines = [
    `source: ${source ?? '(built-in defaults)'}`,
    `root:   ${root}`,
    '',
    `block_on:               ${policy.blockOn.join(', ') || '(none)'}`,
    `critical_paths:         ${policy.criticalPaths.join(', ') || '(none)'}`,
    `critical_path_block_on: ${policy.criticalPathBlockOn.join(', ') || '(none)'}`,
    `ignore_paths:           ${policy.ignorePaths.join(', ') || '(none)'}`,
    '',
    `registry: enabled=${policy.registry.enabled} timeout=${policy.registry.timeoutMs}ms allow_offline=${policy.registry.allowOffline} url=${policy.registry.registryUrl}`,
    `          allowlist=${policy.registry.allowlist.join(', ') || '(none)'}`,
    `semgrep:  enabled=${policy.semgrep.enabled} timeout=${policy.semgrep.timeoutMs}ms config=${policy.semgrep.config.join(', ') || '(none)'}`,
    `llm:      enabled=${policy.llm.enabled} model=${policy.llm.model} url=${policy.llm.url || '(unset)'}`,
  ];
  for (const warning of warnings) lines.push(`warning: ${warning}`);
  return lines.join('\n');
}

/** Turns `--files` / `--diff` into an absolute file list plus a label for the report. */
async function resolveTargets(args: Args, root: string): Promise<{ files: string[]; scope: string }> {
  if (args.diff && args.files.length > 0) throw new UsageError('use either --files or --diff, not both');

  if (args.diff) {
    return { files: await changedFiles(args.diff, { cwd: root }), scope: args.diff };
  }

  const raw = args.files.includes('-') ? [...args.files.filter((f) => f !== '-'), ...readStdinPaths()] : args.files;
  if (raw.length === 0) throw new UsageError('check needs --files <path...> or --diff <range>');

  return { files: raw.map((file) => resolve(args.cwd, file)), scope: `${raw.length} file(s)` };
}

function readStdinPaths(): string[] {
  try {
    return readFileSync(0, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  } catch {
    return [];
  }
}

function emit(text: string, args: Args, io: Io): void {
  io.out(`${text}\n`);
  if (!args.output) return;
  const target = resolve(args.cwd, args.output);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${text}\n`);
}

function readVersion(): string {
  try {
    const manifestUrl = new URL('../../package.json', import.meta.url);
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as { version?: string };
    return manifest.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun || process.env['AIGATE_FORCE_CLI'] === '1') {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`aigate: ${(error as Error).stack ?? String(error)}\n`);
      process.exitCode = EXIT_TOOL_ERROR;
    },
  );
}
