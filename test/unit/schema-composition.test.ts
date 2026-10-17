import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../../src/core/json.ts';
import { diffSchemas } from '../../src/diff/schema.ts';
import { object, triples } from '../helpers/schema.ts';

const string = { type: 'string' };
const integer = { type: 'integer' };
const nul = { type: 'null' };

describe('anyOf', () => {
  it('treats a plain schema turning into a union as adding alternatives', () => {
    expect(triples(string, { anyOf: [string, nul] }, 'input')).toEqual([
      ['non-breaking', 'alternatives-added', '$'],
    ]);
    expect(triples(string, { anyOf: [string, nul] }, 'output')).toEqual([
      ['breaking', 'alternatives-added', '$'],
    ]);
  });

  it('treats a union collapsing to one alternative as removing alternatives', () => {
    expect(triples({ anyOf: [string, nul] }, string, 'input')).toEqual([
      ['breaking', 'alternatives-removed', '$'],
    ]);
    expect(triples({ anyOf: [string, nul] }, string, 'output')).toEqual([
      ['non-breaking', 'alternatives-removed', '$'],
    ]);
  });

  it('considers a type array and the equivalent anyOf identical', () => {
    expect(triples({ type: ['string', 'null'] }, { anyOf: [string, nul] }, 'input')).toEqual([]);
    expect(triples({ anyOf: [nul, string] }, { type: ['string', 'null'] }, 'output')).toEqual([]);
  });

  it('ignores reordered alternatives', () => {
    expect(
      triples({ anyOf: [string, integer, nul] }, { anyOf: [nul, string, integer] }, 'input'),
    ).toEqual([]);
  });

  it('compares a single changed alternative in detail', () => {
    const before = { anyOf: [{ type: 'string', maxLength: 10 }, nul] };
    const after = { anyOf: [{ type: 'string', maxLength: 5 }, nul] };
    const [change] = diffSchemas(before, after, { direction: 'input' });
    expect(change).toMatchObject({ severity: 'breaking', code: 'constraint-tightened' });
    expect(change?.message).toMatch(/^anyOf alternative string: maxLength tightened/);
  });

  it('accepts removing an alternative that another one already covers', () => {
    const before = { anyOf: [string, { type: 'string', maxLength: 3 }] };
    expect(triples(before, { anyOf: [string] }, 'input')).toEqual([
      ['non-breaking', 'alternatives-removed', '$'],
    ]);
  });

  it('accepts adding a result alternative that an old one already covers', () => {
    const before = { anyOf: [string, nul] };
    const after = { anyOf: [string, nul, { type: 'string', minLength: 2 }] };
    expect(triples(before, after, 'output')).toEqual([['non-breaking', 'alternatives-added', '$']]);
  });

  it('proves compatibility when several alternatives change but each is covered', () => {
    const before = {
      anyOf: [
        { type: 'string', maxLength: 3 },
        { type: 'integer', maximum: 3 },
      ],
    };
    const after = { anyOf: [string, integer, nul] };
    expect(triples(before, after, 'input')).toEqual([
      ['non-breaking', 'alternatives-changed', '$'],
    ]);
  });

  it('reports unknown when several alternatives change and coverage cannot be proven', () => {
    const before = { anyOf: [string, integer] };
    const after = {
      anyOf: [{ type: 'string', maxLength: 3 }, { type: 'integer', maximum: 3 }, nul],
    };
    expect(triples(before, after, 'input')).toEqual([['unknown', 'alternatives-changed', '$']]);
  });

  it('reports an anyOf constraint appearing next to other keywords', () => {
    const before = object({ a: string });
    const after = { ...object({ a: string }), anyOf: [{ required: ['a'] }, { required: ['b'] }] };
    expect(triples(before, after, 'input')).toEqual([['breaking', 'subschema-added', '$']]);
  });

  it('ignores an anyOf whose alternatives include an unconstrained schema', () => {
    const before = object({ a: string });
    const after = { ...object({ a: string }), anyOf: [{}, { required: ['b'] }] };
    expect(triples(before, after, 'input')).toEqual([]);
  });
});

