/**
 * Instance-location scopes.
 *
 * Assumption A1 says clients only send properties the old schema declares.
 * "Declares" has to be judged against every old subschema that applies to the
 * same part of the instance, not just the node being compared: a property may
 * be declared by a sibling `anyOf` alternative, by another `allOf` member, or
 * accepted by a schema-valued `additionalProperties` (a map type). The scope
 * is the list of old subschemas applying at the current location; it changes
 * when the comparison descends into members or items, and stays the same when
 * it descends into alternatives.
 */
import { isJsonObject, type JsonObject, type JsonValue } from '../../core/json.ts';
import { get, type Step } from './context.ts';
import { resolve } from './refs.ts';

/** What the old schema allows at one location, as far as A1 is concerned. */
export interface DeclaredProperties {
  /** Properties declared (in `properties` or `required`) by any applicable subschema. */
  readonly keys: ReadonlySet<string>;
  /**
   * True when some applicable subschema accepts properties it does not name
   * (schema-valued `additionalProperties`, `patternProperties`), or when a
   * reference could not be followed. Then A1 cannot be applied.
   */
  readonly open: boolean;
}

interface Expanded {
  readonly nodes: readonly JsonObject[];
  readonly complete: boolean;
}

const SAME_LOCATION_KEYWORDS = ['allOf', 'anyOf', 'oneOf'] as const;
const SAME_LOCATION_SINGLE = ['if', 'then', 'else'] as const;

/** Resolves references and adds every combinator member, recursively. */
function expand(scope: readonly JsonValue[], root: JsonValue): Expanded {
  const nodes: JsonObject[] = [];
  // Raw nodes and resolved targets are tracked separately: a node without a
  // $ref resolves to itself and must still be collected.
  const visitedRaw = new Set<JsonValue>();
  const collected = new Set<JsonValue>();
  let complete = true;
  const visit = (raw: JsonValue): void => {
    if (visitedRaw.has(raw)) {
      return;
    }
    visitedRaw.add(raw);
    const resolved = resolve(raw, root);
    if (!resolved.ok) {
      complete = false;
      return;
    }
    const node = resolved.value;
    if (!isJsonObject(node) || collected.has(node)) {
      return;
    }
    collected.add(node);
    nodes.push(node);
    for (const keyword of SAME_LOCATION_KEYWORDS) {
      const branches = get(node, keyword);
      if (Array.isArray(branches)) {
        branches.forEach(visit);
      }
    }
    for (const keyword of SAME_LOCATION_SINGLE) {
      const branch = get(node, keyword);
      if (branch !== undefined) {
        visit(branch);
      }
    }
    const dependent = get(node, 'dependentSchemas');
    if (isJsonObject(dependent)) {
      Object.values(dependent).forEach(visit);
    }
  };
  scope.forEach(visit);
  return { nodes, complete };
}

function nonEmptyObject(value: JsonValue | undefined): boolean {
  return isJsonObject(value) && Object.keys(value).length > 0;
}

const declaredMemo = new WeakMap<readonly JsonValue[], DeclaredProperties>();

/** Properties the old schema declares at the scope's location. */
export function declaredInScope(scope: readonly JsonValue[], root: JsonValue): DeclaredProperties {
  const cached = declaredMemo.get(scope);
  if (cached !== undefined) {
    return cached;
  }
  const { nodes, complete } = expand(scope, root);
  const keys = new Set<string>();
  let open = !complete;
  for (const node of nodes) {
    const properties = get(node, 'properties');
    if (isJsonObject(properties)) {
      Object.keys(properties).forEach((key) => keys.add(key));
    }
    const required = get(node, 'required');
    if (Array.isArray(required)) {
      required.forEach((key) => {
        if (typeof key === 'string') {
          keys.add(key);
        }
      });
    }
    if (
      nonEmptyObject(get(node, 'additionalProperties')) ||
      nonEmptyObject(get(node, 'patternProperties'))
    ) {
      open = true;
    }
  }
  const result = { keys, open };
  declaredMemo.set(scope, result);
  return result;
}

function matchingPatterns(node: JsonObject, key: string): JsonValue[] {
  const patterns = get(node, 'patternProperties');
  if (!isJsonObject(patterns)) {
    return [];
  }
  return Object.entries(patterns)
    .filter(([pattern]) => {
      try {
        return new RegExp(pattern, 'u').test(key);
      } catch {
        return true;
      }
    })
    .map(([, schema]) => schema);
}

function itemSchemas(node: JsonObject, index: number | undefined): JsonValue[] {
  const items = get(node, 'items');
  if (Array.isArray(items)) {
    const rest = get(node, 'additionalItems');
    const positional = index === undefined ? undefined : items[index];
    if (positional !== undefined) {
      return [positional];
    }
    return rest === undefined ? [] : [rest];
  }
  const prefix = get(node, 'prefixItems');
  const positional = Array.isArray(prefix) && index !== undefined ? prefix[index] : undefined;
  if (positional !== undefined) {
    return [positional];
  }
  return items === undefined ? [] : [items];
}

/** The scope of the location reached from `scope` by `step`. */
export function childScope(scope: readonly JsonValue[], root: JsonValue, step: Step): JsonValue[] {
  const { nodes } = expand(scope, root);
  const result: JsonValue[] = [];
  for (const node of nodes) {
    switch (step.kind) {
      case 'property': {
        const properties = get(node, 'properties');
        const declared = isJsonObject(properties) ? get(properties, step.key) : undefined;
        const patterns = matchingPatterns(node, step.key);
        const additional = get(node, 'additionalProperties');
        if (declared !== undefined) {
          result.push(declared);
        }
        result.push(...patterns);
        if (declared === undefined && patterns.length === 0 && additional !== undefined) {
          result.push(additional);
        }
        break;
      }
      case 'items':
        result.push(...itemSchemas(node, step.index));
        break;
      case 'additional': {
        const additional = get(node, 'additionalProperties');
        if (additional !== undefined) {
          result.push(additional);
        }
        break;
      }
      case 'names':
        break; // Property names are strings; nothing below them declares properties.
    }
  }
  return result;
}
