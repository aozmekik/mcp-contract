/** Dispatcher: cycle detection, `$ref` resolution, type gating and opaque keywords. */
import {
  compareCodeUnits,
  isJsonObject,
  jsonEqual,
  type JsonObject,
  type JsonValue,
} from '../../core/json.ts';
import {
  ANNOTATION_KEYWORDS,
  ARRAY_SUBSCHEMA_KEYWORDS,
  MAP_SUBSCHEMA_KEYWORDS,
  SINGLE_SUBSCHEMA_KEYWORDS,
} from '../../schema/keywords.ts';
import type { SchemaDirection } from '../model.ts';
import { compareAnnotations } from './annotations.ts';
import { compareAllOf, compareUnionKeyword, liftUnion } from './composition.ts';
import {
  describeChange,
  emit,
  equivalent,
  get,
  isSchema,
  type Context,
  type SchemaChange,
  type Step,
} from './context.ts';
import { lookupRef, resolve } from './refs.ts';
import { childScope } from './scope.ts';
import {
  compareEnums,
  compareNumbers,
  compareStrings,
  compareTypes,
  effectiveTypes,
  type TypeName,
} from './scalars.ts';
import { compareArrays, compareObjects } from './structures.ts';

/** Options for {@link diffSchemas}. */
export interface DiffSchemasOptions {
  /** `input` for data the client sends, `output` for data the server returns. */
  readonly direction: SchemaDirection;
  /**
   * Upper bound on subschema comparisons, protecting against pathological
   * schemas (the MCP specification asks implementations to bound composition
   * work). When exceeded, a `schema-too-complex` change of severity `unknown`
   * is added and the analysis stops. Defaults to {@link DEFAULT_MAX_STEPS}.
   */
  readonly maxSteps?: number;
}

/** Default value of {@link DiffSchemasOptions.maxSteps}. */
export const DEFAULT_MAX_STEPS = 20_000;

/** Keywords some module reasons about; everything else is compared opaquely. */
const HANDLED_KEYWORDS: ReadonlySet<string> = new Set([
  ...ANNOTATION_KEYWORDS,
  '$defs',
  '$ref',
  'additionalItems',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'definitions',
  'enum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'items',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'multipleOf',
  'oneOf',
  'pattern',
  'patternProperties',
  'prefixItems',
  'properties',
  'propertyNames',
  'required',
  'type',
  'uniqueItems',
]);

const identities = new WeakMap<object, number>();
let nextIdentity = 0;

/** Stable identity of a schema node, used to recognise pairs already on the stack. */
function identity(value: JsonValue): string {
  if (typeof value !== 'object' || value === null) {
    return `v${JSON.stringify(value)}`;
  }
  let id = identities.get(value);
  if (id === undefined) {
    nextIdentity += 1;
    id = nextIdentity;
    identities.set(value, id);
  }
  return `o${id}`;
}

const refsMemo = new WeakMap<object, readonly string[]>();

/** Every `$ref` inside `value`; a `$dynamicRef` yields a marker that is never stable. */
function refsIn(value: JsonValue): readonly string[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  const cached = refsMemo.get(value);
  if (cached !== undefined) {
    return cached;
  }
  const found = new Set<string>();
  if (!Array.isArray(value)) {
    if (typeof value.$ref === 'string') {
      found.add(value.$ref);
    }
    if (value.$dynamicRef !== undefined) {
      found.add('\u0000dynamic');
    }
  }
  for (const item of Object.values(value)) {
    for (const ref of refsIn(item)) {
      found.add(ref);
    }
  }
  const result = [...found];
  refsMemo.set(value, result);
  return result;
}

/**
 * True when every reference reachable from `value` resolves to equal
 * definitions in both schemas, so equal text implies equal meaning.
 */
function refsStable(ctx: Context, value: JsonValue): boolean {
  const pending = [...refsIn(value)];
  const visited = new Set<string>();
  for (let ref = pending.pop(); ref !== undefined; ref = pending.pop()) {
    if (visited.has(ref) || ctx.stableRefs.get(ref) === true) {
      continue;
    }
    visited.add(ref);
    const before = lookupRef(ctx.oldRoot, ref);
    const after = lookupRef(ctx.newRoot, ref);
    if (
      ctx.stableRefs.get(ref) === false ||
      !before.ok ||
      !after.ok ||
      !jsonEqual(before.value, after.value)
    ) {
      ctx.stableRefs.set(ref, false);
      return false;
    }
    pending.push(...refsIn(before.value));
  }
  visited.forEach((ref) => ctx.stableRefs.set(ref, true));
  return true;
}

