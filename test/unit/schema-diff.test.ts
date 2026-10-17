import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../src/core/json.ts';
import type { SchemaDirection } from '../../src/diff/model.ts';
import { diffSchemas } from '../../src/diff/schema.ts';
import { object, triples, type Triple } from '../helpers/schema.ts';

interface Case {
  readonly name: string;
  readonly before: JsonValue;
  readonly after: JsonValue;
  readonly input: readonly Triple[];
  readonly output: readonly Triple[];
}

const integer = { type: 'integer' };
const string = { type: 'string' };

/**
 * Every case is checked in both directions: what breaks a request is usually
 * fine for a result and vice versa.
 */
const cases: readonly Case[] = [
  // --- types ---------------------------------------------------------------
  {
    name: 'type changed to an unrelated type',
    before: string,
    after: integer,
    input: [
      ['breaking', 'type-narrowed', '$'],
      ['non-breaking', 'type-widened', '$'],
    ],
    output: [
      ['non-breaking', 'type-narrowed', '$'],
      ['breaking', 'type-widened', '$'],
    ],
  },
  {
    name: 'integer widened to number',
    before: integer,
    after: { type: 'number' },
    input: [['non-breaking', 'type-widened', '$']],
    output: [['breaking', 'type-widened', '$']],
  },
  {
    name: 'number narrowed to integer',
    before: { type: 'number' },
    after: integer,
    input: [['breaking', 'type-narrowed', '$']],
    output: [['non-breaking', 'type-narrowed', '$']],
  },
  {
    name: 'nullable added via a type array',
    before: string,
    after: { type: ['string', 'null'] },
    input: [['non-breaking', 'type-widened', '$']],
    output: [['breaking', 'type-widened', '$']],
  },
  {
    name: 'type constraint added to an unconstrained schema',
    before: {},
    after: string,
    input: [['breaking', 'type-narrowed', '$']],
    output: [['non-breaking', 'type-narrowed', '$']],
  },
  {
    name: 'type constraint removed',
    before: string,
    after: {},
    input: [['non-breaking', 'type-widened', '$']],
    output: [['breaking', 'type-widened', '$']],
  },
  {
    name: 'type array reordered',
    before: { type: ['string', 'null'] },
    after: { type: ['null', 'string'] },
    input: [],
    output: [],
  },
  // --- enum / const ----------------------------------------------------------
  {
    name: 'enum value removed',
    before: { enum: ['a', 'b'] },
    after: { enum: ['a'] },
    input: [['breaking', 'enum-narrowed', '$']],
    output: [['non-breaking', 'enum-narrowed', '$']],
  },
  {
    name: 'enum value added',
    before: { enum: ['a'] },
    after: { enum: ['a', 'b'] },
    input: [['non-breaking', 'enum-widened', '$']],
    output: [['breaking', 'enum-widened', '$']],
  },
  {
    name: 'enum reordered',
    before: { enum: ['a', 'b'] },
    after: { enum: ['b', 'a'] },
    input: [],
    output: [],
  },
  {
    name: 'const replaced by an equivalent single-value enum',
    before: { const: 'x' },
    after: { enum: ['x'] },
    input: [],
    output: [],
  },
  {
    name: 'enum restriction added to a string',
    before: string,
    after: { type: 'string', enum: ['a'] },
    input: [['breaking', 'enum-narrowed', '$']],
    output: [['non-breaking', 'enum-narrowed', '$']],
  },
  {
    name: 'enum restriction removed',
    before: { type: 'string', enum: ['a'] },
    after: string,
    input: [['non-breaking', 'enum-widened', '$']],
    output: [['breaking', 'enum-widened', '$']],
  },
  {
    name: 'enum values that type excludes do not count',
    before: { type: 'integer', enum: [1, 1.5] },
    after: { type: 'number', enum: [1, 1.5] },
    input: [['non-breaking', 'enum-widened', '$']],
    output: [['breaking', 'enum-widened', '$']],
  },
  {
    name: 'objects inside enums compare structurally',
    before: { enum: [{ a: 1, b: 2 }] },
    after: { enum: [{ b: 2, a: 1 }] },
    input: [],
    output: [],
  },
  // --- numeric bounds --------------------------------------------------------
  {
    name: 'maximum lowered',
    before: { type: 'integer', maximum: 100 },
    after: { type: 'integer', maximum: 50 },
    input: [['breaking', 'constraint-tightened', '$']],
    output: [['non-breaking', 'constraint-tightened', '$']],
  },
  {
    name: 'minimum lowered',
    before: { type: 'integer', minimum: 5 },
    after: { type: 'integer', minimum: 0 },
    input: [['non-breaking', 'constraint-loosened', '$']],
    output: [['breaking', 'constraint-loosened', '$']],
  },
  {
    name: 'inclusive minimum made exclusive at the same value',
    before: { type: 'number', minimum: 0 },
    after: { type: 'number', exclusiveMinimum: 0 },
    input: [['breaking', 'constraint-tightened', '$']],
    output: [['non-breaking', 'constraint-tightened', '$']],
  },
  {
    name: 'draft-04 boolean exclusiveMaximum',
    before: { type: 'number', maximum: 10 },
    after: { type: 'number', maximum: 10, exclusiveMaximum: true },
    input: [['breaking', 'constraint-tightened', '$']],
    output: [['non-breaking', 'constraint-tightened', '$']],
  },
  {
    name: 'bound added and removed',
    before: { type: 'number', minimum: 1 },
    after: { type: 'number', maximum: 9 },
    input: [
      ['non-breaking', 'constraint-loosened', '$'],
      ['breaking', 'constraint-tightened', '$'],
    ],
    output: [
      ['breaking', 'constraint-loosened', '$'],
      ['non-breaking', 'constraint-tightened', '$'],
    ],
  },
  {
    name: 'multipleOf relaxed to a divisor',
    before: { type: 'number', multipleOf: 10 },
    after: { type: 'number', multipleOf: 5 },
    input: [['non-breaking', 'constraint-loosened', '$']],
    output: [['breaking', 'constraint-loosened', '$']],
  },
  {
    name: 'multipleOf tightened to a multiple',
    before: { type: 'number', multipleOf: 0.5 },
    after: { type: 'number', multipleOf: 1.5 },
    input: [['breaking', 'constraint-tightened', '$']],
    output: [['non-breaking', 'constraint-tightened', '$']],
  },
  {
    name: 'multipleOf changed incomparably',
    before: { type: 'integer', multipleOf: 2 },
    after: { type: 'integer', multipleOf: 3 },
    input: [['breaking', 'constraint-changed', '$']],
    output: [['breaking', 'constraint-changed', '$']],
  },
  {
    name: 'numeric keywords are ignored when no numbers are accepted',
    before: { type: 'string', maximum: 3 },
    after: { type: 'string', maximum: 1 },
    input: [],
    output: [],
  },
  // --- strings ---------------------------------------------------------------
  {
    name: 'maxLength raised',
    before: { type: 'string', maxLength: 200 },
    after: { type: 'string', maxLength: 500 },
    input: [['non-breaking', 'constraint-loosened', '$']],
    output: [['breaking', 'constraint-loosened', '$']],
  },
  {
    name: 'minLength added',
    before: string,
    after: { type: 'string', minLength: 1 },
    input: [['breaking', 'constraint-tightened', '$']],
    output: [['non-breaking', 'constraint-tightened', '$']],
  },
  {
    name: 'pattern added',
    before: string,
    after: { type: 'string', pattern: '^a' },
    input: [['breaking', 'constraint-tightened', '$']],
    output: [['non-breaking', 'constraint-tightened', '$']],
  },
  {
    name: 'pattern removed',
    before: { type: 'string', pattern: '^a' },
    after: string,
    input: [['non-breaking', 'constraint-loosened', '$']],
    output: [['breaking', 'constraint-loosened', '$']],
  },
  {
    name: 'pattern changed is undecidable',
    before: { type: 'string', pattern: '^a' },
    after: { type: 'string', pattern: '^b' },
    input: [['unknown', 'constraint-changed', '$']],
    output: [['unknown', 'constraint-changed', '$']],
  },
  {
    name: 'format changed is undecidable',
    before: { type: 'string', format: 'email' },
    after: { type: 'string', format: 'uri' },
    input: [['unknown', 'constraint-changed', '$']],
    output: [['unknown', 'constraint-changed', '$']],
  },
  // --- objects -----------------------------------------------------------------
  {
    name: 'required property added',
    before: object({ a: string }),
    after: object({ a: string, b: string }, { required: ['b'] }),
    input: [['breaking', 'required-property-added', '$.b']],
    output: [['non-breaking', 'required-property-added', '$.b']],
  },
  {
    name: 'optional property added (assumptions A1 and A2)',
    before: object({ a: string }),
    after: object({ a: string, b: string }),
    input: [['non-breaking', 'property-added', '$.b']],
    output: [['non-breaking', 'property-added', '$.b']],
  },
  {
    name: 'optional property added where additionalProperties was false',
    before: object({ a: string }, { additionalProperties: false }),
    after: object({ a: string, b: string }, { additionalProperties: false }),
    input: [['non-breaking', 'property-added', '$.b']],
    output: [['non-breaking', 'property-added', '$.b']],
  },
  {
    name: 'property removed under additionalProperties: false',
    before: object({ a: string, b: string }, { additionalProperties: false }),
    after: object({ a: string }, { additionalProperties: false }),
    input: [['breaking', 'property-removed', '$.b']],
    output: [['breaking', 'property-removed', '$.b']],
  },
  {
    name: 'property removed while extra properties stay allowed',
    before: object({ a: string, b: string }),
    after: object({ a: string }),
    input: [['non-breaking', 'property-removed', '$.b']],
    output: [['breaking', 'property-removed', '$.b']],
  },
  {
    name: 'property became required',
    before: object({ a: string }),
    after: object({ a: string }, { required: ['a'] }),
    input: [['breaking', 'property-required', '$.a']],
    output: [['non-breaking', 'property-required', '$.a']],
  },
  {
    name: 'property became optional',
    before: object({ a: string }, { required: ['a'] }),
    after: object({ a: string }),
    input: [['non-breaking', 'property-optional', '$.a']],
    output: [['breaking', 'property-optional', '$.a']],
  },
  {
    name: 'required order does not matter',
    before: object({ a: string, b: string }, { required: ['a', 'b'] }),
    after: object({ a: string, b: string }, { required: ['b', 'a'] }),
    input: [],
    output: [],
  },
  {
    name: 'additionalProperties restricted',
    before: object({ a: string }),
    after: object({ a: string }, { additionalProperties: false }),
    input: [['breaking', 'additional-properties-restricted', '$']],
    output: [['non-breaking', 'additional-properties-restricted', '$']],
  },
  {
    name: 'additionalProperties allowed again',
    before: object({ a: string }, { additionalProperties: false }),
    after: object({ a: string }),
    input: [['non-breaking', 'additional-properties-allowed', '$']],
    output: [['non-breaking', 'additional-properties-allowed', '$']],
  },
  {
    name: 'map value type narrowed',
    before: { type: 'object', additionalProperties: { type: ['string', 'number'] } },
    after: { type: 'object', additionalProperties: string },
    input: [['breaking', 'type-narrowed', '$.*']],
    output: [['non-breaking', 'type-narrowed', '$.*']],
  },
  {
    name: 'property declared that a map schema used to cover',
    before: { type: 'object', additionalProperties: string },
    after: {
      type: 'object',
      properties: { a: { type: 'string', maxLength: 3 } },
      additionalProperties: string,
    },
    input: [
      ['breaking', 'constraint-tightened', '$.a'],
      ['non-breaking', 'property-added', '$.a'],
    ],
    output: [
      ['non-breaking', 'constraint-tightened', '$.a'],
      ['non-breaking', 'property-added', '$.a'],
    ],
  },
  {
    name: 'nested property changes carry their path',
    before: object({ filter: object({ tags: { type: 'array', items: { enum: ['x', 'y'] } } }) }),
    after: object({ filter: object({ tags: { type: 'array', items: { enum: ['x'] } } }) }),
    input: [['breaking', 'enum-narrowed', '$.filter.tags[*]']],
    output: [['non-breaking', 'enum-narrowed', '$.filter.tags[*]']],
  },
  {
    name: 'names that are not identifiers use bracket paths',
    before: object({ 'odd-name': string }),
    after: object({ 'odd-name': integer }),
    input: [
      ['breaking', 'type-narrowed', '$["odd-name"]'],
      ['non-breaking', 'type-widened', '$["odd-name"]'],
    ],
    output: [
      ['non-breaking', 'type-narrowed', '$["odd-name"]'],
      ['breaking', 'type-widened', '$["odd-name"]'],
    ],
  },
  {
    name: 'minProperties added',
    before: { type: 'object' },
    after: { type: 'object', minProperties: 1 },
    input: [['breaking', 'constraint-tightened', '$']],
    output: [['non-breaking', 'constraint-tightened', '$']],
  },
  {
    name: 'propertyNames constrained',
    before: { type: 'object' },
    after: { type: 'object', propertyNames: { pattern: '^[a-z]+$' } },
    input: [['breaking', 'constraint-tightened', '$ (property names)']],
    output: [['non-breaking', 'constraint-tightened', '$ (property names)']],
  },
  {
    name: 'patternProperties changes are undecidable',
    before: { type: 'object', patternProperties: { '^x-': string } },
    after: { type: 'object', patternProperties: { '^y-': string } },
    input: [['unknown', 'keyword-changed', '$']],
    output: [['unknown', 'keyword-changed', '$']],
  },
  {
    name: 'property added that patternProperties already matched',
    before: { type: 'object', patternProperties: { '^x-': string } },
    after: { type: 'object', patternProperties: { '^x-': string }, properties: { 'x-a': string } },
    input: [['unknown', 'property-added', '$["x-a"]']],
    output: [['unknown', 'property-added', '$["x-a"]']],
  },
  // --- arrays ------------------------------------------------------------------
  {
    name: 'item type narrowed',
    before: { type: 'array', items: { type: ['string', 'integer'] } },
    after: { type: 'array', items: string },
    input: [['breaking', 'type-narrowed', '$[*]']],
    output: [['non-breaking', 'type-narrowed', '$[*]']],
  },
  {
    name: 'maxItems added',
    before: { type: 'array' },
    after: { type: 'array', maxItems: 3 },
    input: [['breaking', 'constraint-tightened', '$']],
    output: [['non-breaking', 'constraint-tightened', '$']],
  },
  {
    name: 'uniqueItems required',
    before: { type: 'array' },
    after: { type: 'array', uniqueItems: true },
    input: [['breaking', 'constraint-tightened', '$']],
    output: [['non-breaking', 'constraint-tightened', '$']],
  },
  {
    name: 'tuple position changed (2020-12 prefixItems)',
    before: { type: 'array', prefixItems: [string, integer] },
    after: { type: 'array', prefixItems: [string, string] },
    input: [
      ['breaking', 'type-narrowed', '$[1]'],
      ['non-breaking', 'type-widened', '$[1]'],
    ],
    output: [
      ['non-breaking', 'type-narrowed', '$[1]'],
      ['breaking', 'type-widened', '$[1]'],
    ],
  },
  {
    name: 'draft-07 tuple form is understood',
    before: { type: 'array', items: [string], additionalItems: false },
    after: { type: 'array', items: [string], additionalItems: true },
    input: [['non-breaking', 'schema-widened', '$[*]']],
    output: [['breaking', 'schema-widened', '$[*]']],
  },
  // --- boolean schemas --------------------------------------------------------
  {
    name: 'false schema opened up',
    before: false,
    after: true,
    input: [['non-breaking', 'schema-widened', '$']],
    output: [['breaking', 'schema-widened', '$']],
  },
  {
    name: 'schema closed down to false',
    before: string,
    after: false,
    input: [['breaking', 'schema-narrowed', '$']],
    output: [['non-breaking', 'schema-narrowed', '$']],
  },
  {
    name: 'true and {} are the same schema',
    before: true,
    after: {},
    input: [],
    output: [],
  },
  // --- annotations ------------------------------------------------------------
  {
    name: 'description changed',
    before: object({ a: { type: 'string', description: 'old' } }),
    after: object({ a: { type: 'string', description: 'new' } }),
    input: [['non-breaking', 'description-changed', '$.a']],
    output: [['non-breaking', 'description-changed', '$.a']],
  },
  {
    name: 'title and examples changed',
    before: { type: 'string', title: 'A', examples: ['x'] },
    after: { type: 'string', title: 'B', examples: ['y'] },
    input: [
      ['non-breaking', 'title-changed', '$'],
      ['non-breaking', 'annotation-changed', '$'],
    ],
    output: [
      ['non-breaking', 'title-changed', '$'],
      ['non-breaking', 'annotation-changed', '$'],
    ],
  },
  {
    name: 'default changed matters only for inputs',
    before: { type: 'integer', default: 10 },
    after: { type: 'integer', default: 20 },
    input: [['unknown', 'default-changed', '$']],
    output: [['non-breaking', 'default-changed', '$']],
  },
  {
    name: 'deprecated',
    before: string,
    after: { type: 'string', deprecated: true },
    input: [['non-breaking', 'deprecated-changed', '$']],
    output: [['non-breaking', 'deprecated-changed', '$']],
  },
  // --- unknown keywords ---------------------------------------------------------
  {
    name: 'unsupported keyword changed',
    before: { type: 'object', not: { required: ['a'] } },
    after: { type: 'object', not: { required: ['b'] } },
    input: [['unknown', 'keyword-changed', '$']],
    output: [['unknown', 'keyword-changed', '$']],
  },
  {
    name: 'unsupported keyword unchanged is fine',
    before: { type: 'object', not: { required: ['a'] } },
    after: { type: 'object', not: { required: ['a'], description: 'docs only' } },
    input: [],
    output: [],
  },
  {
    name: 'x-mcp-header changed',
    before: object({ region: { type: 'string', 'x-mcp-header': 'Region' } }),
    after: object({ region: { type: 'string', 'x-mcp-header': 'Zone' } }),
    input: [['unknown', 'keyword-changed', '$.region']],
    output: [['unknown', 'keyword-changed', '$.region']],
  },
  {
    name: 'dialect changed',
    before: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },
    after: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' },
    input: [['unknown', 'dialect-changed', '$']],
    output: [['unknown', 'dialect-changed', '$']],
  },
  {
    name: 'invalid schema values are flagged',
    before: object({ a: string }),
    after: object({ a: 'string' }),
    input: [['unknown', 'invalid-schema', '$.a']],
    output: [['unknown', 'invalid-schema', '$.a']],
  },
];

