import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../src/core/json.ts';
import {
  SelectorSyntaxError,
  formatSelector,
  parseSelector,
  select,
  type SelectorSegment,
} from '../../src/scenarios/selector.ts';

const result: JsonValue = {
  content: [
    { type: 'text', text: 'first' },
    { type: 'text', text: 'second' },
  ],
  structuredContent: { total: 2, 'odd key': { "it's": true }, items: [] },
};

describe('parseSelector / select', () => {
  it.each([
    ['$', [result]],
    ['$.structuredContent.total', [2]],
    ['$.content[0].text', ['first']],
    ['$.content[-1].text', ['second']],
    ['$.content[*].text', ['first', 'second']],
    ['$.content.*.type', ['text', 'text']],
    [`$.structuredContent['odd key']["it's"]`, [true]],
    ['$.structuredContent["odd key"].*', [true]],
    ['$.structuredContent.items[*]', []],
    ['$.content[5]', []],
    ['$.missing.deeper', []],
    ['$.content.text', []],
    ['$.structuredContent[0]', []],
  ])('%s', (selector, expected) => {
    expect(select(result, parseSelector(selector)).map((node) => node.value)).toEqual(expected);
  });

  it('returns normalized paths', () => {
    expect(select(result, parseSelector('$.content[*].text')).map((node) => node.path)).toEqual([
      '$.content[0].text',
      '$.content[1].text',
    ]);
    expect(
      select(result, parseSelector("$['structuredContent'].*")).map((node) => node.path),
    ).toEqual([
      '$.structuredContent.total',
      '$.structuredContent["odd key"]',
      '$.structuredContent.items',
    ]);
  });

  it('decodes escapes in quoted names', () => {
    expect(parseSelector(String.raw`$["a\"b\\cA\n"]`)).toEqual([
      { kind: 'member', name: 'a"b\\cA\n' },
    ]);
  });

  it.each([
    ['content', 'must start with $'],
    ['$..text', 'descendant segments'],
    ['$.content[?(@.type)]', 'filters and slices are not supported'],
    ['$.content[0:2]', 'expected ]'],
    ['$.1abc', 'expected a member name'],
    ['$["unterminated', 'unterminated string'],
    [String.raw`$["\x"]`, 'unsupported escape'],
    [String.raw`$["\u12"]`, 'four hex digits'],
    ['$ .a', 'unexpected character'],
  ])('rejects %s', (selector, message) => {
    expect(() => parseSelector(selector)).toThrow(SelectorSyntaxError);
    expect(() => parseSelector(selector)).toThrow(message);
  });
});

const segmentArb: fc.Arbitrary<SelectorSegment> = fc.oneof(
  fc.string().map((name) => ({ kind: 'member' as const, name })),
  fc.integer({ min: -3, max: 5 }).map((index) => ({ kind: 'index' as const, index })),
  fc.constant({ kind: 'wildcard' as const }),
);

describe('selector properties', () => {
  it('formatSelector and parseSelector round-trip', () => {
    fc.assert(
      fc.property(fc.array(segmentArb, { maxLength: 5 }), (segments) => {
        expect(parseSelector(formatSelector(segments))).toEqual(segments);
      }),
    );
  });

  it('every path reported by a wildcard selector selects exactly that value', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }) as fc.Arbitrary<JsonValue>, (document) => {
        for (const depth of [1, 2, 3]) {
          const wildcard = parseSelector(`$${'[*]'.repeat(depth)}`);
          for (const node of select(document, wildcard)) {
            expect(select(document, parseSelector(node.path))).toEqual([node]);
          }
        }
      }),
    );
  });
});