const scopeKeys = new WeakMap<readonly JsonValue[], string>();

function scopeKey(scope: readonly JsonValue[]): string {
  let key = scopeKeys.get(scope);
  if (key === undefined) {
    key = scope.map(identity).sort().join(',');
    scopeKeys.set(scope, key);
  }
  return key;
}

function compareNodes(
  ctx: Context,
  oldRaw: JsonValue,
  newRaw: JsonValue,
  path: string,
  step: Step | undefined,
): void {
  if (step === undefined) {
    compareAtLocation(ctx, oldRaw, newRaw, path);
    return;
  }
  const saved = ctx.scope;
  ctx.scope = childScope(saved, ctx.oldRoot, step);
  try {
    compareAtLocation(ctx, oldRaw, newRaw, path);
  } finally {
    ctx.scope = saved;
  }
}

function compareAtLocation(ctx: Context, oldRaw: JsonValue, newRaw: JsonValue, path: string): void {
  if (ctx.budget.remaining <= 0) {
    ctx.budget.exhausted = true;
    return;
  }
  ctx.budget.remaining -= 1;

  // Coinduction: a pair already being compared further up the stack (at the
  // same kind of location) is assumed compatible. Both the raw pair and the
  // pair of $ref targets are tracked, so a recursive definition is unrolled at
  // most once. Keys include the scope because the A1 rule depends on it; there
  // are finitely many scopes, so recursion still terminates.
  const scope = scopeKey(ctx.scope);
  const rawKey = `${identity(oldRaw)}|${identity(newRaw)}|${scope}`;
  if (ctx.stack.has(rawKey)) {
    return;
  }
  const oldResolved = resolve(oldRaw, ctx.oldRoot);
  const newResolved = resolve(newRaw, ctx.newRoot);
  if (!oldResolved.ok || !newResolved.ok) {
    if (!oldResolved.ok && !newResolved.ok && jsonEqual(oldRaw, newRaw)) {
      return; // The same unresolvable reference on both sides.
    }
    const failure = oldResolved.ok ? newResolved : oldResolved;
    emit(ctx, 'unknown', 'ref-unresolved', path, 'schema reference cannot be compared', {
      reason: failure.ok ? 'the reference could not be followed' : failure.reason,
    });
    return;
  }
  const resolvedKey = `${identity(oldResolved.value)}|${identity(newResolved.value)}|${scope}`;
  if (ctx.stack.has(resolvedKey)) {
    return;
  }
  ctx.stack.add(rawKey);
  ctx.stack.add(resolvedKey);
  try {
    compareResolved(ctx, oldResolved.value, newResolved.value, path);
  } finally {
    ctx.stack.delete(rawKey);
    ctx.stack.delete(resolvedKey);
  }
}

function compareResolved(
  ctx: Context,
  oldValue: JsonValue,
  newValue: JsonValue,
  path: string,
): void {
  if (jsonEqual(oldValue, newValue) && refsStable(ctx, oldValue)) {
    return;
  }
  if (!isSchema(oldValue) || !isSchema(newValue)) {
    emit(ctx, 'unknown', 'invalid-schema', path, 'schema changed', {
      reason: 'one side is not a valid JSON Schema (expected an object or a boolean)',
    });
    return;
  }
  if (oldValue === false || newValue === false) {
    if (oldValue === false) {
      emit(
        ctx,
        'widen',
        'schema-widened',
        path,
        'schema previously accepted no value and now accepts some',
      );
    } else {
      emit(ctx, 'narrow', 'schema-narrowed', path, 'schema now accepts no value (`false`)');
    }
    return;
  }
  const o: JsonObject = oldValue === true ? {} : oldValue;
  const n: JsonObject = newValue === true ? {} : newValue;

  if (liftUnion(ctx, o, n, path)) {
    return;
  }
  compareAnnotations(ctx, o, n, path);
  compareTypes(ctx, o, n, path);
  compareEnums(ctx, o, n, path);

  // Type-specific keywords only matter where both schemas accept that type.
  const oldTypes = effectiveTypes(o);
  const newTypes = effectiveTypes(n);
  const both = (test: (types: ReadonlySet<TypeName>) => boolean): boolean =>
    test(oldTypes) && test(newTypes);
  if (both((types) => types.has('number') || types.has('integer'))) {
    compareNumbers(ctx, o, n, path);
  }
  if (both((types) => types.has('string'))) {
    compareStrings(ctx, o, n, path);
  }
  if (both((types) => types.has('array'))) {
    compareArrays(ctx, o, n, path);
  }
  if (both((types) => types.has('object'))) {
    compareObjects(ctx, o, n, path);
  }
  compareAllOf(ctx, o, n, path);
  compareUnionKeyword(ctx, 'anyOf', o, n, path);
  compareUnionKeyword(ctx, 'oneOf', o, n, path);
  compareOpaqueKeywords(ctx, o, n, path);
}