describe('diffSchemas rule table', () => {
  for (const testCase of cases) {
    for (const direction of ['input', 'output'] as const satisfies readonly SchemaDirection[]) {
      it(`${testCase.name} (${direction})`, () => {
        expect(triples(testCase.before, testCase.after, direction)).toEqual(testCase[direction]);
      });
    }
  }
});

describe('diffSchemas messages and values', () => {
  it('explains the change and its consequence for the direction', () => {
    const [input] = diffSchemas(
      { type: 'integer', maximum: 100 },
      { type: 'integer', maximum: 50 },
      { direction: 'input' },
    );
    expect(input?.message).toBe(
      'upper bound tightened from <= 100 to <= 50; arguments that were valid before can now be rejected',
    );
    const [output] = diffSchemas({ enum: ['a'] }, { enum: ['a', 'b'] }, { direction: 'output' });
    expect(output?.message).toBe(
      'value "b" now allowed; results can now contain values that clients written against the old schema do not expect',
    );
  });

  it('reports before/after values for scalar keywords', () => {
    const [change] = diffSchemas(
      { type: 'integer', multipleOf: 2 },
      { type: 'integer', multipleOf: 3 },
      { direction: 'input' },
    );
    expect(change).toMatchObject({ before: 2, after: 3 });
  });

  it('uses output wording for result types', () => {
    const [change] = diffSchemas(string, { type: ['string', 'null'] }, { direction: 'output' });
    expect(change?.message).toMatch(/^may now also be null;/);
  });

  it('summarises long enum lists', () => {
    const [change] = diffSchemas(
      { enum: [1, 2, 3, 4, 5, 6, 7] },
      { enum: [] },
      { direction: 'output' },
    );
    expect(change?.message).toContain('1, 2, 3, 4, 5 and 2 more');
  });

  it('returns nothing for identical schemas, including deep ones', () => {
    const schema = object(
      { a: object({ b: { type: 'array', items: object({ c: string }) } }) },
      { required: ['a'] },
    );
    expect(diffSchemas(schema, structuredClone(schema), { direction: 'input' })).toEqual([]);
  });

  it('stops at the step budget and says the result is incomplete', () => {
    const wide = (type: string): JsonValue =>
      object(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`p${i}`, { type }])));
    const changes = diffSchemas(wide('string'), wide('integer'), {
      direction: 'input',
      maxSteps: 5,
    });
    expect(changes.length).toBeLessThan(20);
    expect(changes.at(-1)).toMatchObject({
      severity: 'unknown',
      code: 'schema-too-complex',
      path: '$',
    });
  });
});
