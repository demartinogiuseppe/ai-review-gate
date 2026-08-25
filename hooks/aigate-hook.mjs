#!/usr/bin/env node
/**
 * Claude Code hook adapter for aigate.
 *
 * Wire it as a **PostToolUse** hook on Write|Edit|MultiEdit|NotebookEdit and on
 * Bash|PowerShell. PostToolUse is the correct event even though the brief calls this
 * a pre-write gate: PreToolUse fires before the write lands, so the file on disk still
 * holds the *old* content and the check would pass on exactly the change you wanted to
 * catch. PostToolUse runs against what was actually written, and exit code 2 hands the
 * findings straight back to the agent, which then fixes them in the same turn.
 *
 * Two ways in, because agents change files two ways:
 *
 *   1. A path in the tool input: Write, Edit, MultiEdit, NotebookEdit.
 *   2. A shell command that wrote to disk: Bash and PowerShell, via heredoc, redirect,
 *      `sed -i`, or a script. That payload carries no path, so the hook asks git what
 *      the worktree looks like now and checks the source files that just changed.
 *      Without this the session loop has a hole an entire refactor fits through.
 *
 * Input: Claude Code hook JSON on stdin, or plain file paths as arguments.
 * Exit:  0 allow, 2 block (stderr goes to the agent).
 *
 * A gate that breaks the session is a gate that gets removed, so an aigate tool
 * error (exit 2) is reported and allowed through unless AIGATE_HOOK_STRICT=1.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const ALLOW = 0;
const BLOCK = 2;

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Pulls the touched paths out of a Claude Code hook payload. */
function pathsFromHookPayload(text) {
  if (text.trim() === '') return [];

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    // Not JSON: treat it as a newline-separated path list, which is what a plain
    // `echo path | hook` gives you.
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }

  const input = payload.tool_input ?? payload.toolInput ?? {};
  const candidates = [input.file_path, input.filePath, input.notebook_path, input.path];

  // MultiEdit and some tool shapes carry a list of edits, each with its own path.
  for (const edit of input.edits ?? []) candidates.push(edit?.file_path, edit?.filePath);
  for (const file of input.files ?? []) candidates.push(typeof file === 'string' ? file : file?.file_path);

  return [...new Set(candidates.filter((value) => typeof value === 'string' && value !== ''))];
}

