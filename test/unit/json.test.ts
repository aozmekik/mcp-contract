import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  NonJsonValueError,
  canonicalJson,
  canonicalize,
  compareCodeUnits,
  jsonEqual,
  jsonTypeOf,
  type JsonValue,
} from '../../src/core/json.ts';

const json: fc.Arbitrary<JsonValue> = fc.jsonValue() as fc.Arbitrary<JsonValue>;

/** Rebuilds every object with its keys in reverse insertion order. */
function reverseKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(reverseKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reverseKeys(item)]),
    );
  }
  return value;
}

describe('canonicalize', () => {
  it('sorts keys recursively by UTF-16 code units', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 3 }, B: 0 })).toBe(
      '{"B":0,"a":{"c":3,"d":[{"y":2,"z":1}]},"b":1}',
    );
    expect(compareCodeUnits('Z', 'a')).toBeLessThan(0);
    expect(compareCodeUnits('a', 'a')).toBe(0);
  });

  it('omits undefined members and normalises -0', () => {
    expect(canonicalize({ a: undefined, b: -0 })).toEqual({ b: 0 });
    expect(Object.is(canonicalize(-0), 0)).toBe(true);
  });

  it('rejects values JSON cannot represent, naming where they are', () => {
    expect(() => canonicalize({ a: [1, Number.NaN] })).toThrow(NonJsonValueError);
    expect(() => canonicalize({ a: [1, Number.NaN] })).toThrow('$.a[1]');
    expect(() => canonicalize({ f: () => 1 })).toThrow('unsupported type function');
    expect(() => canonicalize({ when: new Date(0) })).toThrow('not a plain object');
    expect(() => canonicalize({ 'odd key': 10n })).toThrow('$["odd key"]');
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalize(cycle)).toThrow('circular reference');
  });

  it('accepts shared (non-circular) references and null-prototype objects', () => {
    const shared = { x: 1 };
    const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, { k: 1 });
    expect(canonicalize({ a: shared, b: shared, c: nullProto })).toEqual({
      a: { x: 1 },
      b: { x: 1 },
      c: { k: 1 },
    });
  });

  it('is idempotent and independent of key order (property)', () => {
    fc.assert(
      fc.property(json, (value) => {
        const once = canonicalJson(value);
        expect(canonicalJson(JSON.parse(once))).toBe(once);
        expect(canonicalJson(reverseKeys(value))).toBe(once);
      }),
    );
  });
});

describe('jsonEqual', () => {
  it('ignores key order but not array order', () => {
    expect(jsonEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(jsonEqual({ a: 1 }, [1])).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
  });

  it('agrees with canonical serialisation (property)', () => {
    fc.assert(
      fc.property(json, json, (a, b) => {
        expect(jsonEqual(a, b)).toBe(canonicalJson(a) === canonicalJson(b));
        expect(jsonEqual(a, reverseKeys(a))).toBe(true);
      }),
    );
  });
});

describe('jsonTypeOf', () => {
  it('names every JSON type', () => {
    expect([null, true, 1, 's', [], {}].map(jsonTypeOf)).toEqual([
      'null',
      'boolean',
      'number',
      'string',
      'array',
      'object',
    ]);
  });
});

describe('members named like Object.prototype properties', () => {
  it('keeps __proto__ and constructor as ordinary members', () => {
    const parsed = JSON.parse('{"__proto__":{"type":"string"},"constructor":1,"a":2}') as unknown;
    const canonical = canonicalize(parsed);
    expect(Object.getPrototypeOf(canonical)).toBe(Object.prototype);
    expect(Object.keys(canonical as object)).toEqual(['__proto__', 'a', 'constructor']);
    expect(canonicalJson(parsed)).toBe('{"__proto__":{"type":"string"},"a":2,"constructor":1}');
    expect(canonicalize(canonical)).toEqual(canonical);
  });

  it('compares own members only', () => {
    const withProto = JSON.parse('{"__proto__":1}') as JsonValue;
    expect(jsonEqual(withProto, JSON.parse('{"__proto__":1}') as JsonValue)).toBe(true);
    expect(jsonEqual(withProto, { a: 1 })).toBe(false);
    expect(jsonEqual({ toString: 1 }, { valueOf: 1 })).toBe(false);
  });
});
