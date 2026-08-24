/**
 * Registry check — the reason this gate exists.
 *
 * Coding agents hallucinate package names. The resulting import looks completely
 * ordinary in review, type-checks against `any`, and only fails at install time
 * (or, worse, gets squatted by someone watching npm 404 logs). Every bare
 * specifier a change introduces is therefore resolved against the real registry.
 *
 * Resolution goes cheapest-first and stops at the first definitive answer:
 * allowlist, node builtin, installed in node_modules, on-disk cache, network.
 * A network failure never invents a blocker — it downgrades to
 * REGISTRY_UNVERIFIED so a flaky connection cannot fail an honest PR.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { CODES, type Finding } from '../findings.js';
import type { RegistryPolicy } from '../policy.js';
import { normalizePath } from '../glob.js';
import { extractImports, isNodeBuiltin, isSupportedSource, isValidPackageName, type ImportRef } from './imports.js';

export type Existence = 'exists' | 'missing' | 'unknown';

export interface RegistryCheckOptions {
  /** Absolute paths of files to inspect. Missing files (deleted in a diff) are skipped. */
  files: readonly string[];
  policy: RegistryPolicy;
  root: string;
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Set to null to disable the on-disk cache. */
  cacheDir?: string | null;
}

interface CacheEntry {
  exists: boolean;
  checkedAt: number;
}

/** A package that disappeared would be re-checked after this long; a hallucinated one never appears. */
const NEGATIVE_TTL_MS = 60 * 60 * 1000;
const MAX_CONCURRENT_LOOKUPS = 8;

export async function checkRegistry(options: RegistryCheckOptions): Promise<Finding[]> {
  const { policy, root } = options;
  if (!policy.enabled) return [];

  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  // file -> imports, keeping the first place each package is introduced.
  const occurrences = new Map<string, { ref: ImportRef; file: string }>();
  for (const file of options.files) {
    if (!isSupportedSource(file) || !existsSync(file)) continue;

    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    for (const ref of extractImports(source)) {
      if (isNodeBuiltin(ref.specifier)) continue;
      if (policy.allowlist.includes(ref.packageName)) continue;
      if (occurrences.has(ref.packageName)) continue;
      occurrences.set(ref.packageName, { ref, file });
    }
  }

  if (occurrences.size === 0) return [];

  const cache = new RegistryCache(
    options.cacheDir === null ? null : (options.cacheDir ?? defaultCacheDir(root)),
    now,
    policy.cacheTtlHours * 60 * 60 * 1000,
  );
  const findings: Finding[] = [];
  const needNetwork: string[] = [];

  for (const [name, { ref, file }] of occurrences) {
    if (!isValidPackageName(name)) {
      findings.push(missingFinding(name, ref, file, root, 'not a valid npm package name'));
      continue;
    }
    if (isInstalled(name, file, root)) continue;

    const cached = cache.get(name);
    if (cached === 'exists') {
      findings.push(...undeclaredFindings(name, ref, file, root));
      continue;
    }
    if (cached === 'missing') {
      findings.push(missingFinding(name, ref, file, root, 'not found on the registry (cached)'));
      continue;
    }
    needNetwork.push(name);
  }

  const results = await resolveMany(needNetwork, policy, fetchImpl);

  for (const name of needNetwork) {
    const entry = occurrences.get(name)!;
    const existence = results.get(name) ?? 'unknown';

    if (existence === 'missing') {
      cache.set(name, false);
      findings.push(missingFinding(name, entry.ref, entry.file, root, 'not found on the registry'));
      continue;
    }
    if (existence === 'exists') {
      cache.set(name, true);
      findings.push(...undeclaredFindings(name, entry.ref, entry.file, root));
      continue;
    }

    findings.push({
      code: CODES.REGISTRY_UNVERIFIED,
      // Not a blocker by default: an offline laptop must not look like a bad diff.
      severity: policy.allowOffline ? 'warning' : 'error',
      check: 'registry',
      message: `could not verify "${name}" against ${policy.registryUrl}`,
      file: relative(entry.file, root),
      line: entry.ref.line,
      fix: 'check network access to the registry, or add the package to registry.allowlist in policy.yml',
    });
  }

  cache.flush();
  return findings;
}

function missingFinding(name: string, ref: ImportRef, file: string, root: string, reason: string): Finding {
  return {
    code: CODES.REGISTRY_MISSING_PACKAGE,
    severity: 'error',
    check: 'registry',
    message: `"${name}" does not exist (${reason}); imported as "${ref.specifier}"`,
    file: relative(file, root),
    line: ref.line,
    fix: `remove the ${ref.kind} of "${ref.specifier}" or replace it with a package that actually exists`,
  };
}

