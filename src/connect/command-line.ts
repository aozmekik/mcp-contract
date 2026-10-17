import { UsageError } from '../core/errors.ts';

/**
 * Splits a command line into argv words using a small, predictable subset of
 * POSIX shell quoting:
 *
 * - unquoted whitespace separates words;
 * - `'single quotes'` keep everything literally;
 * - `"double quotes"` keep everything literally except `\"` and `\\`;
 * - outside quotes a backslash escapes the next character.
 *
 * It deliberately does **not** expand variables, globs, `~`, pipes or
 * redirections: the result is passed straight to `spawn()` without a shell, so
 * what you type is what the server receives. Use `sh -c '...'` explicitly when
 * shell features are needed.
 *
 * @throws {UsageError} on unterminated quotes, a trailing backslash, or an
 *   empty command.
 */
export function splitCommandLine(line: string): [string, ...string[]] {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let i = 0;

  while (i < line.length) {
    const char = line.charAt(i);
    if (char === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) {
        throw new UsageError(`Unterminated single quote in command: ${line}`);
      }
      current += line.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (char === '"') {
      i += 1;
      let closed = false;
      while (i < line.length) {
        const inner = line.charAt(i);
        if (inner === '"') {
          closed = true;
          i += 1;
          break;
        }
        const next = line.charAt(i + 1);
        if (inner === '\\' && (next === '"' || next === '\\')) {
          current += next;
          i += 2;
        } else {
          current += inner;
          i += 1;
        }
      }
      if (!closed) {
        throw new UsageError(`Unterminated double quote in command: ${line}`);
      }
      inWord = true;
    } else if (char === '\\') {
      if (i + 1 >= line.length) {
        throw new UsageError(`Trailing backslash in command: ${line}`);
      }
      current += line.charAt(i + 1);
      inWord = true;
      i += 2;
    } else if (/\s/.test(char)) {
      if (inWord) {
        words.push(current);
        current = '';
        inWord = false;
      }
      i += 1;
    } else {
      current += char;
      inWord = true;
      i += 1;
    }
  }
  if (inWord) {
    words.push(current);
  }
  const [command, ...args] = words;
  if (command === undefined) {
    throw new UsageError('The server command is empty.');
  }
  return [command, ...args];
}

/** Quotes a single argv word so that {@link splitCommandLine} returns it unchanged. */
export function quoteWord(word: string): string {
  if (word !== '' && /^[\w@%+=:,./-]+$/.test(word)) {
    return word;
  }
  return `'${word.replaceAll("'", `'\\''`)}'`;
}
