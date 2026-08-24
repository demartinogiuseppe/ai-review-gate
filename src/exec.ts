/**
 * Thin promise wrapper around child_process.spawn.
 *
 * Two things it buys us over calling spawn directly: a timeout that actually kills
 * the child, and a `notFound` flag so callers can tell "the tool isn't installed"
 * (degrade gracefully) from "the tool ran and failed" (report it).
 *
 * It deliberately never uses `shell: true`. Arguments here are file paths from a
 * diff, and shell quoting on Windows is exactly the kind of hole this project is
 * supposed to catch in other people's code. Instead the executable is resolved
 * against PATH/PATHEXT so `.cmd` shims still work.
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, sep } from 'node:path';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The executable could not be found on PATH. */
  notFound: boolean;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin then closed. */
  input?: string;
  /** Bytes of stdout to keep. Guards against a pathological tool filling memory. */
  maxBuffer?: number;
}

export type Runner = (command: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>;

const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

/** Resolves a bare command name against PATH (and PATHEXT on Windows). */
export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const isPath = command.includes('/') || command.includes(sep) || isAbsolute(command);
  const extensions =
    process.platform === 'win32' ? (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];

  const candidates: string[] = [];
  if (isPath) {
    candidates.push(command, ...extensions.map((extension) => command + extension));
  } else {
    for (const dir of (env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
      candidates.push(join(dir, command));
      for (const extension of extensions) candidates.push(join(dir, command + extension));
    }
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const resolved = findExecutable(command, options.env ?? process.env);
  if (!resolved) {
    return Promise.resolve({ code: null, stdout: '', stderr: `${command}: not found on PATH`, notFound: true, timedOut: false });
  }

  return new Promise((resolvePromise) => {
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const child = spawn(resolved, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let notFound = false;
    let timedOut = false;
    let settled = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, options.timeoutMs)
      : null;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, notFound, timedOut });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBuffer) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBuffer) stderr += chunk.toString('utf8');
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') notFound = true;
      stderr += error.message;
      finish(null);
    });

    child.on('close', (code) => finish(code));

    if (options.input !== undefined) {
      child.stdin?.on('error', () => {
        /* the child may exit before stdin drains; the close handler reports it */
      });
      child.stdin?.end(options.input);
    }
  });
}