function undeclaredFindings(name: string, ref: ImportRef, file: string, root: string): Finding[] {
  if (isDeclared(name, file, root)) return [];
  return [
    {
      code: CODES.REGISTRY_UNDECLARED_PACKAGE,
      severity: 'warning',
      check: 'registry',
      message: `"${name}" exists on the registry but is not in package.json`,
      file: relative(file, root),
      line: ref.line,
      fix: `run "npm install ${name}" so the dependency is declared, not just transitively available`,
    },
  ];
}

/** Runs lookups with a small concurrency cap so a wide diff does not open 200 sockets. */
async function resolveMany(
  names: readonly string[],
  policy: RegistryPolicy,
  fetchImpl: typeof fetch,
): Promise<Map<string, Existence>> {
  const results = new Map<string, Existence>();
  const queue = [...names];

  const workers = Array.from({ length: Math.min(MAX_CONCURRENT_LOOKUPS, queue.length) }, async () => {
    for (;;) {
      const name = queue.shift();
      if (name === undefined) return;
      results.set(name, await resolveOne(name, policy, fetchImpl));
    }
  });

  await Promise.all(workers);
  return results;
}

export async function resolveOne(name: string, policy: RegistryPolicy, fetchImpl: typeof fetch): Promise<Existence> {
  const url = `${policy.registryUrl.replace(/\/+$/, '')}/${encodePackageName(name)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), policy.timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      // The abbreviated document is a fraction of the size of full packument.
      headers: { accept: 'application/vnd.npm.install-v1+json', 'user-agent': 'ai-review-gate' },
    });

    if (response.status === 404) return 'missing';
    if (response.ok) return 'exists';
    // 401/403 from a private registry means "exists but not yours to read" — not a hallucination.
    if (response.status === 401 || response.status === 403) return 'exists';
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

function encodePackageName(name: string): string {
  return name.startsWith('@') ? name.replace('/', '%2f') : name;
}

/** Walks up from the importing file looking for the package in node_modules. */
function isInstalled(name: string, fromFile: string, root: string): boolean {
  for (const dir of ancestors(dirname(fromFile), root)) {
    if (existsSync(join(dir, 'node_modules', ...name.split('/'), 'package.json'))) return true;
  }
  return false;
}

/** Whether the nearest package.json lists the package in any dependency field. */
function isDeclared(name: string, fromFile: string, root: string): boolean {
  for (const dir of ancestors(dirname(fromFile), root)) {
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;

    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return true; // Unreadable manifest is a different problem; do not report it as undeclared.
    }

    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = manifest[field];
      if (deps && typeof deps === 'object' && name in (deps as Record<string, unknown>)) return true;
    }
    return false;
  }
  return true; // No manifest at all: nothing to be undeclared against.
}

/** Directories from `start` up to and including `root` (bounded, so it never escapes the repo). */
function* ancestors(start: string, root: string): Generator<string> {
  const stop = resolve(root);
  let dir = resolve(start);
  for (;;) {
    yield dir;
    if (dir === stop) return;
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

function relative(file: string, root: string): string {
  const normalizedRoot = normalizePath(resolve(root)) + '/';
  const normalizedFile = normalizePath(resolve(file));
  return normalizedFile.startsWith(normalizedRoot) ? normalizedFile.slice(normalizedRoot.length) : normalizedFile;
}

export function defaultCacheDir(root: string): string {
  return process.env['AIGATE_CACHE_DIR'] ?? join(root, '.aigate-cache');
}

/**
 * A tiny JSON cache. In-session speed is the whole point: repeat writes to the same
 * file must not re-hit the network for imports that were already resolved.
 */
class RegistryCache {
  private entries: Record<string, CacheEntry> = {};
  private dirty = false;
  private readonly path: string | null;

  constructor(
    dir: string | null,
    private readonly now: () => number,
    private readonly positiveTtlMs: number,
  ) {
    this.path = dir === null ? null : join(dir, 'registry.json');
    if (this.path && existsSync(this.path)) {
      try {
        this.entries = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, CacheEntry>;
      } catch {
        this.entries = {};
      }
    }
  }

  get(name: string): Existence {
    const entry = this.entries[name];
    if (!entry) return 'unknown';
    const age = this.now() - entry.checkedAt;
    const ttl = entry.exists ? this.positiveTtlMs : Math.min(NEGATIVE_TTL_MS, this.positiveTtlMs);
    if (age > ttl) return 'unknown';
    return entry.exists ? 'exists' : 'missing';
  }

  set(name: string, exists: boolean): void {
    this.entries[name] = { exists, checkedAt: this.now() };
    this.dirty = true;
  }

  flush(): void {
    if (!this.dirty || !this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.entries));
    } catch {
      // A cache that cannot be written is a performance problem, never a gate failure.
    }
  }
}
