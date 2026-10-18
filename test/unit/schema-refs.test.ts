import { describe, expect, it } from 'vitest';
import type { JsonObject, JsonValue } from '../../src/core/json.ts';
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

  it('reports unknown anchors and self-aliasing references as unresolvable', () => {
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

  it('terminates on recursive references that carry constraints of their own', () => {
    // Each visit used to synthesise a fresh object for `{$ref, maxItems}`, so
    // the cycle check never closed and the stack overflowed.
    const list = (extra: JsonObject): JsonValue => ({
      type: 'object',
      properties: { tags: { $ref: '#/$defs/List' } },
      $defs: {
        List: {
          type: 'array',
          items: { anyOf: [{ type: 'string' }, { $ref: '#/$defs/List', maxItems: 5 }] },
          ...extra,
        },
      },
    });
    for (const maxSteps of [200, 2_000, 20_000]) {
      const changes = diffSchemas(list({}), list({ minItems: 1 }), {
        direction: 'input',
        maxSteps,
      });
      expect(changes.map((change) => change.code)).not.toContain('schema-too-complex');
      expect(changes).toContainEqual(
        expect.objectContaining({ severity: 'breaking', path: '$.tags' }),
      );
    }
    expect(diffSchemas(list({}), list({}), { direction: 'input' })).toEqual([]);
  });

  it('stops at a nesting depth limit instead of overflowing the stack', () => {
    let before: JsonValue = { type: 'string' };
    let after: JsonValue = { type: 'string', maxLength: 1 };
    for (let level = 0; level < 5_000; level += 1) {
      before = { type: 'object', properties: { a: before } };
      after = { type: 'object', properties: { a: after } };
    }
    const changes = diffSchemas(before, after, { direction: 'input', maxSteps: 1_000_000 });
    expect(changes.at(-1)).toMatchObject({ severity: 'unknown', code: 'schema-too-complex' });
    expect(changes.at(-1)?.message).toContain('nesting depth');
  });

  it('follows $anchor references and reports changes to their targets', () => {
    const anchored = (type: string): JsonValue => ({
      type: 'object',
      properties: { a: { $ref: '#item' } },
      $defs: { item: { $anchor: 'item', type } },
    });
    expect(triples(anchored('string'), anchored('integer'), 'input')).toEqual([
      ['breaking', 'type-narrowed', '$.a'],
      ['non-breaking', 'type-widened', '$.a'],
    ]);
    expect(triples(anchored('string'), anchored('string'), 'input')).toEqual([]);
  });

  it('follows draft-07 plain-name fragments in $id', () => {
    const anchored = (maximum: number): JsonValue => ({
      properties: { n: { $ref: '#count' } },
      definitions: { count: { $id: '#count', type: 'integer', maximum } },
    });
    expect(triples(anchored(10), anchored(5), 'input')).toEqual([
      ['breaking', 'constraint-tightened', '$.n'],
    ]);
  });

  it('resolves absolute references to the document and to embedded resources', () => {
    const absolute = (type: string): JsonValue => ({
      $id: 'https://example.com/root.json',
      type: 'object',
      properties: { a: { $ref: 'https://example.com/root.json#/$defs/item' } },
      $defs: { item: { type } },
    });
    expect(triples(absolute('string'), absolute('integer'), 'input')).toEqual([
      ['breaking', 'type-narrowed', '$.a'],
      ['non-breaking', 'type-widened', '$.a'],
    ]);
    const embedded = (type: string): JsonValue => ({
      type: 'object',
      properties: { a: { $ref: 'item.json' } },
      $defs: { item: { $id: 'item.json', type } },
    });
    expect(triples(embedded('string'), embedded('integer'), 'input')).toEqual([
      ['breaking', 'type-narrowed', '$.a'],
      ['non-breaking', 'type-widened', '$.a'],
    ]);
  });

  it('resolves JSON Pointers against the enclosing schema resource', () => {
    const nested = (type: string): JsonValue => ({
      $defs: {
        A: { type: 'string' },
        resource: {
          $id: 'https://example.com/r.json',
          properties: { x: { $ref: '#/$defs/A' } },
          $defs: { A: { type } },
        },
      },
      $ref: 'https://example.com/r.json',
    });
    // `#/$defs/A` inside the embedded resource is the resource's own A.
    expect(triples(nested('string'), nested('integer'), 'input')).toEqual([
      ['breaking', 'type-narrowed', '$.x'],
      ['non-breaking', 'type-widened', '$.x'],
    ]);
  });

  it('notices when a changed base URI makes a reference point elsewhere', () => {
    const schema = (id: string): JsonValue => ({
      $id: id,
      properties: { a: { $ref: 'item.json' } },
      $defs: { item: { $id: 'https://a.example/item.json', type: 'string' } },
    });
    expect(
      triples(
        schema('https://a.example/root.json'),
        schema('https://b.example/root.json'),
        'input',
      ),
    ).toEqual([['unknown', 'ref-unresolved', '$.a']]);
  });

  it('reports an unchanged reference it cannot follow when the documents differ elsewhere', () => {
    const invalid = (maximum: number): JsonValue => ({
      properties: { a: { $ref: '#/%E0%A4%A' }, n: { type: 'integer', maximum } },
    });
    expect(triples(invalid(5), invalid(5), 'input')).toEqual([]);
    expect(triples(invalid(5), invalid(3), 'input')).toEqual([
      ['unknown', 'ref-unresolved', '$.a'],
      ['breaking', 'constraint-tightened', '$.n'],
    ]);
    // A reference to another document means the same thing on both sides.
    const remote = (maximum: number): JsonValue => ({
      properties: { a: { $ref: 'https://example.com/a.json' }, n: { type: 'integer', maximum } },
    });
    expect(triples(remote(5), remote(3), 'input')).toEqual([
      ['breaking', 'constraint-tightened', '$.n'],
    ]);
    // ...unless draft-04 `id`s, which are not indexed, might be what it points at.
    const legacyIds = (maximum: number): JsonValue => ({
      properties: { a: { $ref: 'item.json' }, n: { type: 'integer', maximum } },
      definitions: { item: { id: 'item.json', type: 'string' } },
    });
    expect(triples(legacyIds(5), legacyIds(3), 'input')).toEqual([
      ['unknown', 'ref-unresolved', '$.a'],
      ['breaking', 'constraint-tightened', '$.n'],
    ]);
  });

  it('reports an unchanged $dynamicRef as unknown when the documents differ', () => {
    const dynamic = (type: string): JsonValue => ({
      $id: 'https://example.com/d',
      type: 'object',
      properties: { a: { $dynamicRef: '#item' } },
      $defs: { item: { $dynamicAnchor: 'item', type } },
    });
    expect(triples(dynamic('string'), dynamic('string'), 'input')).toEqual([]);
    expect(triples(dynamic('string'), dynamic('integer'), 'input')).toEqual([
      ['unknown', 'ref-unresolved', '$.a'],
    ]);
  });

  it('keeps constraints next to a $ref inside the scope of unevaluatedProperties', () => {
    // `unevaluatedProperties` next to `$ref` sees what the target evaluates.
    const schema = (keys: readonly string[]): JsonValue => ({
      $ref: '#/$defs/Base',
      properties: { extra: { type: 'string' } },
      unevaluatedProperties: false,
      $defs: {
        Base: {
          type: 'object',
          properties: Object.fromEntries(keys.map((key) => [key, { type: 'string' }])),
        },
      },
    });
    expect(triples(schema(['a', 'b']), schema(['a', 'b']), 'input')).toEqual([]);
    expect(triples(schema(['a', 'b']), schema(['a']), 'input')).toEqual([
      ['unknown', 'property-removed', '$.b'],
    ]);
  });
});