function opaqueEquivalent(
  ctx: Context,
  keyword: string,
  a: JsonValue,
  b: JsonValue,
  path: string,
): boolean {
  if (SINGLE_SUBSCHEMA_KEYWORDS.has(keyword)) {
    return equivalent(ctx, a, b, path);
  }
  if (ARRAY_SUBSCHEMA_KEYWORDS.has(keyword) && Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length &&
      a.every((item, index) => {
        const other = b[index];
        return other !== undefined && equivalent(ctx, item, other, path);
      })
    );
  }
  if (
    (MAP_SUBSCHEMA_KEYWORDS.has(keyword) || keyword === 'dependencies') &&
    isJsonObject(a) &&
    isJsonObject(b)
  ) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => {
      const left = get(a, key);
      const right = get(b, key);
      if (left === undefined || right === undefined) {
        return false;
      }
      return Array.isArray(left) || Array.isArray(right)
        ? jsonEqual(left, right)
        : equivalent(ctx, left, right, path);
    });
  }
  return jsonEqual(a, b);
}

function opaqueReason(keyword: string): string {
  switch (keyword) {
    case 'x-mcp-header':
      return 'clients are unaffected, but proxies routing on the Mcp-Param header may be';
    case '$schema':
      return 'keywords can mean different things in different JSON Schema dialects';
    default:
      return 'mcp-contract does not model this keyword, so its effect cannot be determined';
  }
}

function compareOpaqueKeywords(ctx: Context, o: JsonObject, n: JsonObject, path: string): void {
  const keywords = [...new Set([...Object.keys(o), ...Object.keys(n)])]
    .filter((keyword) => !HANDLED_KEYWORDS.has(keyword))
    .sort(compareCodeUnits);
  for (const keyword of keywords) {
    const before = get(o, keyword);
    const after = get(n, keyword);
    if (
      before !== undefined &&
      after !== undefined &&
      opaqueEquivalent(ctx, keyword, before, after, path)
    ) {
      continue;
    }
    emit(
      ctx,
      'unknown',
      keyword === '$schema' ? 'dialect-changed' : 'keyword-changed',
      path,
      describeChange(keyword, before, after),
      {
        ...(before === undefined || isJsonObject(before) ? {} : { before }),
        ...(after === undefined || isJsonObject(after) ? {} : { after }),
        reason: opaqueReason(keyword),
      },
    );
  }
}

/**
 * Compares two JSON Schemas and classifies every difference for the given
 * direction. Local `$ref`s (including recursive ones) are followed; non-local
 * references are never fetched.
 *
 * @example
 * ```ts
 * diffSchemas(
 *   { type: 'object', properties: { limit: { type: 'integer', maximum: 100 } } },
 *   { type: 'object', properties: { limit: { type: 'integer', maximum: 50 } } },
 *   { direction: 'input' },
 * );
 * // [{ severity: 'breaking', code: 'constraint-tightened', path: '$.limit', ... }]
 * ```
 */
export function diffSchemas(
  oldSchema: JsonValue,
  newSchema: JsonValue,
  options: DiffSchemasOptions,
): SchemaChange[] {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const ctx: Context = {
    direction: options.direction,
    oldRoot: oldSchema,
    newRoot: newSchema,
    stack: new Set(),
    stableRefs: new Map(),
    budget: { remaining: maxSteps, exhausted: false },
    out: [],
    scope: [oldSchema],
    compare: (before, after, path, step) => {
      compareNodes(ctx, before, after, path, step);
    },
  };
  compareNodes(ctx, oldSchema, newSchema, '$', undefined);
  const seen = new Set<string>();
  const changes: SchemaChange[] = [];
  for (const { effect, ...change } of ctx.out) {
    const key = `${change.code}\u0000${change.path}\u0000${change.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      changes.push(change);
    }
  }
  if (ctx.budget.exhausted) {
    changes.push({
      severity: 'unknown',
      code: 'schema-too-complex',
      path: '$',
      message: `schema comparison stopped after ${maxSteps} steps; the result is incomplete`,
    });
  }
  return changes;
}
