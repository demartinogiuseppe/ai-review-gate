/**
 * Git access for the CI entry point.
 *
 * `aigate check --diff BASE...HEAD` needs two things from git: which files the PR
 * touched, and (for the optional LLM pass) the diff text itself. Everything else
 * about the repo is deliberately none of the gate's business.
 */

import { resolve } from 'node:path';
import { run, type Runner } from './exec.js';
import { normalizePath } from './glob.js';

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitOptions {
  cwd: string;
  runner?: Runner;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Files added, copied, modified or renamed by the range. Deletions are excluded:
 * there is nothing left to check, and a deleted file would only produce noise.
 */
export async function changedFiles(range: string, options: GitOptions): Promise<string[]> {
  const args = ['diff', '--name-only', '--diff-filter=ACMR', ...rangeArgs(range)];
  const result = await execGit(args, options);

  return result
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((file) => resolve(options.cwd, file));
}

/** Unified diff text for the range, used only by the optional LLM review. */
export async function diffText(range: string, options: GitOptions): Promise<string> {
  return execGit(['diff', '--unified=3', '--no-color', ...rangeArgs(range)], options);
}

/**
 * Accepts `BASE...HEAD`, `BASE..HEAD` or a bare ref.
 *
 * `...` (merge-base) is what a PR check wants: changes the branch introduced, not
 * changes that happened on main since it forked. It is preserved as written so a
 * caller asking for `..` still gets `..`.
 */
export function rangeArgs(range: string): string[] {
  const trimmed = range.trim();
  if (trimmed === '') throw new GitError('empty diff range');
  if (trimmed.startsWith('-')) throw new GitError(`invalid diff range: ${trimmed}`);
  return [trimmed];
}

async function execGit(args: readonly string[], options: GitOptions): Promise<string> {
  const runner: Runner = options.runner ?? run;
  const result = await runner('git', args, { cwd: options.cwd, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });

  if (result.notFound) throw new GitError('git is not installed or not on PATH');
  if (result.timedOut) throw new GitError(`git ${args[0]} timed out`);
  if (result.code !== 0) {
    throw new GitError(`git ${args.join(' ')} failed (exit ${result.code}): ${firstLine(result.stderr)}`);
  }
  return result.stdout;
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim();
}

/** Repo-relative, forward-slashed path for display and glob matching. */
export function toRepoRelative(file: string, root: string): string {
  const normalizedRoot = normalizePath(resolve(root)) + '/';
  const normalizedFile = normalizePath(resolve(file));
  return normalizedFile.startsWith(normalizedRoot) ? normalizedFile.slice(normalizedRoot.length) : normalizedFile;
}
