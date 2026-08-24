/**
 * Minimal glob matcher for policy path patterns.
 *
 * Supports `**`, `*`, `?`, character classes `[...]`, and brace alternation `{a,b}`.
 * Paths are normalised to forward slashes so Windows and POSIX behave identically.
 */

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;

  let out = '';
  let i = 0;
  const source = normalizePath(pattern);

  while (i < source.length) {
    const ch = source[i]!;

    if (ch === '*') {
      if (source[i + 1] === '*') {
        if (source[i + 2] === '/') {
          // `**/` matches zero or more leading path segments, so `**/x` also matches `x`.
          out += '(?:[^/]*/)*';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
        continue;
      }
      out += '[^/]*';
      i++;
      continue;
    }

    if (ch === '?') {
      out += '[^/]';
      i++;
      continue;
    }

    if (ch === '[') {
      const close = source.indexOf(']', i + 1);
      if (close !== -1) {
        const body = source.slice(i + 1, close);
        out += `[${body.startsWith('!') ? '^' + body.slice(1) : body}]`;
        i = close + 1;
        continue;
      }
    }

    if (ch === '{') {
      const close = source.indexOf('}', i + 1);
      if (close !== -1) {
        const options = source.slice(i + 1, close).split(',');
        out += `(?:${options.map(escapeRegExp).join('|')})`;
        i = close + 1;
        continue;
      }
    }

    out += escapeRegExp(ch);
    i++;
  }

  const regexp = new RegExp(`^${out}$`);
  cache.set(pattern, regexp);
  return regexp;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchesGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(normalizePath(path));
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}
