import type { JsonObject, JsonValue } from '../../src/core/json.ts';
import type { SchemaDirection, Severity } from '../../src/diff/model.ts';
import { diffSchemas } from '../../src/diff/schema.ts';

/** `[severity, code, path]` triples, the compact form most tests assert on. */
export type Triple = readonly [Severity, string, string];

/** Runs diffSchemas and returns compact triples in emission order. */
export function triples(before: JsonValue, after: JsonValue, direction: SchemaDirection): Triple[] {
  return diffSchemas(before, after, { direction }).map((change) => [
    change.severity,
    change.code,
    change.path,
  ]);
}

/** Wraps properties in an object schema. */
export function object(
  properties: Record<string, JsonValue>,
  extra: Record<string, JsonValue> = {},
): JsonObject {
  return { type: 'object', properties, ...extra };
}
