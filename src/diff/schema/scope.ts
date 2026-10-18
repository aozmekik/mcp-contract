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
import { get, identity, type Step } from './context.ts';
import type { SchemaDocument } from './refs.ts';

/** What the old schema allows at one location, as far as A1 is concerned. */
export interface DeclaredProperties {
  /** Properties declared (in `properties` or `required`) by any applicable subschema. */
  readonly keys: ReadonlySet<string>;
  /**
   * True when some applicable subschema accepts properties it does not name
   * (schema-valued `additionalProperties` or `unevaluatedProperties`,
   * `patternProperties`), or when a reference could not be followed. Then A1
   * cannot be applied.
   */
  readonly open: boolean;
  /**
   * True when some applicable subschema has a schema-valued
   * `unevaluatedProperties`: results could then already contain undeclared
   * fields, typed by that schema, so they are not unknown to clients (A2).
   */
  readonly typedUnevaluated: boolean;
}

interface Expanded {
  readonly nodes: readonly JsonObject[];
  readonly complete: boolean;
}

const SAME_LOCATION_KEYWORDS = ['allOf', 'anyOf', 'oneOf'] as const;
const SAME_LOCATION_SINGLE = ['if', 'then', 'else'] as const;

/** Resolves references and adds every combinator member, recursively. */
function expand(scope: readonly JsonValue[], doc: SchemaDocument): Expanded {
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
    const resolved = doc.resolve(raw);
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

const scopeKeys = new WeakMap<readonly JsonValue[], string>();

/**
 * Identifies a scope by the subschemas it expands to, so two routes to the same
 * location (for example through a recursive reference) get the same key.
 */
export function scopeKey(scope: readonly JsonValue[], doc: SchemaDocument): string {
  let key = scopeKeys.get(scope);
  if (key === undefined) {
    const { nodes, complete } = expand(scope, doc);
    key = `${complete ? '' : '?'}${nodes.map(identity).sort().join(',')}`;
    scopeKeys.set(scope, key);
  }
  return key;
}

const declaredMemo = new WeakMap<readonly JsonValue[], DeclaredProperties>();

/** Properties the old schema declares at the scope's location. */
export function declaredInScope(
  scope: readonly JsonValue[],
  doc: SchemaDocument,
): DeclaredProperties {
  const cached = declaredMemo.get(scope);
  if (cached !== undefined) {
    return cached;
  }
  const { nodes, complete } = expand(scope, doc);
  const keys = new Set<string>();
  let open = !complete;
  let typedUnevaluated = false;
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
    if (nonEmptyObject(get(node, 'unevaluatedProperties'))) {
      typedUnevaluated = true;
    }
    if (
      nonEmptyObject(get(node, 'additionalProperties')) ||
      nonEmptyObject(get(node, 'unevaluatedProperties')) ||
      nonEmptyObject(get(node, 'patternProperties'))
    ) {
      open = true;
    }
  }
  const result = { keys, open, typedUnevaluated };
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

/**
 * Subschemas that may apply to an array item. `unevaluatedItems` is included
 * whenever nothing else is: it may apply, and a scope that is too large only
 * makes A1 more cautious.
 */
function itemSchemas(node: JsonObject, index: number | undefined): JsonValue[] {
  const items = get(node, 'items');
  const unevaluated = get(node, 'unevaluatedItems');
  const fallback = (rest: JsonValue | undefined): JsonValue[] => {
    const chosen = rest ?? unevaluated;
    return chosen === undefined ? [] : [chosen];
  };
  if (Array.isArray(items)) {
    const positional = index === undefined ? undefined : items[index];
    return positional === undefined ? fallback(get(node, 'additionalItems')) : [positional];
  }
  const prefix = get(node, 'prefixItems');
  const positional = Array.isArray(prefix) && index !== undefined ? prefix[index] : undefined;
  return positional === undefined ? fallback(items) : [positional];
}

/** The scope of the location reached from `scope` by `step`. */
export function childScope(
  scope: readonly JsonValue[],
  doc: SchemaDocument,
  step: Step,
): JsonValue[] {
  const { nodes } = expand(scope, doc);
  const result: JsonValue[] = [];
  for (const node of nodes) {
    switch (step.kind) {
      case 'property': {
        const properties = get(node, 'properties');
        const declared = isJsonObject(properties) ? get(properties, step.key) : undefined;
        const patterns = matchingPatterns(node, step.key);
        const additional = get(node, 'additionalProperties') ?? get(node, 'unevaluatedProperties');
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
        const additional = get(node, 'additionalProperties') ?? get(node, 'unevaluatedProperties');
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
