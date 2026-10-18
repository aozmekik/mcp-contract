import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../../src/core/json.ts';
import { object, triples } from '../helpers/schema.ts';

const string = { type: 'string' };
const integer = { type: 'integer' };

describe('unevaluatedProperties without in-place applicators', () => {
  // With nothing else evaluating properties, unevaluatedProperties validates
  // exactly what additionalProperties would, and is compared the same way.
  const closed = (properties: Record<string, JsonObject>): JsonObject =>
    object(properties, { unevaluatedProperties: false });

  it('makes removing a property breaking for inputs', () => {
    expect(triples(closed({ a: string, b: string }), closed({ a: string }), 'input')).toEqual([
      ['breaking', 'property-removed', '$.b'],
    ]);
    expect(triples(closed({ a: string, b: string }), closed({ a: string }), 'output')).toEqual([
      ['breaking', 'property-removed', '$.b'],
    ]);
  });

  it('compares a removed property with a schema-valued unevaluatedProperties', () => {
    const before = object({ a: string, b: integer }, { unevaluatedProperties: string });
    const after = object({ a: string }, { unevaluatedProperties: string });
    expect(triples(before, after, 'input')).toEqual([
      ['breaking', 'type-narrowed', '$.b'],
      ['non-breaking', 'type-widened', '$.b'],
      ['non-breaking', 'property-removed', '$.b'],
    ]);
  });

  it('compares an added property with what unevaluatedProperties accepted', () => {
    const before = object({ a: string }, { unevaluatedProperties: string });
    const after = object({ a: string, b: integer }, { unevaluatedProperties: string });
    expect(triples(before, after, 'input')).toEqual([
      ['breaking', 'type-narrowed', '$.b'],
      ['non-breaking', 'type-widened', '$.b'],
      ['non-breaking', 'property-added', '$.b'],
    ]);
  });

  it('treats it like additionalProperties: false, and reports opening it', () => {
    const viaAdditional = object({ a: string }, { additionalProperties: false });
    expect(triples(viaAdditional, closed({ a: string }), 'input')).toEqual([]);
    expect(triples(closed({ a: string }), object({ a: string }), 'input')).toEqual([
      ['non-breaking', 'additional-properties-allowed', '$'],
    ]);
  });

  it('ignores it where additionalProperties already evaluates everything', () => {
    const before = object(
      { a: string, b: string },
      { additionalProperties: true, unevaluatedProperties: false },
    );
    const after = object(
      { a: string },
      { additionalProperties: true, unevaluatedProperties: false },
    );
    expect(triples(before, after, 'input')).toEqual([['non-breaking', 'property-removed', '$.b']]);
  });
});

