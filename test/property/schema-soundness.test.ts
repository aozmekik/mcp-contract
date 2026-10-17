/**
 * Differential soundness test for the schema compatibility engine, with Ajv
 * (an independent JSON Schema 2020-12 validator) as the oracle.
 *
 * For random schemas and random mutations of them, whenever diffSchemas()
 * reports no breaking and no unknown change:
 *
 * - input:  every instance valid under the old schema (and using only declared
 *           properties, assumption A1) must be valid under the new schema;
 * - output: every instance valid under the new schema must be valid under the
 *           old schema once `additionalProperties: false` is relaxed (A2:
 *           clients ignore fields they do not know).
 *
 * The generators deliberately use a tiny value domain (keys a/b/c, integers
 * -2..3, short strings) so that random instances actually hit the boundaries
 * the mutations move. The seed is fixed so CI runs are reproducible; raise
 * MCP_CONTRACT_FC_RUNS locally for a longer search.
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isJsonObject, type JsonObject, type JsonValue } from '../../src/core/json.ts';
import { diffSchemas } from '../../src/diff/schema.ts';
import type { SchemaDirection } from '../../src/diff/model.ts';

const RUNS = Number(process.env.MCP_CONTRACT_FC_RUNS ?? '400');
const SEED = Number(process.env.MCP_CONTRACT_FC_SEED ?? '20261017');
const KEYS = ['a', 'b', 'c'] as const;

const ajv = new Ajv2020({ strict: false, allErrors: false, validateSchema: false });
const validators = new Map<string, (value: unknown) => boolean>();

function validate(schema: JsonValue, instance: JsonValue): boolean {
  const key = JSON.stringify(schema);
  let validator = validators.get(key);
  if (validator === undefined) {
    const compiled = ajv.compile(schema as object | boolean);
    validator = (value) => compiled(value);
    validators.set(key, validator);
  }
  return validator(instance);
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const scalarValue = fc.oneof(
  fc.integer({ min: -2, max: 3 }),
  fc.constantFrom(0.5, -1.5),
  fc.constantFrom('', 'a', 'ab', 'abc', 'b'),
  fc.boolean(),
  fc.constant(null),
);

const { value: instanceArb } = fc.letrec<{ value: JsonValue }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', maxDepth: 3 },
    scalarValue,
    fc.array(tie('value'), { maxLength: 3 }),
    fc.dictionary(fc.constantFrom(...KEYS), tie('value'), {
      maxKeys: 3,
    }) as fc.Arbitrary<JsonObject>,
  ),
}));

const plainLeaf: fc.Arbitrary<JsonObject> = fc.oneof(
  fc.constantFrom('string', 'integer', 'number', 'boolean', 'null').map((type) => ({ type })),
  fc
    .record(
      {
        minimum: fc.integer({ min: -2, max: 3 }),
        maximum: fc.integer({ min: -2, max: 3 }),
        exclusiveMinimum: fc.integer({ min: -2, max: 3 }),
        multipleOf: fc.constantFrom(1, 2, 0.5),
      },
      { requiredKeys: [] },
    )
    .map((bounds) => ({ type: 'integer', ...bounds })),
  fc
    .record({ minLength: fc.nat(3), maxLength: fc.nat(3) }, { requiredKeys: [] })
    .map((bounds) => ({ type: 'string', ...bounds })),
  fc.uniqueArray(scalarValue, { minLength: 1, maxLength: 3 }).map((values) => ({ enum: values })),
  scalarValue.map((value) => ({ const: value })),
  // A fresh object per value: generated values must never be shared or mutated.
  fc.constant(null).map(() => ({})),
);

/** Plain leaves plus a reference to the root's single definition `d`. */
const leafSchema: fc.Arbitrary<JsonObject> = fc.oneof(
  { weight: 6, arbitrary: plainLeaf },
  { weight: 1, arbitrary: fc.constant(null).map(() => ({ $ref: '#/$defs/d' })) },
);

