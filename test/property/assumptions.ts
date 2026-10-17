/**
 * Executable models of the engine's documented assumptions, used to filter
 * and relax the Ajv oracle in the soundness property test.
 */
import { isJsonObject, type JsonObject, type JsonValue } from '../../src/core/json.ts';

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
export function declaredOnly(
  schema: JsonValue,
  instance: JsonValue,
  root: JsonValue = schema,
): boolean {
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
export function relaxAdditionalProperties(schema: JsonValue): JsonValue {
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
