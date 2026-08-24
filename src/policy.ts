/**
 * One policy file, shared by the in-session hook and by CI.
 *
 * The whole point of the gate is that a rule which blocks a PR also blocks the
 * agent that would have opened it, so both entry points resolve policy through
 * exactly this module.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseYaml, YamlError, type YamlValue } from './yaml.js';
import { CODES } from './findings.js';

export interface RegistryPolicy {
  enabled: boolean;
  timeoutMs: number;
  /** When the registry is unreachable, downgrade to REGISTRY_UNVERIFIED instead of failing the run. */
  allowOffline: boolean;
  /** Package names that are always considered valid (private/internal registries). */
  allowlist: string[];
  registryUrl: string;
  cacheTtlHours: number;
}

export interface SemgrepPolicy {
  enabled: boolean;
  /** Paths or registry ids passed to `semgrep --config`. */
  config: string[];
  timeoutMs: number;
}

export interface LlmPolicy {
  enabled: boolean;
  url: string;
  model: string;
  timeoutMs: number;
  maxDiffBytes: number;
}

export interface Policy {
  version: number;
  blockOn: string[];
  criticalPaths: string[];
  /** Extra codes that block, but only for files matching `criticalPaths`. */
  criticalPathBlockOn: string[];
  ignorePaths: string[];
  registry: RegistryPolicy;
  semgrep: SemgrepPolicy;
  llm: LlmPolicy;
}