const { schema: schemaArb } = fc.letrec<{ schema: JsonObject }>((tie) => ({
  schema: fc.oneof(
    { depthSize: 'small', maxDepth: 3 },
    leafSchema,
    fc
      .record({
        properties: fc.dictionary(fc.constantFrom(...KEYS), tie('schema'), { maxKeys: 3 }),
        required: fc.subarray([...KEYS]),
        additionalProperties: fc.oneof(fc.constant(undefined), fc.boolean(), tie('schema')),
      })
      .map(({ properties, required, additionalProperties }) => ({
        type: 'object',
        properties,
        required,
        ...(additionalProperties === undefined ? {} : { additionalProperties }),
      })),
    fc
      .record(
        {
          items: tie('schema'),
          minItems: fc.nat(2),
          maxItems: fc.nat(3),
          uniqueItems: fc.boolean(),
        },
        { requiredKeys: ['items'] },
      )
      .map((array) => ({ type: 'array', ...array })),
    fc
      .tuple(
        fc.constantFrom('anyOf', 'oneOf', 'allOf'),
        fc.array(tie('schema'), { minLength: 1, maxLength: 3 }),
      )
      .map(([keyword, branches]) => ({ [keyword]: branches })),
    fc
      .subarray(['string', 'integer', 'null', 'object', 'array'], { minLength: 2, maxLength: 3 })
      .map((type) => ({ type })),
  ),
}));

interface Mutation {
  readonly target: number;
  readonly op: number;
  readonly number: number;
  readonly value: JsonValue;
  readonly key: (typeof KEYS)[number];
  readonly replacement: JsonObject;
}

const mutationArb: fc.Arbitrary<Mutation> = fc.record({
  target: fc.nat(),
  op: fc.nat(),
  number: fc.integer({ min: -2, max: 3 }),
  value: scalarValue,
  key: fc.constantFrom(...KEYS),
  // Mutations never introduce references, so recursion stays guarded.
  replacement: plainLeaf,
});

/**
 * Deep copy through JSON: generated values are never mutated in place, and the
 * copy has ordinary prototypes (fast-check dictionaries are null-prototype
 * objects, which Ajv's deep equality does not support).
 */
function clone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Every subschema (not every object: `properties` maps are not schemas), in document order. */
function nodes(schema: JsonValue, out: JsonObject[] = []): JsonObject[] {
  if (!isJsonObject(schema)) {
    return out;
  }
  out.push(schema);
  if (isJsonObject(schema.$defs)) {
    Object.values(schema.$defs).forEach((definition) => nodes(definition, out));
  }
  if (isJsonObject(schema.properties)) {
    Object.values(schema.properties).forEach((property) => nodes(property, out));
  }
  nodes(schema.additionalProperties ?? null, out);
  nodes(schema.items ?? null, out);
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      branches.forEach((branch) => nodes(branch, out));
    }
  }
  return out;
}

const TYPES = ['string', 'integer', 'number', 'null', 'object', 'array', 'boolean'] as const;

function clear(node: JsonObject): void {
  for (const key of Object.keys(node)) {
    Reflect.deleteProperty(node, key);
  }
}

function mutateNode(node: JsonObject, m: Mutation): void {
  switch (m.op % 12) {
    case 0:
      node.minimum = m.number;
      break;
    case 1:
      node.maximum = m.number;
      break;
    case 2:
      delete node.minimum;
      delete node.maximum;
      delete node.exclusiveMinimum;
      delete node.multipleOf;
      break;
    case 3: {
      const values = Array.isArray(node.enum) ? node.enum : [];
      const index = values.findIndex((value) => JSON.stringify(value) === JSON.stringify(m.value));
      // Never produce an empty enum: it is not a valid schema.
      node.enum =
        index === -1
          ? [...values, m.value]
          : values.length > 1
            ? values.filter((_, i) => i !== index)
            : values;
      break;
    }
    case 4: {
      const required = Array.isArray(node.required) ? node.required : [];
      node.required = required.includes(m.key)
        ? required.filter((key) => key !== m.key)
        : [...required, m.key];
      break;
    }
    case 5: {
      const properties = isJsonObject(node.properties) ? node.properties : {};
      if (m.key in properties) {
        Reflect.deleteProperty(properties, m.key);
      } else {
        properties[m.key] = clone(m.replacement);
      }
      node.properties = properties;
      break;
    }
    case 6:
      if (node.additionalProperties === false) {
        delete node.additionalProperties;
      } else {
        node.additionalProperties = false;
      }
      break;
    case 7:
      node.type = TYPES[Math.abs(m.number) % TYPES.length] ?? 'string';
      break;
    case 8: {
      const { $defs, ...rest } = node;
      clear(node);
      node.anyOf = [clone(rest), { type: 'null' }];
      if ($defs !== undefined) {
        node.$defs = $defs; // definitions stay at the root so references keep resolving
      }
      break;
    }
    case 9:
      if (Array.isArray(node.anyOf) && node.anyOf.length > 1) {
        node.anyOf = node.anyOf.slice(1);
      }
      break;
    case 10:
      node.maxLength = Math.abs(m.number);
      break;
    default: {
      const { $defs } = node;
      clear(node);
      Object.assign(node, clone(m.replacement));
      if ($defs !== undefined) {
        node.$defs = $defs;
      }
    }
  }
}

