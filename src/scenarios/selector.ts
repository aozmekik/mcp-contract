/**
 * A small, documented subset of JSONPath (RFC 9535) for picking values out of
 * tool results:
 *
 * ```text
 * $                       the root
 * $.name   $['name']      object member (bracket form for any name)
 * $[0]     $[-1]          array element, negative indexes count from the end
 * $.*      $[*]           every member of an object or element of an array
 * ```
 *
 * Filters, slices, unions and descendant segments (`..`) are intentionally
 * not supported; a selector using them is rejected when the scenario file is
 * loaded rather than silently matching nothing.
 */
import { isJsonObject, type JsonValue } from '../core/json.ts';

/** One step of a parsed selector. */
export type SelectorSegment =
  | { readonly kind: 'member'; readonly name: string }
  | { readonly kind: 'index'; readonly index: number }
  | { readonly kind: 'wildcard' };

/** A value found by a selector, with its normalized location. */
export interface SelectedValue {
  /** The selected value. */
  readonly value: JsonValue;
  /** Location of the value, e.g. `$.content[0].text`. */
  readonly path: string;
}

/** Raised when a selector does not follow the supported grammar. */
export class SelectorSyntaxError extends SyntaxError {
  /** Creates an error pointing at `position` in `selector`. */
  constructor(selector: string, position: number, problem: string) {
    super(`Invalid selector ${JSON.stringify(selector)} at position ${position}: ${problem}`);
    this.name = 'SelectorSyntaxError';
  }
}

const NAME_START = /[A-Za-z_\u0080-￿]/u;
const NAME_CHAR = /[A-Za-z0-9_\u0080-￿]/u;

function parseQuoted(selector: string, start: number): { value: string; end: number } {
  const quote = selector.charAt(start);
  let value = '';
  let i = start + 1;
  while (i < selector.length) {
    const char = selector.charAt(i);
    if (char === quote) {
      return { value, end: i + 1 };
    }
    if (char === '\\') {
      const next = selector.charAt(i + 1);
      if (next === 'u') {
        const hex = selector.slice(i + 2, i + 6);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
          throw new SelectorSyntaxError(selector, i, 'expected four hex digits after \\u');
        }
        value += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
      const escapes: Record<string, string> = {
        '\\': '\\',
        '/': '/',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
        "'": "'",
        '"': '"',
      };
      const escaped = escapes[next];
      if (escaped === undefined) {
        throw new SelectorSyntaxError(selector, i, `unsupported escape \\${next}`);
      }
      value += escaped;
      i += 2;
    } else {
      value += char;
      i += 1;
    }
  }
  throw new SelectorSyntaxError(selector, start, 'unterminated string');
}

/**
 * Parses a selector into segments.
 *
 * @throws {SelectorSyntaxError} if the selector is not in the supported subset.
 */
export function parseSelector(selector: string): SelectorSegment[] {
  if (!selector.startsWith('$')) {
    throw new SelectorSyntaxError(selector, 0, 'a selector must start with $');
  }
  const segments: SelectorSegment[] = [];
  let i = 1;
  while (i < selector.length) {
    const char = selector.charAt(i);
    if (char === '.') {
      const next = selector.charAt(i + 1);
      if (next === '.') {
        throw new SelectorSyntaxError(selector, i, 'descendant segments (..) are not supported');
      }
      if (next === '*') {
        segments.push({ kind: 'wildcard' });
        i += 2;
        continue;
      }
      if (!NAME_START.test(next)) {
        throw new SelectorSyntaxError(
          selector,
          i + 1,
          "expected a member name; use ['...'] for other names",
        );
      }
      let end = i + 2;
      while (end < selector.length && NAME_CHAR.test(selector.charAt(end))) {
        end += 1;
      }
      segments.push({ kind: 'member', name: selector.slice(i + 1, end) });
      i = end;
    } else if (char === '[') {
      const next = selector.charAt(i + 1);
      let end: number;
      if (next === "'" || next === '"') {
        const quoted = parseQuoted(selector, i + 1);
        segments.push({ kind: 'member', name: quoted.value });
        end = quoted.end;
      } else if (next === '*') {
        segments.push({ kind: 'wildcard' });
        end = i + 2;
      } else {
        const match = /^-?(0|[1-9][0-9]*)/.exec(selector.slice(i + 1));
        if (match === null) {
          throw new SelectorSyntaxError(
            selector,
            i + 1,
            'expected an index, * or a quoted name; filters and slices are not supported',
          );
        }
        segments.push({ kind: 'index', index: Number(match[0]) });
        end = i + 1 + match[0].length;
      }
      if (selector.charAt(end) !== ']') {
        throw new SelectorSyntaxError(selector, end, 'expected ]');
      }
      i = end + 1;
    } else {
      throw new SelectorSyntaxError(selector, i, `unexpected character ${JSON.stringify(char)}`);
    }
  }
  return segments;
}

function memberPath(path: string, name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    ? `${path}.${name}`
    : `${path}[${JSON.stringify(name)}]`;
}

/** Formats segments back into a selector string that {@link parseSelector} accepts. */
export function formatSelector(segments: readonly SelectorSegment[]): string {
  let path = '$';
  for (const segment of segments) {
    switch (segment.kind) {
      case 'member':
        path = memberPath(path, segment.name);
        break;
      case 'index':
        path = `${path}[${segment.index}]`;
        break;
      case 'wildcard':
        path = `${path}[*]`;
        break;
    }
  }
  return path;
}

/** Evaluates parsed segments against `root` and returns every selected value in document order. */
export function select(root: JsonValue, segments: readonly SelectorSegment[]): SelectedValue[] {
  let nodes: SelectedValue[] = [{ value: root, path: '$' }];
  for (const segment of segments) {
    const next: SelectedValue[] = [];
    for (const { value, path } of nodes) {
      if (segment.kind === 'member') {
        if (isJsonObject(value) && Object.hasOwn(value, segment.name)) {
          next.push({
            value: value[segment.name] as JsonValue,
            path: memberPath(path, segment.name),
          });
        }
      } else if (segment.kind === 'index') {
        if (Array.isArray(value)) {
          const index = segment.index < 0 ? value.length + segment.index : segment.index;
          if (index >= 0 && index < value.length) {
            next.push({ value: value[index] as JsonValue, path: `${path}[${index}]` });
          }
        }
      } else if (Array.isArray(value)) {
        value.forEach((item, index) => next.push({ value: item, path: `${path}[${index}]` }));
      } else if (isJsonObject(value)) {
        for (const [name, item] of Object.entries(value)) {
          next.push({ value: item, path: memberPath(path, name) });
        }
      }
    }
    nodes = next;
  }
  return nodes;
}
