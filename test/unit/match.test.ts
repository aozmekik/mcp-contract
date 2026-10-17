import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../src/core/json.ts';
import { isOperatorObject, matchValue, validateExpectation } from '../../src/scenarios/match.ts';

function reasons(actual: JsonValue | undefined, expected: JsonValue): string[] {
  return matchValue(actual, expected).map((mismatch) => `${mismatch.path}: ${mismatch.reason}`);
}

describe('matchValue', () => {
  it('matches objects as subsets and arrays element-wise', () => {
    expect(reasons({ a: 1, b: { c: 'x', d: 2 } }, { b: { c: 'x' } })).toEqual([]);
    expect(reasons([{ a: 1, b: 2 }, 3], [{ a: 1 }, 3])).toEqual([]);
    expect(reasons([1, 2, 3], [1, 2])).toEqual(['$: expected 2 elements, found 3']);
    expect(reasons({ a: 1 }, { a: 2 })).toEqual(['$.a: expected 2, found 1']);
    expect(reasons({ a: 1 }, { b: 1 })).toEqual(['$.b: expected 1, found nothing']);
    expect(reasons({ 'odd-key': 1 }, { 'odd-key': 2 })).toEqual([
      '$["odd-key"]: expected 2, found 1',
    ]);
    expect(reasons('x', { a: 1 })).toEqual(['$: expected an object, found "x"']);
    expect(reasons({}, [1])).toEqual(['$: expected an array, found {}']);
  });

  it('supports $equals for exact matches', () => {
    expect(reasons({ a: 1, b: 2 }, { $equals: { a: 1 } })).toEqual([
      '$: expected exactly {"a":1}, found {"a":1,"b":2}',
    ]);
    expect(reasons({ a: 1 }, { $equals: { a: 1 } })).toEqual([]);
  });

  it('supports $regex with flags', () => {
    expect(reasons('Note n_1 not found', { $regex: 'NOT FOUND', $flags: 'i' })).toEqual([]);
    expect(reasons('ok', { $regex: '^n_' })).toEqual([
      '$: expected a string matching /^n_/, found "ok"',
    ]);
    expect(reasons(3, { $regex: '3' })).toHaveLength(1);
  });

  it('supports $type, $length, $contains and comparisons', () => {
    expect(reasons(3, { $type: 'integer' })).toEqual([]);
    expect(reasons(3.5, { $type: 'integer' })).toEqual(['$: expected type integer, found 3.5']);
    expect(reasons([1, 2], { $type: 'array', $length: 2 })).toEqual([]);
    expect(reasons('abc', { $length: 2 })).toEqual(['$: expected length 2, found length 3']);
    expect(reasons(5, { $length: 2 })).toEqual(['$: expected length 2, found 5']);
    expect(reasons('hello world', { $contains: 'world' })).toEqual([]);
    expect(reasons([{ id: 1, x: 2 }], { $contains: { id: 1 } })).toEqual([]);
    expect(reasons([1], { $contains: 2 })).toEqual(['$: expected [1] to contain 2']);
    expect(reasons(5, { $gt: 4, $gte: 5, $lt: 6, $lte: 5 })).toEqual([]);
    expect(reasons(5, { $gt: 5 })).toEqual(['$: expected a number gt 5, found 5']);
    expect(reasons('5', { $lte: 9 })).toHaveLength(1);
  });

  it('supports $exists inside objects', () => {
    expect(reasons({ a: 1 }, { b: { $exists: false } })).toEqual([]);
    expect(reasons({ a: 1 }, { a: { $exists: false } })).toEqual([
      '$.a: expected nothing, found 1',
    ]);
    expect(reasons({}, { a: { $exists: true } })).toEqual(['$.a: expected a value, found nothing']);
    expect(reasons({}, { a: { $type: 'string' } })).toEqual([
      '$.a: expected a value, found nothing',
    ]);
  });

  it('truncates long values in messages', () => {
    const [reason] = reasons('x'.repeat(200), 'y');
    expect(reason?.length).toBeLessThan(200);
  });
});

describe('validateExpectation', () => {
  it('accepts well-formed expectations', () => {
    expect(
      validateExpectation({
        a: [{ $regex: '^x', $flags: 'i' }, { $contains: { $type: 'string' } }],
      }),
    ).toEqual([]);
    expect(isOperatorObject({ $exists: true })).toBe(true);
    expect(isOperatorObject({})).toBe(false);
  });

  it.each([
    [{ $regex: '(' }, 'invalid regular expression'],
    [{ $regex: 1 }, '$regex must be a string'],
    [{ $flags: 'i' }, '$flags must be a string used together with $regex'],
    [{ $exists: 'yes' }, '$exists must be true or false'],
    [{ $length: -1 }, '$length must be a non-negative integer'],
    [{ $type: 'date' }, '$type must be one of'],
    [{ $gt: 'a' }, '$gt must be a number'],
    [{ $nope: 1 }, 'unknown operator $nope'],
    [{ $regex: 'a', plain: 1 }, 'cannot mix operators'],
    [{ $exists: false, $type: 'string' }, '$exists: false cannot be combined'],
    [{ deep: [{ $contains: { $bad: 1 } }] }, '$.deep[0].$contains: unknown operator $bad'],
  ])('rejects %j', (expectation, message) => {
    expect(validateExpectation(expectation as JsonValue).join('\n')).toContain(message);
  });
});
