import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { quoteWord, splitCommandLine } from '../../src/connect/command-line.ts';
import { UsageError } from '../../src/core/errors.ts';

describe('splitCommandLine', () => {
  it.each([
    ['node server.js', ['node', 'server.js']],
    ['  node   server.js  --port 3000 ', ['node', 'server.js', '--port', '3000']],
    [`python -m "my server" 'a b'`, ['python', '-m', 'my server', 'a b']],
    [String.raw`echo "say \"hi\"" back\ slash`, ['echo', 'say "hi"', 'back slash']],
    [String.raw`"C:\Program Files\x"`, [String.raw`C:\Program Files\x`]],
    [`a"b"'c'd`, ['abcd']],
    [`empty '' ""`, ['empty', '', '']],
    ['npx -y @scope/server $HOME *.json', ['npx', '-y', '@scope/server', '$HOME', '*.json']],
  ])('splits %j', (line, expected) => {
    expect(splitCommandLine(line)).toEqual(expected);
  });

  it.each([
    ['node "unterminated', 'Unterminated double quote'],
    ["node 'unterminated", 'Unterminated single quote'],
    ['node trailing\\', 'Trailing backslash'],
    ['   ', 'empty'],
  ])('rejects %j', (line, message) => {
    expect(() => splitCommandLine(line)).toThrow(UsageError);
    expect(() => splitCommandLine(line)).toThrow(message);
  });

  it('round-trips any argv through quoteWord (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { minLength: 1, maxLength: 6 }), (argv) => {
        expect(splitCommandLine(argv.map(quoteWord).join(' '))).toEqual(argv);
      }),
    );
  });

  it('leaves simple words unquoted', () => {
    expect(quoteWord('server.js')).toBe('server.js');
    expect(quoteWord('')).toBe("''");
    expect(quoteWord("it's")).toBe(`'it'\\''s'`);
  });
});
