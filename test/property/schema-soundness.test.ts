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
 *           old schema, or once `additionalProperties: false` (and
 *           `unevaluatedProperties: false`) is relaxed (A2: clients ignore
 *           fields they do not know).
 *
 * The generators deliberately use a tiny value domain (keys a/b/c, integers
 * -2..3, short strings) so that random instances actually hit the boundaries
 * the mutations move. The seed is fixed so CI runs are reproducible; raise
 * MCP_CONTRACT_FC_RUNS locally for a longer search.
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { JsonObject, JsonValue } from '../../src/core/json.ts';
import { declaredOnly, relaxAdditionalProperties } from './assumptions.ts';
import { clone, instancesArb, pairArb, rootArb } from './generators.ts';
import { diffSchemas } from '../../src/diff/schema.ts';
import type { SchemaDirection } from '../../src/diff/model.ts';

const RUNS = Number(process.env.MCP_CONTRACT_FC_RUNS ?? '400');
const SEED = Number(process.env.MCP_CONTRACT_FC_SEED ?? '20261017');

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
  it('never throws on a pair of schemas', () => {
    fc.assert(
      fc.property(pairArb, ([before, after]) => {
        for (const direction of ['input', 'output'] as const) {
          diffSchemas(before, after, { direction });
        }
      }),
      settings,
    );
  });

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
              validate(before, instance) || validate(relaxed, instance),
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