describe('oneOf', () => {
  const variant = (kind: string): JsonObject =>
    object({ kind: { const: kind } }, { required: ['kind'] });

  it('never claims an added alternative is safe for inputs', () => {
    expect(
      triples(
        { oneOf: [variant('a'), variant('b')] },
        { oneOf: [variant('a'), variant('b'), variant('c')] },
        'input',
      ),
    ).toEqual([['unknown', 'alternatives-added', '$']]);
  });

  it('still reports removed alternatives in inputs as breaking', () => {
    expect(
      triples({ oneOf: [variant('a'), variant('b')] }, { oneOf: [variant('a')] }, 'input'),
    ).toEqual([['breaking', 'alternatives-removed', '$']]);
  });

  it('turns would-be compatible detail changes into unknown', () => {
    const before = { oneOf: [{ type: 'string', maxLength: 3 }, integer] };
    const after = { oneOf: [string, integer] };
    const [change] = diffSchemas(before, after, { direction: 'input' });
    expect(change?.severity).toBe('unknown');
    expect(change?.message).toContain('exactly one alternative');
  });

  it('keeps breaking detail changes breaking', () => {
    const before = { oneOf: [string, integer] };
    const after = { oneOf: [{ type: 'string', maxLength: 3 }, integer] };
    expect(triples(before, after, 'input')).toEqual([['breaking', 'constraint-tightened', '$']]);
  });

  it('does not treat oneOf with an unconstrained alternative as vacuous', () => {
    // oneOf: [{}, X] means "not X".
    expect(triples({}, { oneOf: [{}, string] }, 'input')).toEqual([
      ['unknown', 'alternatives-added', '$'],
    ]);
  });

  it('classifies anyOf -> oneOf over the same alternatives as narrowing', () => {
    expect(triples({ anyOf: [string, integer] }, { oneOf: [string, integer] }, 'input')).toEqual([
      ['breaking', 'composition-changed', '$'],
    ]);
    expect(triples({ oneOf: [string, integer] }, { anyOf: [string, integer] }, 'input')).toEqual([
      ['non-breaking', 'composition-changed', '$'],
    ]);
    expect(triples({ anyOf: [string, integer] }, { oneOf: [string, nul] }, 'input')).toEqual([
      ['unknown', 'composition-changed', '$'],
    ]);
  });
});

describe('allOf', () => {
  it('treats an added subschema as narrowing and a removed one as widening', () => {
    expect(
      triples(
        { allOf: [object({ a: string })] },
        { allOf: [object({ a: string }), { required: ['a'] }] },
        'input',
      ),
    ).toEqual([['breaking', 'subschema-added', '$']]);
    expect(
      triples(
        { allOf: [object({ a: string }), { required: ['a'] }] },
        { allOf: [object({ a: string })] },
        'input',
      ),
    ).toEqual([['non-breaking', 'subschema-removed', '$']]);
  });

  it('ignores annotation-only subschemas', () => {
    expect(
      triples({ allOf: [string] }, { allOf: [string, { description: 'docs' }] }, 'input'),
    ).toEqual([]);
  });

  it('compares a single changed subschema in detail', () => {
    expect(
      triples(
        { allOf: [{ type: 'string', maxLength: 5 }] },
        { allOf: [{ type: 'string', maxLength: 9 }] },
        'input',
      ),
    ).toEqual([['non-breaking', 'constraint-loosened', '$']]);
  });

  it('reports unknown when it cannot pair several changed subschemas', () => {
    const before = { allOf: [{ minLength: 1 }, { maxLength: 9 }] };
    const after = { allOf: [{ minLength: 2 }, { maxLength: 8 }] };
    expect(triples(before, after, 'input')).toEqual([['unknown', 'composition-changed', '$']]);
  });
});

describe('assumption A1 is judged per instance location', () => {
  it('does not assume a property is unsent when another alternative declares it', () => {
    const before = { anyOf: [object({ c: string }), integer] };
    const after = { ...before, properties: { c: integer } };
    expect(triples(before, after, 'input')).toEqual([['unknown', 'property-added', '$.c']]);
  });

  it('does not assume a property is unsent when a sibling allOf member declares it', () => {
    const before = { allOf: [{ type: 'object' }, object({ c: {} })] };
    const after = { allOf: [object({ c: { type: 'boolean' } }), object({ c: {} })] };
    expect(triples(before, after, 'input')).toEqual([['unknown', 'property-added', '$.c']]);
  });

  it('does not assume a property is unsent when a map type accepts any key', () => {
    const before = { anyOf: [{ type: 'object', additionalProperties: string }, integer] };
    const after = { ...before, properties: { c: integer } };
    expect(triples(before, after, 'input')).toEqual([['unknown', 'property-added', '$.c']]);
  });

  it('applies A1 inside a nullable object, where no other alternative exists', () => {
    const before = { anyOf: [object({ a: string }), nul] };
    const after = { anyOf: [object({ a: string, b: string }), nul] };
    const [change] = diffSchemas(before, after, { direction: 'input' });
    expect(change).toMatchObject({ severity: 'non-breaking', code: 'property-added', path: '$.b' });
  });
});
