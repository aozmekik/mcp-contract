/**
 * fast-check generators for the schema soundness property test: small
 * schemas (with guarded recursive references), mutations of them, and
 * instances drawn from a tiny value domain so that boundaries are hit often.
 */
import fc from 'fast-check';
import { isJsonObject, type JsonObject, type JsonValue } from '../../src/core/json.ts';

/** Property names used by every generator. */
export const KEYS = ['a', 'b', 'c'] as const;

const scalarValue = fc.oneof(
  fc.integer({ min: -2, max: 3 }),
  fc.constantFrom(0.5, -1.5),
  fc.constantFrom('', 'a', 'ab', 'abc', 'b'),
  fc.boolean(),
  fc.constant(null),
);

const { value: instanceTree } = fc.letrec<{ value: JsonValue }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', maxDepth: 3 },
    scalarValue,
    fc.array(tie('value'), { maxLength: 3 }),
    fc.dictionary(fc.constantFrom(...KEYS), tie('value'), {
      maxKeys: 3,
    }) as fc.Arbitrary<JsonObject>,
  ),
}));

/** Random JSON values over a tiny domain. */
export const instanceArb: fc.Arbitrary<JsonValue> = instanceTree;

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

const { schema: schemaTree } = fc.letrec<{ schema: JsonObject }>((tie) => ({
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

/** Random schemas (objects, arrays, unions, leaves, references). */
export const schemaArb: fc.Arbitrary<JsonObject> = schemaTree;

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
export function clone<T extends JsonValue>(value: T): T {
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
export const rootArb: fc.Arbitrary<JsonObject> = fc
  .record({ body: schemaArb, definition: definitionArb })
  .map(({ body, definition }): JsonObject => ({ ...body, $defs: { d: definition } }));

export const pairArb: fc.Arbitrary<readonly [JsonObject, JsonObject]> = rootArb.chain((generated) =>
  fc.array(mutationArb, { minLength: 1, maxLength: 3 }).map((mutations) => {
    const before = clone(generated);
    return [before, applyMutations(before, mutations)] as const;
  }),
);

export const instancesArb: fc.Arbitrary<JsonValue[]> = fc
  .array(instanceArb, { minLength: 30, maxLength: 30 })
  .map((instances) => instances.map(clone));
