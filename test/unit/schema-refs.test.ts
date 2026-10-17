import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../src/core/json.ts';
import { diffSchemas } from '../../src/diff/schema.ts';
import { triples } from '../helpers/schema.ts';

function tree(valueSchema: JsonValue): JsonValue {
  return {
    $ref: '#/$defs/node',
    $defs: {
      node: {
        type: 'object',
        properties: {
          value: valueSchema,
          children: { type: 'array', items: { $ref: '#/$defs/node' } },
        },
        required: ['value'],
      },
    },
  };
}

describe('$ref and $defs', () => {
  it('follows local references into $defs', () => {
    const before = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/A' } },
      $defs: { A: { type: 'string' } },
    };
    const after = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/A' } },
      $defs: { A: { type: 'integer' } },
    };
    expect(triples(before, after, 'input')).toEqual([
      ['breaking', 'type-narrowed', '$.a'],
      ['non-breaking', 'type-widened', '$.a'],
    ]);
  });

  it('supports draft-07 definitions and escaped JSON Pointers', () => {
    const before = { $ref: '#/definitions/a~1b~0c', definitions: { 'a/b~c': { enum: [1, 2] } } };
    const after = { $ref: '#/definitions/a~1b~0c', definitions: { 'a/b~c': { enum: [1] } } };
    expect(triples(before, after, 'input')).toEqual([['breaking', 'enum-narrowed', '$']]);
  });

  it('resolves percent-encoded pointers', () => {
    const before = { $ref: '#/$defs/with%20space', $defs: { 'with space': { type: 'string' } } };
    const after = { type: 'string' };
    expect(triples(before, after, 'input')).toEqual([]);
  });

  it('inlining a definition is not a change', () => {
    const before = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/A' } },
      $defs: { A: { type: 'string', maxLength: 3 } },
    };
    const after = { type: 'object', properties: { a: { type: 'string', maxLength: 3 } } };
    expect(triples(before, after, 'input')).toEqual([]);
  });

  it('terminates on recursive schemas and reports a change once', () => {
    expect(
      triples(tree({ type: 'integer' }), tree({ type: 'integer', minimum: 0 }), 'input'),
    ).toEqual([['breaking', 'constraint-tightened', '$.value']]);
  });

  it('finds no changes between identical recursive schemas', () => {
    expect(
      diffSchemas(tree({ type: 'string' }), tree({ type: 'string' }), { direction: 'output' }),
    ).toEqual([]);
  });

  it('handles mutually recursive definitions', () => {
    const schema = (leaf: JsonValue): JsonValue => ({
      $ref: '#/$defs/a',
      $defs: {
        a: { type: 'object', properties: { b: { $ref: '#/$defs/b' }, leaf } },
        b: { type: 'object', properties: { a: { $ref: '#/$defs/a' } } },
      },
    });
    expect(triples(schema({ type: 'string' }), schema({ type: 'number' }), 'output')).toEqual([
      ['non-breaking', 'type-narrowed', '$.leaf'],
      ['breaking', 'type-widened', '$.leaf'],
    ]);
  });

  it('supports a reference to the document root', () => {
    const schema = (max: number): JsonValue => ({
      type: 'object',
      properties: { next: { $ref: '#' }, n: { type: 'integer', maximum: max } },
    });
    expect(triples(schema(5), schema(3), 'input')).toEqual([
      ['breaking', 'constraint-tightened', '$.n'],
    ]);
  });

  it('keeps annotations written next to a $ref', () => {
    const before = {
      properties: { a: { $ref: '#/$defs/A', description: 'old' } },
      $defs: { A: { type: 'string' } },
    };
    const after = {
      properties: { a: { $ref: '#/$defs/A', description: 'new' } },
      $defs: { A: { type: 'string' } },
    };
    expect(triples(before, after, 'input')).toEqual([
      ['non-breaking', 'description-changed', '$.a'],
    ]);
  });

  it('applies constraints written next to a $ref, as 2020-12 does', () => {
    const before = { $ref: '#/$defs/A', $defs: { A: { type: 'string' } } };
    const after = { $ref: '#/$defs/A', maxLength: 3, $defs: { A: { type: 'string' } } };
    expect(triples(before, after, 'input')).toEqual([['breaking', 'constraint-tightened', '$']]);
  });

  it('keeps interacting keywords next to a $ref as an implicit allOf', () => {
    // additionalProperties next to the $ref does not see the target's properties.
    const defs = { A: { type: 'object', properties: { a: { type: 'string' } } } };
    const before = { $ref: '#/$defs/A', $defs: defs };
    const after = { $ref: '#/$defs/A', additionalProperties: false, $defs: defs };
    expect(triples(before, after, 'input')).toEqual([['breaking', 'subschema-added', '$']]);
  });

  it('never fetches remote references and reports their changes as unknown', () => {
    const [change] = diffSchemas(
      { $ref: 'https://example.com/a.json' },
      { $ref: 'https://example.com/b.json' },
      { direction: 'input' },
    );
    expect(change).toMatchObject({ severity: 'unknown', code: 'ref-unresolved' });
    expect(change?.message).toContain('not dereferenced');
    expect(
      triples(
        { $ref: 'https://example.com/a.json' },
        { $ref: 'https://example.com/a.json' },
        'input',
      ),
    ).toEqual([]);
  });

  it('reports a reference that stopped resolving', () => {
    const before = { $ref: '#/$defs/A', $defs: { A: { type: 'string' } } };
    const after = { $ref: '#/$defs/A', $defs: {} };
    expect(triples(before, after, 'input')).toEqual([['unknown', 'ref-unresolved', '$']]);
  });

  it('reports anchors and self-aliasing references as unresolvable', () => {
    expect(triples({ $ref: '#anchor' }, { type: 'string' }, 'input')).toEqual([
      ['unknown', 'ref-unresolved', '$'],
    ]);
    const alias = { $ref: '#/$defs/a', $defs: { a: { $ref: '#/$defs/a' } } };
    expect(triples(alias, { type: 'string' }, 'input')).toEqual([
      ['unknown', 'ref-unresolved', '$'],
    ]);
    expect(triples({ $ref: '#/%E0%A4%A' }, { type: 'string' }, 'input')).toEqual([
      ['unknown', 'ref-unresolved', '$'],
    ]);
    expect(triples({ $ref: '#/items/x' }, { type: 'string' }, 'input')).toEqual([
      ['unknown', 'ref-unresolved', '$'],
    ]);
  });

  it('resolves pointers through arrays', () => {
    const before = { anyOf: [{ type: 'string' }], properties: { a: { $ref: '#/anyOf/0' } } };
    const after = { anyOf: [{ type: 'string' }], properties: { a: { type: 'integer' } } };
    expect(triples(before, after, 'input')).toEqual([
      ['breaking', 'type-narrowed', '$.a'],
      ['non-breaking', 'type-widened', '$.a'],
    ]);
  });
});