/** Parses the hook payload once, for the callers that need more than paths. */
function parsePayload(text) {
  try {
    const value = JSON.parse(text);
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}

/** The command a shell-shaped tool ran (Bash, PowerShell), or null if this is not one. */
function commandFromPayload(payload) {
  const input = payload?.tool_input ?? payload?.toolInput ?? {};
  const command = input.command ?? input.script;
  return typeof command === 'string' && command.trim() !== '' ? command : null;
}

/** Extensions the gate has anything to say about. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * How recently a file must have changed to still count as "this command did it".
 * Without a window, one `sed -i` would drag every file you left dirty this morning into
 * the check and block on findings the agent did not just introduce.
 */
const CHANGED_WINDOW_MS = Number(process.env.AIGATE_COMMAND_WINDOW_MS ?? 300_000);

/** A codemod can touch a lot of files; a hook that checks 400 of them is not a hook. */
const MAX_CHANGED_FILES = 40;

/**
 * Shell commands that can put bytes on disk. The list errs towards running the gate: a
 * false positive costs two git calls and then exits 0, while a false negative is the
 * bypass this path exists to close. `2>/dev/null` and `2>&1` are excluded, or every
 * read command in the world would look like a write.
 */
const WRITE_LIKE = [
  />{1,2}\s*(?!\/dev\/null|&\d)\S/,
  /<<-?\s*['"]?[A-Za-z_]/,
  /\b(?:sed|perl|awk)\b[^|]*\s-i\b/,
  /\btee\b/,
  /\b(?:cp|mv|install|rsync|patch|dd|truncate|touch|ln|mkdir)\b/,
  /\b(?:python|python3|node|npx|deno|bun|ruby|php|pwsh|powershell|make|cargo|go)\b/,
  /\b(?:npm|yarn|pnpm)\b/,
  /\bgit\b\s+(?:apply|checkout|restore|revert|merge|rebase|stash|cherry-pick|reset|pull|clean)\b/,
  /--(?:write|fix|in-place)\b/,
  /\b(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item)\b/i,
];

function looksLikeWrite(command) {
  return WRITE_LIKE.some((pattern) => pattern.test(command));
}

function git(args, cwd) {
  const result = spawnSync('git', args, { encoding: 'utf8', cwd, windowsHide: true });
  if (result.error || result.status !== 0) return null;
  return result.stdout ?? '';
}

/**
 * Source files the worktree is carrying right now, most recently touched first.
 *
 * `git status --porcelain` rather than `git diff --name-only`, because a heredoc
 * usually produces a brand-new *untracked* file and `git diff` cannot see those.
 * Porcelain paths are repo-root relative, so they resolve against the top level rather
 * than whichever directory the command happened to run in.
 *
 * Not a git repo, or git missing: return nothing and allow. Design rule 6.
 */
function changedSourceFiles(cwd, now) {
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  if (top === null || top.trim() === '') return [];
  const root = top.trim();

  const status = git(['status', '--porcelain', '-z', '--untracked-files=all'], cwd);
  if (status === null) return [];

  const found = [];
  for (const record of status.split('\0')) {
    if (record === '') continue;
    // "XY path". A rename's origin path arrives as its own bare record and simply fails
    // the existsSync check below, so it needs no special case.
    const relativePath = /^[ MADRCU?!]{2} /.test(record) ? record.slice(3) : record;
    const absolute = resolve(root, relativePath);

    if (!SOURCE_EXTENSIONS.has(extname(absolute).toLowerCase())) continue;
    if (!existsSync(absolute)) continue;

    let mtimeMs;
    try {
      mtimeMs = statSync(absolute).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs > CHANGED_WINDOW_MS) continue;

    found.push({ absolute, mtimeMs });
  }

  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_CHANGED_FILES)
    .map((entry) => entry.absolute);
}

/**
 * Finds the aigate entry point: explicit env, the package this hook ships in, then PATH.
 * Returns `{ error }` rather than a command that would exit 1 for the wrong reason —
 * node failing to load a missing script is indistinguishable from a policy block.
 */
function resolveCli() {
  const fromEnv = process.env.AIGATE_BIN;
  if (fromEnv) {
    if (!existsSync(fromEnv)) return { error: `AIGATE_BIN points at a file that does not exist: ${fromEnv}` };
    return { command: process.execPath, args: [fromEnv] };
  }

  for (const candidate of [join(HERE, '..', 'dist', 'src', 'cli.js'), join(HERE, '..', '..', 'dist', 'src', 'cli.js')]) {
    if (existsSync(candidate)) return { command: process.execPath, args: [resolve(candidate)] };
  }

  const local = join(process.cwd(), 'node_modules', 'ai-review-gate', 'dist', 'src', 'cli.js');
  if (existsSync(local)) return { command: process.execPath, args: [local] };

  return { command: process.platform === 'win32' ? 'aigate.cmd' : 'aigate', args: [] };
}

/** Tail line appended to a block, so the agent knows what state it is in. */
const AFTER_WRITE = 'The write was kept but the gate is blocking. Fix the findings above, then continue.';
const AFTER_COMMAND =
  'The command already ran. The files it changed are blocking. Fix the findings above, then continue.';

/** Runs the gate over a file set and turns its exit code into a hook exit code. */
function checkFiles(files, tail) {
  const cli = resolveCli();
  if (cli.error) {
    process.stderr.write(`aigate hook: ${cli.error}\n`);
    return process.env.AIGATE_HOOK_STRICT === '1' ? BLOCK : ALLOW;
  }

  const { command, args } = cli;
  const result = spawnSync(command, [...args, 'check', '--files', ...files, '--no-color'], {
    encoding: 'utf8',
    cwd: process.cwd(),
    windowsHide: true,
  });

  if (result.error) {
    process.stderr.write(`aigate hook: could not run the gate (${result.error.message})\n`);
    return process.env.AIGATE_HOOK_STRICT === '1' ? BLOCK : ALLOW;
  }

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();

  if (result.status === 1) {
    // Exit 2 is what Claude Code reads as "blocked"; stderr becomes the agent's feedback.
    process.stderr.write(`${output}\n\n${tail}\n`);
    return BLOCK;
  }

  if (result.status !== 0) {
    process.stderr.write(`aigate hook: the gate itself failed (exit ${result.status})\n${output}\n`);
    return process.env.AIGATE_HOOK_STRICT === '1' ? BLOCK : ALLOW;
  }

  // Quiet on success: an in-session gate that chatters gets muted.
  if (process.env.AIGATE_HOOK_VERBOSE === '1' && output !== '') process.stderr.write(`${output}\n`);
  return ALLOW;
}

function main() {
  const argPaths = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  if (argPaths.length > 0) {
    const existing = argPaths.filter((path) => existsSync(path));
    return existing.length > 0 ? checkFiles(existing, AFTER_WRITE) : ALLOW;
  }

  const text = readStdin();
  const paths = pathsFromHookPayload(text);

  if (paths.length > 0) {
    const existing = paths.filter((path) => existsSync(path));
    return existing.length > 0 ? checkFiles(existing, AFTER_WRITE) : ALLOW;
  }

  // No path in the payload. Either this is not a file tool at all, or it is a shell
  // command that wrote files without ever naming one.
  const command = commandFromPayload(parsePayload(text));
  if (command === null) return ALLOW;
  if (!looksLikeWrite(command) && process.env.AIGATE_HOOK_ALL_COMMANDS !== '1') return ALLOW;

  const changed = changedSourceFiles(process.cwd(), Date.now());
  if (changed.length === 0) return ALLOW;

  return checkFiles(changed, AFTER_COMMAND);
}

process.exitCode = main();