function applyMutations(schema: JsonObject, mutations: readonly Mutation[]): JsonObject {
  const result = clone(schema);
  for (const mutation of mutations) {
    const all = nodes(result);
    const node = all[mutation.target % all.length];
    if (node !== undefined) {
      mutateNode(node, mutation);
    }
  }
  return result;
}

/**
 * The definition behind `{$ref: '#/$defs/d'}`. Its references only occur below
 * a property or an item, so every recursion is guarded (consumes part of the
 * instance), as real recursive schemas such as trees are.
 */
const definitionArb: fc.Arbitrary<JsonObject> = fc.oneof(
  fc
    .record({
      properties: fc.dictionary(fc.constantFrom(...KEYS), schemaArb, { maxKeys: 2 }),
      required: fc.subarray([...KEYS]),
    })
    .map(({ properties, required }) => ({ type: 'object', properties, required })),
  schemaArb.map((items) => ({ type: 'array', items, maxItems: 2 })),
  plainLeaf,
);

/** A schema plus the definition that its `{$ref: '#/$defs/d'}` leaves point at. */
const rootArb = fc
  .record({ body: schemaArb, definition: definitionArb })
  .map(({ body, definition }): JsonObject => ({ ...body, $defs: { d: definition } }));

const pairArb = rootArb.chain((generated) =>
  fc.array(mutationArb, { minLength: 1, maxLength: 3 }).map((mutations) => {
    const before = clone(generated);
    return [before, applyMutations(before, mutations)] as const;
  }),
);

const instancesArb = fc
  .array(instanceArb, { minLength: 30, maxLength: 30 })
  .map((instances) => instances.map(clone));

// ---------------------------------------------------------------------------
// Assumption models
// ---------------------------------------------------------------------------

/** Follows `{$ref: '#/$defs/d'}`, the only reference shape the generators produce. */
function deref(node: JsonValue, root: JsonValue): JsonValue {
  let current = node;
  for (
    let hops = 0;
    hops < 10 && isJsonObject(current) && current.$ref === '#/$defs/d';
    hops += 1
  ) {
    const definitions = isJsonObject(root) ? root.$defs : undefined;
    current = isJsonObject(definitions) ? (definitions.d ?? true) : true;
  }
  return current;
}

/** Properties a schema declares at this level, including inside combinators. */
function declaredKeys(schema: JsonValue, root: JsonValue): { keys: Set<string>; open: boolean } {
  const keys = new Set<string>();
  let open = false;
  const seen = new Set<JsonValue>();
  const visit = (raw: JsonValue): void => {
    const node = deref(raw, root);
    if (!isJsonObject(node) || seen.has(node)) {
      return;
    }
    seen.add(node);
    if (isJsonObject(node.properties)) {
      Object.keys(node.properties).forEach((key) => keys.add(key));
    }
    if (Array.isArray(node.required)) {
      node.required.forEach((key) => {
        if (typeof key === 'string') {
          keys.add(key);
        }
      });
    }
    const additional = node.additionalProperties;
    if (isJsonObject(additional) && Object.keys(additional).length > 0) {
      // A schema-valued additionalProperties is compared exactly; `{}` means
      // "anything", like an absent keyword, so A1 still applies to it.
      open = true;
    }
    for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
      const branches = node[keyword];
      if (Array.isArray(branches)) {
        branches.forEach(visit);
      }
    }
  };
  visit(schema);
  return { keys, open };
}

