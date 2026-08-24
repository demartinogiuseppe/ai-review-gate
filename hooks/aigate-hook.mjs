#!/usr/bin/env node
/**
 * Claude Code hook adapter for aigate.
 *
 * Wire it as a **PostToolUse** hook on Write|Edit|MultiEdit. PostToolUse is the
 * correct event even though the brief calls this a pre-write gate: PreToolUse fires
 * before the write lands, so the file on disk still holds the *old* content and the
 * check would pass on exactly the change you wanted to catch. PostToolUse runs
 * against what was actually written, and exit code 2 hands the findings straight
 * back to the agent, which then fixes them in the same turn.
 *
 * Input: Claude Code hook JSON on stdin, or plain file paths as arguments.
 * Exit:  0 allow, 2 block (stderr goes to the agent).
 *
 * A gate that breaks the session is a gate that gets removed, so an aigate tool
 * error (exit 2) is reported and allowed through unless AIGATE_HOOK_STRICT=1.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

function main() {
  const argPaths = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const paths = argPaths.length > 0 ? argPaths : pathsFromHookPayload(readStdin());

  if (paths.length === 0) return ALLOW;

  const existing = paths.filter((path) => existsSync(path));
  if (existing.length === 0) return ALLOW;

  const cli = resolveCli();
  if (cli.error) {
    process.stderr.write(`aigate hook: ${cli.error}\n`);
    return process.env.AIGATE_HOOK_STRICT === '1' ? BLOCK : ALLOW;
  }

  const { command, args } = cli;
  const result = spawnSync(command, [...args, 'check', '--files', ...existing, '--no-color'], {
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
    process.stderr.write(
      `${output}\n\nThe write was kept but the gate is blocking. Fix the findings above, then continue.\n`,
    );
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

process.exitCode = main();
