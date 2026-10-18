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
import { compareAllOf, compareUnionKeyword, liftAllOf, liftUnion } from './composition.ts';
import {
  CLOSING_ITEMS,
  CLOSING_PROPERTIES,
  describeChange,
  emit,
  equivalent,
  get,
  identity,
  isSchema,
  type Context,
  type SchemaChange,
  type Step,
} from './context.ts';
import { indexDocument, unevaluatedRole } from './refs.ts';
import { refsStable, unresolvedUnchanged } from './stability.ts';
import { childScope, scopeKey } from './scope.ts';
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

/**
 * Maximum nesting of comparisons. Real schemas stay far below it; it keeps
 * pathological ones from exhausting the call stack before the step budget.
 */
const MAX_DEPTH = 200;

/** Keywords some module reasons about; everything else is compared opaquely. */
const HANDLED_KEYWORDS: ReadonlySet<string> = new Set([
  ...ANNOTATION_KEYWORDS,
  // Identifiers and definitions only matter through the references that use
  // them, and references are compared by what they resolve to.
  '$anchor',
  '$defs',
  '$id',
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

/** Keywords that refer to another schema dynamically; mcp-contract does not follow them. */
const DYNAMIC_REFERENCE_KEYWORDS: ReadonlySet<string> = new Set(['$dynamicRef', '$recursiveRef']);

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
  const savedClosing = ctx.closing;
  const cacheKey = `${scopeKey(saved, ctx.oldDoc)}|${JSON.stringify(step)}`;
  let next = ctx.scopes.get(cacheKey);
  if (next === undefined) {
    next = childScope(saved, ctx.oldDoc, step);
    ctx.scopes.set(cacheKey, next);
  }
  ctx.scope = next;
  // unevaluated* keywords only apply at their own instance location.
  ctx.closing = 0;
  try {
    compareAtLocation(ctx, oldRaw, newRaw, path);
  } finally {
    ctx.scope = saved;
    ctx.closing = savedClosing;
  }
}

function compareAtLocation(ctx: Context, oldRaw: JsonValue, newRaw: JsonValue, path: string): void {
  if (ctx.budget.remaining <= 0 || ctx.depth >= MAX_DEPTH) {
    ctx.budget.exhausted = true;
    ctx.budget.tooDeep ||= ctx.depth >= MAX_DEPTH;
    return;
  }
  ctx.budget.remaining -= 1;

  // Coinduction: a pair already being compared further up the stack, for the
  // same question and in the same context, is assumed to hold. Both the raw
  // pair and the pair of $ref targets are tracked, so a recursive definition
  // is unrolled at most once per question. The context (scope and closing
  // keywords) is part of the key because the rules depend on it; it takes
  // finitely many values, so recursion still terminates.
  const context = `${ctx.judgment}|${scopeKey(ctx.scope, ctx.oldDoc)}|${ctx.closing}`;
  const rawKey = `${identity(oldRaw)}|${identity(newRaw)}|${context}`;
  if (ctx.stack.has(rawKey)) {
    return;
  }
  const oldResolved = ctx.oldDoc.resolve(oldRaw);
  const newResolved = ctx.newDoc.resolve(newRaw);
  if (!oldResolved.ok || !newResolved.ok) {
    if (!oldResolved.ok && !newResolved.ok && jsonEqual(oldRaw, newRaw)) {
      if (!unresolvedUnchanged(ctx, oldResolved, newResolved)) {
        emit(ctx, 'unknown', 'ref-unresolved', path, 'schema reference cannot be followed', {
          reason: `${oldResolved.reason}; the schemas differ elsewhere, so its target may have changed`,
        });
      }
      return;
    }
    const failure = oldResolved.ok ? newResolved : oldResolved;
    emit(ctx, 'unknown', 'ref-unresolved', path, 'schema reference cannot be compared', {
      reason: failure.ok ? 'the reference could not be followed' : failure.reason,
    });
    return;
  }
  const resolvedKey = `${identity(oldResolved.value)}|${identity(newResolved.value)}|${context}`;
  if (ctx.stack.has(resolvedKey)) {
    return;
  }
  ctx.stack.add(rawKey);
  ctx.stack.add(resolvedKey);
  ctx.depth += 1;
  try {
    compareResolved(ctx, oldResolved.value, newResolved.value, path);
  } finally {
    ctx.depth -= 1;
    ctx.stack.delete(rawKey);
    ctx.stack.delete(resolvedKey);
  }
}

function closingBits(schema: JsonObject): number {
  return (
    (unevaluatedRole(schema, 'properties') === 'closing' ? CLOSING_PROPERTIES : 0) |
    (unevaluatedRole(schema, 'items') === 'closing' ? CLOSING_ITEMS : 0)
  );
}

function compareResolved(
  ctx: Context,
  oldValue: JsonValue,
  newValue: JsonValue,
  path: string,
): void {
  if (jsonEqual(oldValue, newValue) && refsStable(ctx, oldValue, newValue)) {
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
  const savedClosing = ctx.closing;
  ctx.closing |= closingBits(o) | closingBits(n);
  try {
    compareKeywords(ctx, o, n, path);
  } finally {
    ctx.closing = savedClosing;
  }
}

function compareKeywords(ctx: Context, o: JsonObject, n: JsonObject, path: string): void {
  if (liftUnion(ctx, o, n, path) || liftAllOf(ctx, o, n, path)) {
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

/**
 * `unevaluatedProperties`/`unevaluatedItems` are compared by the object and
 * array rules when, on both sides, they either do not matter or act exactly
 * like `additionalProperties`/`items` (see {@link unevaluatedRole}).
 */
function modelledUnevaluated(keyword: string, o: JsonObject, n: JsonObject): boolean {
  const kind =
    keyword === 'unevaluatedProperties'
      ? 'properties'
      : keyword === 'unevaluatedItems'
        ? 'items'
        : undefined;
  return (
    kind !== undefined &&
    unevaluatedRole(o, kind) !== 'closing' &&
    unevaluatedRole(n, kind) !== 'closing'
  );
}

function compareOpaqueKeywords(ctx: Context, o: JsonObject, n: JsonObject, path: string): void {
  const keywords = [...new Set([...Object.keys(o), ...Object.keys(n)])]
    .filter((keyword) => !HANDLED_KEYWORDS.has(keyword) && !modelledUnevaluated(keyword, o, n))
    .sort(compareCodeUnits);
  for (const keyword of keywords) {
    const before = get(o, keyword);
    const after = get(n, keyword);
    if (
      before !== undefined &&
      after !== undefined &&
      opaqueEquivalent(ctx, keyword, before, after, path)
    ) {
      // The documents differ (equal ones never get here), so the target may have.
      if (DYNAMIC_REFERENCE_KEYWORDS.has(keyword)) {
        emit(ctx, 'unknown', 'ref-unresolved', path, `${keyword} cannot be followed`, {
          reason:
            'mcp-contract does not resolve dynamic references, and the schemas differ elsewhere, so its target may have changed',
        });
      }
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
  const budget = { remaining: maxSteps, exhausted: false, tooDeep: false };
  const out: SchemaChange[] = [];
  let findings: Context['out'] = [];
  try {
    if (jsonEqual(oldSchema, newSchema)) {
      return []; // Equal documents: every reference means the same on both sides.
    }
    const ctx: Context = {
      direction: options.direction,
      oldRoot: oldSchema,
      newRoot: newSchema,
      oldDoc: indexDocument(oldSchema),
      newDoc: indexDocument(newSchema),
      stack: new Set(),
      judgment: 'report',
      closing: 0,
      depth: 0,
      stableRefs: new Map(),
      scopes: new Map(),
      budget,
      derived: new WeakMap(),
      out: findings,
      scope: [oldSchema],
      compare: (before, after, path, step) => {
        compareNodes(ctx, before, after, path, step);
      },
    };
    try {
      compareNodes(ctx, oldSchema, newSchema, '$', undefined);
    } finally {
      findings = ctx.out;
    }
  } catch (error) {
    // A last line of defence: the depth limit should make this unreachable.
    if (!(error instanceof RangeError) || !/call stack/i.test(error.message)) {
      throw error;
    }
    budget.exhausted = true;
    budget.tooDeep = true;
  }
  const seen = new Set<string>();
  for (const { effect, ...change } of findings) {
    const key = `${change.code}\u0000${change.path}\u0000${change.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(change);
    }
  }
  if (budget.exhausted) {
    out.push({
      severity: 'unknown',
      code: 'schema-too-complex',
      path: '$',
      message: budget.tooDeep
        ? `schema comparison stopped at nesting depth ${MAX_DEPTH}; the result is incomplete and may hide breaking changes`
        : `schema comparison stopped after ${maxSteps} steps; the result is incomplete and may hide breaking changes`,
    });
  }
  return out;
}
