import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** dist/test -> repo root */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(ROOT, 'hooks', 'aigate-hook.mjs');

/** 404s anything containing "ghost", 200 for everything else. */
async function startRegistry(): Promise<{ port: number; close: () => void }> {
  const server: Server = createServer((request, response) => {
    response.writeHead(request.url?.includes('ghost') ? 404 : 200).end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { port: (server.address() as AddressInfo).port, close: () => server.close() };
}

function sandbox(port: number): string {
  const root = mkdtempSync(join(tmpdir(), 'aigate-hook-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0' } }));
  writeFileSync(
    join(root, 'policy.yml'),
    ['registry:', `  registry_url: "http://127.0.0.1:${port}"`, 'semgrep:', '  enabled: false'].join('\n'),
  );
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

/**
 * Runs the hook asynchronously. spawnSync would block this process's event loop,
 * which would stop the in-process registry server from ever answering.
 */
function runHook(root: string, payload: string, env: NodeJS.ProcessEnv = {}): Promise<{ status: number | null; output: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: root,
      env: { ...process.env, AIGATE_BIN: join(ROOT, 'dist', 'src', 'cli.js'), ...env },
    });

    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('close', (status) => done({ status, output }));
    child.stdin.end(payload);
  });
}

test('hook: blocks with exit 2 and feeds the findings back', async () => {
  const registry = await startRegistry();
  try {
    const root = sandbox(registry.port);
    writeFileSync(join(root, 'src', 'bad.ts'), "import ghost from 'ghost-pkg-xyz';\n");

    const { status, output } = await runHook(root, JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/bad.ts' } }));

    assert.equal(status, 2, 'Claude Code reads exit 2 as "blocked"');
    assert.match(output, /REGISTRY_MISSING_PACKAGE/);
    assert.match(output, /Fix the findings above/);
  } finally {
    registry.close();
  }
});

test('hook: stays silent and allows a clean write', async () => {
  const registry = await startRegistry();
  try {
    const root = sandbox(registry.port);
    writeFileSync(join(root, 'src', 'good.ts'), "import express from 'express';\n");

    const { status, output } = await runHook(root, JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'src/good.ts' } }));

    assert.equal(status, 0);
    assert.equal(output.trim(), '', 'a passing gate must not add noise to the session');
  } finally {
    registry.close();
  }
});

test('hook: understands MultiEdit payloads and plain path lists', async () => {
  const registry = await startRegistry();
  try {
    const root = sandbox(registry.port);
    writeFileSync(join(root, 'src', 'a.ts'), "import express from 'express';\n");
    writeFileSync(join(root, 'src', 'b.ts'), "import ghost from 'ghost-pkg-xyz';\n");

    const multiEdit = await runHook(
      root,
      JSON.stringify({ tool_name: 'MultiEdit', tool_input: { edits: [{ file_path: 'src/a.ts' }, { file_path: 'src/b.ts' }] } }),
    );
    assert.equal(multiEdit.status, 2);
    assert.match(multiEdit.output, /ghost-pkg-xyz/);

    const plainPaths = await runHook(root, 'src/b.ts\n');
    assert.equal(plainPaths.status, 2, 'a bare newline-separated path list works too');
  } finally {
    registry.close();
  }
});

test('hook: a payload with no usable path allows the write', async () => {
  const registry = await startRegistry();
  try {
    const root = sandbox(registry.port);
    assert.equal((await runHook(root, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }))).status, 0);
    assert.equal((await runHook(root, '')).status, 0);
    assert.equal((await runHook(root, JSON.stringify({ tool_input: { file_path: 'src/never-written.ts' } }))).status, 0);
  } finally {
    registry.close();
  }
});

test('hook: a broken gate does not brick the session unless strict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aigate-hook-broken-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'x.ts'), 'const a = 1;');
  const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/x.ts' } });
  const missingCli = { AIGATE_BIN: join(root, 'does-not-exist.js') };

  const lenient = await runHook(root, payload, missingCli);
  assert.equal(lenient.status, 0, 'a gate that cannot run must not block the agent');
  assert.match(lenient.output, /does not exist/);

  const strict = await runHook(root, payload, { ...missingCli, AIGATE_HOOK_STRICT: '1' });
  assert.equal(strict.status, 2, 'AIGATE_HOOK_STRICT=1 opts into failing closed');
});

/**
 * Makes the sandbox a git repo. Returns false if git is unavailable, so the
 * Bash-coverage tests skip instead of failing for the wrong reason.
 */
function gitInit(root: string): boolean {
  const init = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
  if (init.error || init.status !== 0) return false;
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: root });
  return true;
}

test('hook: gates a Bash-mediated write through changed-file detection', async () => {
  const registry = await startRegistry();
  try {
    const root = sandbox(registry.port);
    if (!gitInit(root)) return; // no git on this machine; nothing to prove here

    // What `cat > src/bad.ts <<'EOF' ... EOF` leaves behind: a new file on disk and a
    // payload that names no path at all.
    writeFileSync(join(root, 'src', 'bad.ts'), "import ghost from 'ghost-pkg-xyz';\n");

    const { status, output } = await runHook(
      root,
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: "cat > src/bad.ts <<'EOF'\nimport ghost from 'ghost-pkg-xyz';\nEOF" },
      }),
    );

    assert.equal(status, 2, 'a write via Bash must reach the agent the same way a Write does');
    assert.match(output, /REGISTRY_MISSING_PACKAGE/);
    assert.match(output, /The command already ran/);
  } finally {
    registry.close();
  }
});

test('hook: a read-only command stays out of the way', async () => {
  const registry = await startRegistry();
  try {
    const root = sandbox(registry.port);
    if (!gitInit(root)) return;

    // The bad file is sitting right there. Listing a directory is still not a write.
    writeFileSync(join(root, 'src', 'bad.ts'), "import ghost from 'ghost-pkg-xyz';\n");

    const { status, output } = await runHook(
      root,
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'grep -rn "TODO" src 2>/dev/null' } }),
    );

    assert.equal(status, 0, 'innocent commands must not pay for the bypass fix');
    assert.equal(output.trim(), '');
  } finally {
    registry.close();
  }
});

test('hook: a Bash write that touches no source file allows', async () => {
  const registry = await startRegistry();
  try {
    const root = sandbox(registry.port);
    if (!gitInit(root)) return;
    writeFileSync(join(root, 'notes.md'), '# not code\n');

    const { status } = await runHook(
      root,
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo "# not code" > notes.md' } }),
    );

    assert.equal(status, 0);
  } finally {
    registry.close();
  }
});
