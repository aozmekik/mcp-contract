/** Minimal ANSI styling that is a no-op when color is disabled. */
export interface Style {
  /** Red, for breaking changes and failures. */
  red(text: string): string;
  /** Yellow, for unknown changes. */
  yellow(text: string): string;
  /** Green, for compatible changes and passes. */
  green(text: string): string;
  /** Bold. */
  bold(text: string): string;
  /** Dim, for locations and secondary text. */
  dim(text: string): string;
}

function wrap(open: number, close: number): (text: string) => string {
  return (text) => `\u001B[${open}m${text}\u001B[${close}m`;
}

const identity = (text: string): string => text;

/** Returns a {@link Style} that emits ANSI escape codes only when `color` is true. */
export function createStyle(color: boolean): Style {
  if (!color) {
    return { red: identity, yellow: identity, green: identity, bold: identity, dim: identity };
  }
  return {
    red: wrap(31, 39),
    yellow: wrap(33, 39),
    green: wrap(32, 39),
    bold: wrap(1, 22),
    dim: wrap(2, 22),
  };
}

/**
 * Decides whether to color output, following the NO_COLOR (https://no-color.org)
 * and FORCE_COLOR conventions, with explicit flags taking precedence.
 */
export function shouldColor(options: {
  readonly flag?: boolean | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isTTY: boolean;
}): boolean {
  if (options.flag !== undefined) {
    return options.flag;
  }
  const noColor = options.env.NO_COLOR;
  if (noColor !== undefined && noColor !== '') {
    return false;
  }
  const force = options.env.FORCE_COLOR;
  if (force !== undefined) {
    return force !== '0' && force !== 'false';
  }
  return options.isTTY;
}

/**
 * Characters that must not reach a terminal or a CI log unescaped: C0 and C1
 * control characters (ANSI escape sequences start with one) and the Unicode
 * bidirectional overrides that can make text display differently from what
 * it is.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

/**
 * Escapes characters in server-provided text (tool names, property names,
 * messages) that could change how a report is displayed or interpreted: a
 * newline, for example, could start a fake line in a CI log.
 */
export function printable(text: string): string {
  return text.replaceAll(UNPRINTABLE, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return `\\u${code.toString(16).padStart(4, '0')}`;
  });
}
