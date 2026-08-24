#!/usr/bin/env node
/**
 * Test runner shim.
 *
 * `node --test` disagrees with itself across versions: Node 20 accepts a directory
 * argument but not a glob, Node 22+ expands globs but rejects the directory. An
 * explicit list of file paths is the one form every supported version accepts, so
 * this walks the compiled test directory and hands over the list.
 *
 * Usage: node scripts/run-tests.mjs [dir=dist/test]
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.argv[2] ?? 'dist/test';

/** Hand-rolled walk: readdirSync's `recursive` option only exists from Node 20.1. */
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else if (entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

let files;
try {
  files = collect(root).sort();
} catch (error) {
  console.error(`run-tests: cannot read ${root} (${error.message}) — run "npm run build" first`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`run-tests: no *.test.js found under ${root} — run "npm run build" first`);
  process.exit(1);
}

console.log(`run-tests: ${files.length} test file(s) in ${root}`);
for (const file of files) console.log(`  ${relative(root, file)}`);

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