describe('unevaluatedProperties next to applicators (not modelled)', () => {
  const composed = (keys: readonly string[], extra: JsonObject = {}): JsonObject => ({
    allOf: [{ properties: Object.fromEntries(keys.map((key) => [key, string])) }],
    unevaluatedProperties: false,
    ...extra,
  });

  it('makes removing a property from a member unknown', () => {
    expect(triples(composed(['a', 'b']), composed(['a']), 'input')).toEqual([
      ['unknown', 'property-removed', '$.b'],
    ]);
  });

  it('makes adding or removing members unknown, even always-true ones', () => {
    const before = { allOf: [{ properties: { a: string } }], unevaluatedProperties: false };
    const after = {
      allOf: [{ properties: { a: string } }, { properties: { b: {} } }],
      unevaluatedProperties: false,
    };
    expect(triples(before, after, 'output')).toEqual([['unknown', 'composition-changed', '$']]);
    expect(triples(after, before, 'input')).toEqual([['unknown', 'composition-changed', '$']]);
  });

  it('keeps proven verdicts that only add evaluated properties', () => {
    expect(triples(composed(['a']), composed(['a', 'b']), 'input')).toEqual([
      ['non-breaking', 'property-added', '$.b'],
    ]);
    // Changes below the location are not affected by it.
    const deep = (maximum: number): JsonObject => ({
      allOf: [{ properties: { a: { type: 'integer', maximum } } }],
      unevaluatedProperties: false,
    });
    expect(triples(deep(5), deep(3), 'input')).toEqual([
      ['breaking', 'constraint-tightened', '$.a'],
    ]);
  });

  it('does not use containment between anyOf alternatives', () => {
    const before = {
      anyOf: [string, { type: 'object', properties: { a: string } }],
      unevaluatedProperties: false,
    };
    const after = { anyOf: [string], unevaluatedProperties: false };
    expect(triples(before, after, 'output')).toEqual([
      ['non-breaking', 'alternatives-removed', '$'],
    ]);
    const covered = {
      anyOf: [{}, { type: 'object', properties: { a: string } }],
      unevaluatedProperties: false,
    };
    expect(triples(covered, { anyOf: [{}], unevaluatedProperties: false }, 'input')).toEqual([
      ['unknown', 'alternatives-removed', '$'],
    ]);
  });

  it('distinguishes an absent additionalProperties from an explicit true', () => {
    const member = (additional: JsonObject | boolean | undefined): JsonObject => ({
      allOf: [
        {
          properties: { a: string },
          ...(additional === undefined ? {} : { additionalProperties: additional }),
        },
      ],
      unevaluatedProperties: false,
    });
    expect(triples(member(undefined), member(true), 'output')).toEqual([
      ['non-breaking', 'additional-properties-allowed', '$'],
    ]);
    expect(triples(member(true), member(undefined), 'input')).toEqual([
      ['unknown', 'keyword-changed', '$'],
    ]);
    expect(triples(member(string), member(undefined), 'input')).toEqual([
      ['unknown', 'keyword-changed', '$'],
    ]);
  });

  it('treats a schema-valued unevaluatedProperties as accepting undeclared properties (A1)', () => {
    const before = {
      anyOf: [{ properties: { a: string } }],
      unevaluatedProperties: string,
    };
    const after = {
      anyOf: [{ properties: { a: string, b: integer } }],
      unevaluatedProperties: string,
    };
    expect(triples(before, after, 'input')).toEqual([['unknown', 'property-added', '$.b']]);
  });

  it('does not apply A2 to results whose undeclared fields it typed', () => {
    // Found by the property test: old results could contain `c`, as a string.
    const typed = {
      type: 'object',
      allOf: [{ properties: { a: string } }],
      unevaluatedProperties: string,
    };
    expect(triples(typed, { ...typed, properties: { c: {} } }, 'output')).toEqual([
      ['unknown', 'property-added', '$.c'],
    ]);
    // With `false`, old results had no such field, so A2 applies.
    const closedOff = { ...typed, unevaluatedProperties: false };
    expect(triples(closedOff, { ...closedOff, properties: { c: {} } }, 'output')).toEqual([
      ['non-breaking', 'property-added', '$.c'],
    ]);
    const member = (additional: JsonObject): JsonObject => ({
      ...typed,
      allOf: [{ properties: { a: string }, ...additional }],
    });
    expect(triples(member({}), member({ additionalProperties: true }), 'output')).toEqual([
      ['unknown', 'keyword-changed', '$'],
    ]);
  });

  it('reports changes to the keyword itself as unknown', () => {
    expect(
      triples(composed(['a']), composed(['a'], { unevaluatedProperties: string }), 'input'),
    ).toEqual([['unknown', 'keyword-changed', '$']]);
  });
});

describe('unevaluatedItems', () => {
  const tuple = (items: readonly JsonObject[], extra: JsonObject = {}): JsonObject => ({
    type: 'array',
    prefixItems: [...items],
    unevaluatedItems: false,
    ...extra,
  });

  it('is the schema for items after the prefix when nothing else evaluates them', () => {
    expect(triples(tuple([string, string]), tuple([string]), 'input')).toEqual([
      ['breaking', 'schema-narrowed', '$[1]'],
    ]);
    expect(triples(tuple([string]), tuple([string, string]), 'input')).toEqual([
      ['non-breaking', 'schema-widened', '$[1]'],
    ]);
    expect(triples(tuple([string]), tuple([string, string]), 'output')).toEqual([
      ['breaking', 'schema-widened', '$[1]'],
    ]);
  });

  it('is not modelled next to contains', () => {
    const contains = { contains: string };
    expect(triples(tuple([string, string], contains), tuple([string], contains), 'input')).toEqual([
      ['unknown', 'keyword-changed', '$[1]'],
    ]);
  });

  it('is irrelevant when items evaluates everything', () => {
    expect(
      triples(tuple([string, string], { items: true }), tuple([string], { items: true }), 'input'),
    ).toEqual([['non-breaking', 'type-widened', '$[1]']]);
  });
});
