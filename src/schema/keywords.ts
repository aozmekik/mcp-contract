import { compareCodeUnits, isJsonObject, type JsonObject, type JsonValue } from '../core/json.ts';

/**
 * Keyword tables for JSON Schema 2020-12 (the MCP default dialect) plus the
 * draft-04/07 spellings MCP servers still emit (`definitions`, array-form
 * `items`, `additionalItems`, `dependencies`).
 */

/** Keywords whose value is a single subschema. */
export const SINGLE_SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'additionalItems',
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

/** Keywords whose value is an array of subschemas. */
export const ARRAY_SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
]);

/** Keywords whose value maps names to subschemas. */
export const MAP_SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
  'properties',
]);

/** Keywords that only annotate and never affect which instances validate. */
export const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  '$comment',
  'default',
  'deprecated',
  'description',
  'examples',
  'readOnly',
  'title',
  'writeOnly',
]);

/** Applies `fn` to every direct subschema of `schema` and returns the rebuilt schema. */
export function mapSubschemas(
  schema: JsonValue,
  fn: (subschema: JsonValue) => JsonValue,
): JsonValue {
  if (!isJsonObject(schema)) {
    return schema;
  }
  const result: JsonObject = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (SINGLE_SUBSCHEMA_KEYWORDS.has(keyword)) {
      result[keyword] = fn(value);
    } else if (keyword === 'items') {
      // `items` is a schema in 2020-12 and may be an array of schemas in older drafts.
      result[keyword] = Array.isArray(value) ? value.map(fn) : fn(value);
    } else if (ARRAY_SUBSCHEMA_KEYWORDS.has(keyword) && Array.isArray(value)) {
      result[keyword] = value.map(fn);
    } else if (MAP_SUBSCHEMA_KEYWORDS.has(keyword) && isJsonObject(value)) {
      const mapped: JsonObject = {};
      for (const [name, subschema] of Object.entries(value)) {
        mapped[name] = fn(subschema);
      }
      result[keyword] = mapped;
    } else if (keyword === 'dependencies' && isJsonObject(value)) {
      // draft-07: values are either schemas or arrays of property names.
      const mapped: JsonObject = {};
      for (const [name, dependency] of Object.entries(value)) {
        mapped[name] = Array.isArray(dependency) ? dependency : fn(dependency);
      }
      result[keyword] = mapped;
    } else {
      result[keyword] = value;
    }
  }
  return result;
}

function sortedUniqueStrings(values: readonly JsonValue[]): JsonValue[] | undefined {
  if (!values.every((value) => typeof value === 'string')) {
    return undefined;
  }
  return [...new Set(values as string[])].sort(compareCodeUnits);
}

/**
 * Rewrites set-valued keywords into a canonical order without changing what the
 * schema accepts: `required` and array-form `type` are sorted and de-duplicated.
 * `enum` is left alone because servers often order it for display.
 */
export function normalizeSchema(schema: JsonValue): JsonValue {
  const mapped = mapSubschemas(schema, normalizeSchema);
  if (!isJsonObject(mapped)) {
    return mapped;
  }
  for (const keyword of ['required', 'type'] as const) {
    const value = mapped[keyword];
    if (Array.isArray(value)) {
      const normalized = sortedUniqueStrings(value);
      if (normalized !== undefined) {
        mapped[keyword] = normalized;
      }
    }
  }
  return mapped;
}