function subschemasFor(schema: JsonValue, key: string | number, root: JsonValue): JsonValue[] {
  const found: JsonValue[] = [];
  const seen = new Set<JsonValue>();
  const visit = (raw: JsonValue): void => {
    const node = deref(raw, root);
    if (!isJsonObject(node) || seen.has(node)) {
      return;
    }
    seen.add(node);
    if (typeof key === 'string' && isJsonObject(node.properties) && key in node.properties) {
      found.push(node.properties[key] as JsonValue);
    } else if (typeof key === 'string' && isJsonObject(node.additionalProperties)) {
      found.push(node.additionalProperties);
    }
    if (typeof key === 'number' && node.items !== undefined) {
      found.push(node.items);
    }
    for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
      const branches = node[keyword];
      if (Array.isArray(branches)) {
        branches.forEach(visit);
      }
    }
  };
  visit(schema);
  return found;
}

/** A1: the instance only uses properties the schema declares, at every level. */
function declaredOnly(schema: JsonValue, instance: JsonValue, root: JsonValue = schema): boolean {
  if (Array.isArray(instance)) {
    return instance.every((item, index) =>
      subschemasFor(schema, index, root).every((sub) => declaredOnly(sub, item, root)),
    );
  }
  if (!isJsonObject(instance)) {
    return true;
  }
  const { keys, open } = declaredKeys(schema, root);
  return Object.entries(instance).every(
    ([key, value]) =>
      (open || keys.has(key)) &&
      subschemasFor(schema, key, root).every((sub) => declaredOnly(sub, value, root)),
  );
}

/**
 * A2: drops `additionalProperties: false`, i.e. unknown result fields are
 * ignored. Not applied inside `oneOf`: relaxing one alternative can make two
 * alternatives match and so reject a value, which is not what A2 means (and
 * the engine never relies on A2 inside oneOf; it reports `unknown` there).
 */
function relaxAdditionalProperties(schema: JsonValue): JsonValue {
  if (Array.isArray(schema)) {
    return schema.map(relaxAdditionalProperties);
  }
  if (!isJsonObject(schema)) {
    return schema;
  }
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties' && value === false) {
      continue;
    }
    result[key] =
      key === 'enum' || key === 'const' || key === 'oneOf'
        ? value
        : relaxAdditionalProperties(value);
  }
  return result;
}

function claimsCompatible(
  before: JsonObject,
  after: JsonObject,
  direction: SchemaDirection,
): boolean {
  return diffSchemas(before, after, { direction }).every(
    (change) => change.severity === 'non-breaking',
  );
}

const settings = { numRuns: RUNS, seed: SEED, endOnFailure: true };

describe('schema compatibility engine (property-based, Ajv oracle)', () => {
  it('never throws and reports nothing when comparing a schema with itself', () => {
    fc.assert(
      fc.property(rootArb, (generated) => {
        const schema = clone(generated);
        for (const direction of ['input', 'output'] as const) {
          expect(diffSchemas(schema, clone(schema), { direction })).toEqual([]);
        }
      }),
      settings,
    );
  });

  it('is sound for inputs: a non-breaking verdict never rejects a previously valid request', () => {
    fc.assert(
      fc.property(pairArb, instancesArb, ([before, after], instances) => {
        if (!claimsCompatible(before, after, 'input')) {
          return;
        }
        for (const instance of instances) {
          if (validate(before, instance) && declaredOnly(before, instance)) {
            expect(
              validate(after, instance),
              `${JSON.stringify(instance)} was valid under ${JSON.stringify(before)} but not under ${JSON.stringify(after)}`,
            ).toBe(true);
          }
        }
      }),
      settings,
    );
  });

  it('is sound for outputs: a non-breaking verdict never lets a result escape the old schema', () => {
    fc.assert(
      fc.property(pairArb, instancesArb, ([before, after], instances) => {
        if (!claimsCompatible(before, after, 'output')) {
          return;
        }
        const relaxed = relaxAdditionalProperties(before);
        for (const instance of instances) {
          if (validate(after, instance)) {
            expect(
              validate(relaxed, instance),
              `${JSON.stringify(instance)} is valid under ${JSON.stringify(after)} but not under ${JSON.stringify(before)}`,
            ).toBe(true);
          }
        }
      }),
      settings,
    );
  });

  it('finds genuinely breaking input changes often enough for the soundness checks to mean something', () => {
    // Guard against a vacuous property: the generators must produce both verdicts.
    const verdicts = fc
      .sample(pairArb, { numRuns: 300, seed: SEED })
      .map(([before, after]) => claimsCompatible(before, after, 'input'));
    expect(verdicts.filter(Boolean).length).toBeGreaterThan(30);
    expect(verdicts.filter((verdict) => !verdict).length).toBeGreaterThan(30);
  });
});
