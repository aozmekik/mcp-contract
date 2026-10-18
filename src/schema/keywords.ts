import {
  compareCodeUnits,
  defineMember,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from '../core/json.ts';

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

/**
 * Applies `fn` to every direct subschema of `schema` and returns the rebuilt
 * schema. Members are defined, never assigned, so a property named
 * `__proto__` stays an ordinary member.
 */
export function mapSubschemas(
  schema: JsonValue,
  fn: (subschema: JsonValue) => JsonValue,
): JsonValue {
  if (!isJsonObject(schema)) {
    return schema;
  }
  const result: JsonObject = {};
  for (const [keyword, value] of Object.entries(schema)) {
    defineMember(result, keyword, mapKeyword(keyword, value, fn));
  }
  return result;
}

function mapKeyword(
  keyword: string,
  value: JsonValue,
  fn: (subschema: JsonValue) => JsonValue,
): JsonValue {
  if (SINGLE_SUBSCHEMA_KEYWORDS.has(keyword)) {
    return fn(value);
  }
  if (keyword === 'items') {
    // `items` is a schema in 2020-12 and may be an array of schemas in older drafts.
    return Array.isArray(value) ? value.map(fn) : fn(value);
  }
  if (ARRAY_SUBSCHEMA_KEYWORDS.has(keyword) && Array.isArray(value)) {
    return value.map(fn);
  }
  if ((MAP_SUBSCHEMA_KEYWORDS.has(keyword) || keyword === 'dependencies') && isJsonObject(value)) {
    const mapped: JsonObject = {};
    for (const [name, member] of Object.entries(value)) {
      // draft-07 `dependencies` values are either schemas or arrays of property names.
      const keep = keyword === 'dependencies' && Array.isArray(member);
      defineMember(mapped, name, keep ? member : fn(member));
    }
    return mapped;
  }
  return value;
}

/** Calls `fn` for every direct subschema of `schema`, in keyword order, without copying. */
export function forEachSubschema(schema: JsonValue, fn: (subschema: JsonValue) => void): void {
  if (!isJsonObject(schema)) {
    return;
  }
  for (const [keyword, value] of Object.entries(schema)) {
    if (SINGLE_SUBSCHEMA_KEYWORDS.has(keyword)) {
      fn(value);
    } else if (keyword === 'items') {
      if (Array.isArray(value)) {
        value.forEach(fn);
      } else {
        fn(value);
      }
    } else if (ARRAY_SUBSCHEMA_KEYWORDS.has(keyword) && Array.isArray(value)) {
      value.forEach(fn);
    } else if (
      (MAP_SUBSCHEMA_KEYWORDS.has(keyword) || keyword === 'dependencies') &&
      isJsonObject(value)
    ) {
      for (const member of Object.values(value)) {
        if (!(keyword === 'dependencies' && Array.isArray(member))) {
          fn(member);
        }
      }
    }
  }
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
    const value = Object.hasOwn(mapped, keyword) ? mapped[keyword] : undefined;
    if (Array.isArray(value)) {
      const normalized = sortedUniqueStrings(value);
      if (normalized !== undefined) {
        defineMember(mapped, keyword, normalized);
      }
    }
  }
  return mapped;
}
