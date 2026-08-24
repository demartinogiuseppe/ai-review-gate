/**
 * Minimal YAML subset parser.
 *
 * aigate ships zero runtime dependencies on purpose: it runs on every file write
 * inside a Claude Code session, so process start-up cost is part of the UX budget.
 * The policy file only needs nested maps, lists of scalars, and simple scalars,
 * which is a small enough subset to own outright.
 *
 * Supported: nested maps, lists (of scalars or of maps), `#` comments, single and
 * double quoted strings, booleans, null, numbers, and inline `[]` / `{}` empties.
 * Not supported: anchors, multi-line block scalars, flow collections with content,
 * multiple documents.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export class YamlError extends Error {
  constructor(message: string, public readonly line: number) {
    super(`${message} (line ${line})`);
    this.name = 'YamlError';
  }
}

interface Line {
  indent: number;
  content: string;
  /** 1-based line number in the source, for error messages. */
  number: number;
}

export function parseYaml(source: string): YamlValue {
  const lines = tokenize(source);
  if (lines.length === 0) return {};
  const [value, consumed] = parseBlock(lines, 0, lines[0]!.indent);
  if (consumed < lines.length) {
    throw new YamlError('unexpected indentation', lines[consumed]!.number);
  }
  return value;
}

function tokenize(source: string): Line[] {
  const out: Line[] = [];
  const raw = source.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const text = raw[i]!;
    if (text.includes('\t')) {
      const beforeContent = text.slice(0, text.length - text.trimStart().length);
      if (beforeContent.includes('\t')) throw new YamlError('tabs are not valid YAML indentation', i + 1);
    }
    const stripped = stripComment(text);
    if (stripped.trim() === '') continue;
    if (stripped.trim() === '---') continue;
    out.push({ indent: stripped.length - stripped.trimStart().length, content: stripped.trim(), number: i + 1 });
  }
  return out;
}

/** Removes a trailing `#` comment, respecting quoted spans. */
function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]!))) return text.slice(0, i);
  }
  return text;
}

/** Parses every line at `indent` starting at `start`; returns the value and the next unconsumed index. */
function parseBlock(lines: Line[], start: number, indent: number): [YamlValue, number] {
  const first = lines[start];
  if (!first) return [null, start];
  return first.content.startsWith('- ') || first.content === '-'
    ? parseList(lines, start, indent)
    : parseMap(lines, start, indent);
}

function parseMap(lines: Line[], start: number, indent: number): [YamlValue, number] {
  const map: { [key: string]: YamlValue } = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError('unexpected indentation', line.number);
    if (line.content.startsWith('- ')) break;

    const split = splitKey(line.content, line.number);
    const [key, inline] = split;
    if (inline !== '') {
      map[key] = parseScalar(inline);
      i++;
      continue;
    }
    // Value lives in the indented block below, if there is one.
    const next = lines[i + 1];
    if (next && next.indent > indent) {
      const [value, consumed] = parseBlock(lines, i + 1, next.indent);
      map[key] = value;
      i = consumed;
    } else {
      map[key] = null;
      i++;
    }
  }
  return [map, i];
}

function parseList(lines: Line[], start: number, indent: number): [YamlValue, number] {
  const list: YamlValue[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError('unexpected indentation', line.number);
    if (!line.content.startsWith('- ') && line.content !== '-') break;

    const item = line.content === '-' ? '' : line.content.slice(2).trim();
    if (item === '') {
      const next = lines[i + 1];
      if (next && next.indent > indent) {
        const [value, consumed] = parseBlock(lines, i + 1, next.indent);
        list.push(value);
        i = consumed;
      } else {
        list.push(null);
        i++;
      }
      continue;
    }
    if (isKeyLine(item)) {
      // `- key: value` opens a map whose remaining keys are indented to the item text.
      const itemIndent = indent + 2;
      const synthetic: Line[] = [{ indent: itemIndent, content: item, number: line.number }];
      let j = i + 1;
      while (j < lines.length && lines[j]!.indent >= itemIndent && !lines[j]!.content.startsWith('- ')) {
        synthetic.push(lines[j]!);
        j++;
      }
      const [value] = parseMap(synthetic, 0, itemIndent);
      list.push(value);
      i = j;
      continue;
    }
    list.push(parseScalar(item));
    i++;
  }
  return [list, i];
}

function isKeyLine(text: string): boolean {
  try {
    splitKey(text, 0);
    return true;
  } catch {
    return false;
  }
}

/** Splits `key: value` into its two halves, honouring quoted keys. */
function splitKey(text: string, lineNumber: number): [string, string] {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ':' && (i === text.length - 1 || /\s/.test(text[i + 1]!))) {
      return [unquote(text.slice(0, i).trim()), text.slice(i + 1).trim()];
    }
  }
  throw new YamlError(`expected "key: value", got ${JSON.stringify(text)}`, lineNumber);
}

function unquote(text: string): string {
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0]) {
    return text.slice(1, -1);
  }
  return text;
}

function parseScalar(text: string): YamlValue {
  if (text === '[]') return [];
  if (text === '{}') return {};
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0]) {
    return text.slice(1, -1);
  }
  if (text === 'true' || text === 'yes' || text === 'on') return true;
  if (text === 'false' || text === 'no' || text === 'off') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d*\.\d+$/.test(text)) return Number(text);
  return text;
}