export interface LoadedPolicy {
  policy: Policy;
  /** Absolute path the policy was read from, or null when defaults were used. */
  source: string | null;
  /** Root the policy sits in; relative globs and semgrep configs resolve against it. */
  root: string;
  warnings: string[];
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

export const DEFAULT_POLICY: Policy = {
  version: 1,
  blockOn: [CODES.REGISTRY_MISSING_PACKAGE, CODES.SEMGREP_ERROR],
  criticalPaths: ['src/auth/**', 'src/payments/**'],
  criticalPathBlockOn: [CODES.SEMGREP_WARNING],
  ignorePaths: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.min.js'],
  registry: {
    enabled: true,
    timeoutMs: 4000,
    allowOffline: true,
    allowlist: [],
    registryUrl: 'https://registry.npmjs.org',
    cacheTtlHours: 168,
  },
  semgrep: {
    enabled: true,
    config: ['semgrep/rules.yml'],
    timeoutMs: 60_000,
  },
  llm: {
    enabled: false,
    url: '',
    model: 'gpt-4o-mini',
    timeoutMs: 60_000,
    maxDiffBytes: 60_000,
  },
};

const POLICY_FILENAMES = ['policy.yml', 'policy.yaml', '.aigate.yml', '.aigate.yaml'];

/** Walks up from `startDir` looking for a policy file. */
export function findPolicyFile(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    for (const name of POLICY_FILENAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadPolicy(options: { policyPath?: string; cwd?: string } = {}): LoadedPolicy {
  const cwd = options.cwd ?? process.cwd();
  const explicit = options.policyPath ? resolve(cwd, options.policyPath) : null;

  if (explicit && !existsSync(explicit)) {
    throw new PolicyError(`policy file not found: ${explicit}`);
  }

  const source = explicit ?? findPolicyFile(cwd);
  if (!source) {
    return { policy: clonePolicy(DEFAULT_POLICY), source: null, root: cwd, warnings: [] };
  }

  let parsed: YamlValue;
  try {
    parsed = parseYaml(readFileSync(source, 'utf8'));
  } catch (error) {
    const detail = error instanceof YamlError ? error.message : String(error);
    throw new PolicyError(`could not parse ${source}: ${detail}`);
  }

  const warnings: string[] = [];
  const policy = mergePolicy(parsed, source, warnings);
  return { policy, source, root: dirname(source), warnings };
}

function clonePolicy(policy: Policy): Policy {
  return structuredClone(policy);
}

function mergePolicy(raw: YamlValue, source: string, warnings: string[]): Policy {
  if (raw === null) return clonePolicy(DEFAULT_POLICY);
  const root = asMap(raw, 'policy root', source);
  const policy = clonePolicy(DEFAULT_POLICY);

  const known = [
    'version',
    'block_on',
    'critical_paths',
    'critical_path_block_on',
    'ignore_paths',
    'registry',
    'semgrep',
    'llm',
  ];
  warnUnknown(root, known, null, source, warnings);

  if ('version' in root) {
    const version = asNumber(root['version'], 'version', source);
    if (version !== 1) warnings.push(`policy version ${version} is newer than this aigate build (expected 1)`);
    policy.version = version;
  }
  if ('block_on' in root) policy.blockOn = asStringList(root['block_on'], 'block_on', source);
  if ('critical_paths' in root) policy.criticalPaths = asStringList(root['critical_paths'], 'critical_paths', source);
  if ('critical_path_block_on' in root) {
    policy.criticalPathBlockOn = asStringList(root['critical_path_block_on'], 'critical_path_block_on', source);
  }
  if ('ignore_paths' in root) policy.ignorePaths = asStringList(root['ignore_paths'], 'ignore_paths', source);

  const registry = optionalMap(root['registry'], 'registry', source);
  if (registry) {
    warnUnknown(
      registry,
      ['enabled', 'timeout_ms', 'allow_offline', 'allowlist', 'registry_url', 'cache_ttl_hours'],
      'registry',
      source,
      warnings,
    );
    if ('enabled' in registry) policy.registry.enabled = asBoolean(registry['enabled'], 'registry.enabled', source);
    if ('timeout_ms' in registry) policy.registry.timeoutMs = asNumber(registry['timeout_ms'], 'registry.timeout_ms', source);
    if ('allow_offline' in registry) {
      policy.registry.allowOffline = asBoolean(registry['allow_offline'], 'registry.allow_offline', source);
    }
    if ('allowlist' in registry) policy.registry.allowlist = asStringList(registry['allowlist'], 'registry.allowlist', source);
    if ('registry_url' in registry) policy.registry.registryUrl = asString(registry['registry_url'], 'registry.registry_url', source);
    if ('cache_ttl_hours' in registry) {
      policy.registry.cacheTtlHours = asNumber(registry['cache_ttl_hours'], 'registry.cache_ttl_hours', source);
    }
  }

  const semgrep = optionalMap(root['semgrep'], 'semgrep', source);
  if (semgrep) {
    warnUnknown(semgrep, ['enabled', 'config', 'timeout_ms'], 'semgrep', source, warnings);
    if ('enabled' in semgrep) policy.semgrep.enabled = asBoolean(semgrep['enabled'], 'semgrep.enabled', source);
    if ('config' in semgrep) policy.semgrep.config = asStringList(semgrep['config'], 'semgrep.config', source);
    if ('timeout_ms' in semgrep) policy.semgrep.timeoutMs = asNumber(semgrep['timeout_ms'], 'semgrep.timeout_ms', source);
  }

  const llm = optionalMap(root['llm'], 'llm', source);
  if (llm) {
    warnUnknown(llm, ['enabled', 'url', 'model', 'timeout_ms', 'max_diff_bytes'], 'llm', source, warnings);
    if ('enabled' in llm) policy.llm.enabled = asBoolean(llm['enabled'], 'llm.enabled', source);
    if ('url' in llm) policy.llm.url = asString(llm['url'], 'llm.url', source);
    if ('model' in llm) policy.llm.model = asString(llm['model'], 'llm.model', source);
    if ('timeout_ms' in llm) policy.llm.timeoutMs = asNumber(llm['timeout_ms'], 'llm.timeout_ms', source);
    if ('max_diff_bytes' in llm) policy.llm.maxDiffBytes = asNumber(llm['max_diff_bytes'], 'llm.max_diff_bytes', source);
  }

  return policy;
}

function warnUnknown(
  map: Record<string, YamlValue>,
  known: readonly string[],
  section: string | null,
  source: string,
  warnings: string[],
): void {
  for (const key of Object.keys(map)) {
    if (!known.includes(key)) {
      const label = section ? `${section}.${key}` : key;
      warnings.push(`unknown policy key "${label}" ignored (${source})`);
    }
  }
}

function asMap(value: YamlValue, field: string, source: string): Record<string, YamlValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PolicyError(`${field} must be a mapping in ${source}`);
  }
  return value as Record<string, YamlValue>;
}

function optionalMap(value: YamlValue | undefined, field: string, source: string): Record<string, YamlValue> | null {
  if (value === undefined || value === null) return null;
  return asMap(value, field, source);
}

function asStringList(value: YamlValue | undefined, field: string, source: string): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) throw new PolicyError(`${field} must be a list in ${source}`);
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new PolicyError(`${field}[${index}] must be a string in ${source}`);
    return item;
  });
}

function asString(value: YamlValue | undefined, field: string, source: string): string {
  if (typeof value !== 'string') throw new PolicyError(`${field} must be a string in ${source}`);
  return value;
}

function asBoolean(value: YamlValue | undefined, field: string, source: string): boolean {
  if (typeof value !== 'boolean') throw new PolicyError(`${field} must be true or false in ${source}`);
  return value;
}

function asNumber(value: YamlValue | undefined, field: string, source: string): number {
  if (typeof value !== 'number') throw new PolicyError(`${field} must be a number in ${source}`);
  return value;
}

/** Resolves a policy-relative path (semgrep configs) against the policy root. */
export function resolveFromRoot(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}
