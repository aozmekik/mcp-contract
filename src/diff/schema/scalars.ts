/** `type`, `enum`/`const`, numeric bounds and string constraints. */
import { jsonEqual, type JsonObject, type JsonValue } from '../../core/json.ts';
import {
  emit,
  finite,
  formatValue,
  formatValues,
  get,
  plural,
  sameOptional,
  type Context,
} from './context.ts';

/** JSON Schema primitive type names. */
export const TYPE_NAMES = [
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
] as const;

/** One JSON Schema primitive type name. */
export type TypeName = (typeof TYPE_NAMES)[number];

function isTypeName(value: JsonValue): value is TypeName {
  return typeof value === 'string' && (TYPE_NAMES as readonly string[]).includes(value);
}

/** The types listed by `type`, or undefined when the keyword is absent. */
export function declaredTypes(schema: JsonObject): Set<TypeName> | undefined {
  const type = get(schema, 'type');
  if (typeof type === 'string') {
    return new Set(isTypeName(type) ? [type] : []);
  }
  if (Array.isArray(type)) {
    return new Set(type.filter(isTypeName));
  }
  return undefined;
}

/** The values allowed by `enum` and/or `const`, or undefined when neither is present. */
export function enumValues(schema: JsonObject): JsonValue[] | undefined {
  const values = get(schema, 'enum');
  const constant = get(schema, 'const');
  const list = Array.isArray(values) ? values : undefined;
  if (constant === undefined) {
    return list;
  }
  return list === undefined ? [constant] : list.filter((value) => jsonEqual(value, constant));
}

function valueType(value: JsonValue): TypeName {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  if (typeof value === 'string') {
    return 'string';
  }
  return typeof value === 'boolean' ? 'boolean' : 'object';
}

function coversType(types: ReadonlySet<TypeName>, type: TypeName): boolean {
  return types.has(type) || (type === 'integer' && types.has('number'));
}

/** Types an instance can have: `type` intersected with the types of `enum` values. */
export function effectiveTypes(schema: JsonObject): Set<TypeName> {
  const declared = declaredTypes(schema) ?? new Set(TYPE_NAMES);
  const values = enumValues(schema);
  if (values === undefined) {
    return declared;
  }
  return new Set(values.map(valueType).filter((type) => coversType(declared, type)));
}

function describeTypes(types: readonly TypeName[], others: ReadonlySet<TypeName>): string {
  return types
    .map((type) => (type === 'number' && others.has('integer') ? 'non-integer numbers' : type))
    .join(', ');
}

/** Compares the sets of accepted JSON types. */
export function compareTypes(ctx: Context, o: JsonObject, n: JsonObject, path: string): void {
  const oldValues = enumValues(o);
  const newValues = enumValues(n);
  if (oldValues !== undefined && newValues !== undefined) {
    return; // The enum/const comparison is exact and reports everything.
  }
  const oldTypes = effectiveTypes(o);
  const newTypes = effectiveTypes(n);
  const removed = TYPE_NAMES.filter((type) => oldTypes.has(type) && !coversType(newTypes, type));
  const added = TYPE_NAMES.filter((type) => newTypes.has(type) && !coversType(oldTypes, type));
  const before = get(o, 'type');
  const after = get(n, 'type');
  // When only one side has enum/const, compareEnums already reports the
  // restriction (or its removal); only report what it does not cover.
  if (removed.length > 0 && newValues === undefined) {
    const unconstrained = declaredTypes(o) === undefined && oldValues === undefined;
    const types = describeTypes(removed, newTypes);
    const what = unconstrained
      ? `type restricted to ${[...newTypes].join(', ')}`
      : ctx.direction === 'input'
        ? `no longer accepts ${types}`
        : `can no longer be ${types}`;
    emit(ctx, 'narrow', 'type-narrowed', path, what, { before, after });
  }
  if (added.length > 0 && oldValues === undefined) {
    const unconstrained = declaredTypes(n) === undefined && newValues === undefined;
    const types = describeTypes(added, oldTypes);
    const what = unconstrained
      ? 'type restriction removed'
      : ctx.direction === 'input'
        ? `now also accepts ${types}`
        : `may now also be ${types}`;
    emit(ctx, 'widen', 'type-widened', path, what, { before, after });
  }
}

/**
 * The enum/const values an instance can actually take: values whose JSON type
 * is excluded by `type` can never validate, so they are dropped.
 */
function effectiveValues(schema: JsonObject): JsonValue[] | undefined {
  const values = enumValues(schema);
  const declared = declaredTypes(schema);
  if (values === undefined || declared === undefined) {
    return values;
  }
  return values.filter((value) => coversType(declared, valueType(value)));
}

/** Compares `enum`/`const` value sets. */
export function compareEnums(ctx: Context, o: JsonObject, n: JsonObject, path: string): void {
  const oldValues = effectiveValues(o);
  const newValues = effectiveValues(n);
  if (oldValues === undefined && newValues === undefined) {
    return;
  }
  if (oldValues === undefined) {
    const values = newValues ?? [];
    emit(ctx, 'narrow', 'enum-narrowed', path, `values restricted to ${formatValues(values)}`, {
      after: values,
    });
    return;
  }
  if (newValues === undefined) {
    emit(ctx, 'widen', 'enum-widened', path, `no longer restricted to ${formatValues(oldValues)}`, {
      before: oldValues,
    });
    return;
  }
  const removed = oldValues.filter((value) => !newValues.some((other) => jsonEqual(value, other)));
  const added = newValues.filter((value) => !oldValues.some((other) => jsonEqual(value, other)));
  if (removed.length > 0) {
    emit(
      ctx,
      'narrow',
      'enum-narrowed',
      path,
      `${plural(removed.length, 'value')} ${formatValues(removed)} no longer allowed`,
      { before: removed },
    );
  }
  if (added.length > 0) {
    emit(
      ctx,
      'widen',
      'enum-widened',
      path,
      `${plural(added.length, 'value')} ${formatValues(added)} now allowed`,
      { after: added },
    );
  }
}

interface Bound {
  readonly value: number;
  readonly exclusive: boolean;
}

type Side = 'lower' | 'upper';

function tightestBound(candidates: readonly Bound[], side: Side): Bound | undefined {
  let best: Bound | undefined;
  for (const candidate of candidates) {
    if (best === undefined) {
      best = candidate;
      continue;
    }
    const tighter = side === 'lower' ? candidate.value > best.value : candidate.value < best.value;
    if (tighter || (candidate.value === best.value && candidate.exclusive && !best.exclusive)) {
      best = candidate;
    }
  }
  return best;
}

function numericBound(schema: JsonObject, side: Side): Bound | undefined {
  const inclusiveKeyword = side === 'lower' ? 'minimum' : 'maximum';
  const exclusiveKeyword = side === 'lower' ? 'exclusiveMinimum' : 'exclusiveMaximum';
  const candidates: Bound[] = [];
  const inclusive = finite(get(schema, inclusiveKeyword));
  if (inclusive !== undefined) {
    // draft-04 spelled exclusivity as a boolean flag next to minimum/maximum.
    candidates.push({ value: inclusive, exclusive: get(schema, exclusiveKeyword) === true });
  }
  const exclusive = finite(get(schema, exclusiveKeyword));
  if (exclusive !== undefined) {
    candidates.push({ value: exclusive, exclusive: true });
  }
  return tightestBound(candidates, side);
}

function compareBound(
  ctx: Context,
  path: string,
  label: string,
  side: Side,
  bounds: { readonly before: Bound | undefined; readonly after: Bound | undefined },
  format: (bound: Bound) => string,
): void {
  const { before, after } = bounds;
  if (before === undefined) {
    if (after !== undefined) {
      emit(ctx, 'narrow', 'constraint-tightened', path, `${label} added (${format(after)})`);
    }
    return;
  }
  if (after === undefined) {
    emit(ctx, 'widen', 'constraint-loosened', path, `${label} removed (was ${format(before)})`);
    return;
  }
  const delta = (after.value - before.value) * (side === 'lower' ? 1 : -1);
  const change = (verb: string): string =>
    `${label} ${verb} from ${format(before)} to ${format(after)}`;
  if (delta > 0 || (delta === 0 && after.exclusive && !before.exclusive)) {
    emit(ctx, 'narrow', 'constraint-tightened', path, change('tightened'));
  } else if (delta < 0 || (delta === 0 && !after.exclusive && before.exclusive)) {
    emit(ctx, 'widen', 'constraint-loosened', path, change('loosened'));
  }
}

function countBound(schema: JsonObject, keyword: string): Bound | undefined {
  const value = finite(get(schema, keyword));
  return value === undefined ? undefined : { value, exclusive: false };
}

/** Compares an inclusive count pair such as minLength/maxLength or minItems/maxItems. */
export function compareCounts(
  ctx: Context,
  o: JsonObject,
  n: JsonObject,
  path: string,
  keywords: readonly [min: string, max: string],
): void {
  const plain = (bound: Bound): string => String(bound.value);
  const [min, max] = keywords;
  compareBound(
    ctx,
    path,
    min,
    'lower',
    { before: countBound(o, min), after: countBound(n, min) },
    plain,
  );
  compareBound(
    ctx,
    path,
    max,
    'upper',
    { before: countBound(o, max), after: countBound(n, max) },
    plain,
  );
}

function isWholeMultiple(value: number, divisor: number): boolean {
  const ratio = value / divisor;
  return Math.abs(ratio - Math.round(ratio)) < 1e-9 * Math.max(1, Math.abs(ratio));
}

/** Compares minimum/maximum (inclusive and exclusive, 2020-12 and draft-04) and multipleOf. */
export function compareNumbers(ctx: Context, o: JsonObject, n: JsonObject, path: string): void {
  for (const side of ['lower', 'upper'] as const) {
    compareBound(
      ctx,
      path,
      `${side} bound`,
      side,
      { before: numericBound(o, side), after: numericBound(n, side) },
      (bound) => {
        const strict = side === 'lower' ? '>' : '<';
        return `${bound.exclusive ? strict : `${strict}=`} ${bound.value}`;
      },
    );
  }
  const before = finite(get(o, 'multipleOf'));
  const after = finite(get(n, 'multipleOf'));
  if (before === after) {
    return;
  }
  if (before === undefined) {
    emit(ctx, 'narrow', 'constraint-tightened', path, `multipleOf ${String(after)} added`, {
      after,
    });
  } else if (after === undefined) {
    emit(ctx, 'widen', 'constraint-loosened', path, `multipleOf ${before} removed`, { before });
  } else if (isWholeMultiple(before, after)) {
    emit(
      ctx,
      'widen',
      'constraint-loosened',
      path,
      `multipleOf relaxed from ${before} to ${after}`,
      { before, after },
    );
  } else if (isWholeMultiple(after, before)) {
    emit(
      ctx,
      'narrow',
      'constraint-tightened',
      path,
      `multipleOf tightened from ${before} to ${after}`,
      { before, after },
    );
  } else {
    emit(
      ctx,
      'incompatible',
      'constraint-changed',
      path,
      `multipleOf changed from ${before} to ${after}`,
      { before, after },
    );
  }
}

function compareAssertion(
  ctx: Context,
  o: JsonObject,
  n: JsonObject,
  path: string,
  keyword: 'pattern' | 'format',
): void {
  const before = get(o, keyword);
  const after = get(n, keyword);
  if (sameOptional(before, after)) {
    return;
  }
  if (before === undefined) {
    if (after !== undefined) {
      emit(ctx, 'narrow', 'constraint-tightened', path, `${keyword} ${formatValue(after)} added`, {
        after,
      });
    }
    return;
  }
  if (after === undefined) {
    emit(ctx, 'widen', 'constraint-loosened', path, `${keyword} ${formatValue(before)} removed`, {
      before,
    });
    return;
  }
  emit(
    ctx,
    'unknown',
    'constraint-changed',
    path,
    `${keyword} changed from ${formatValue(before)} to ${formatValue(after)}`,
    {
      before,
      after,
      reason:
        keyword === 'pattern'
          ? 'mcp-contract cannot decide whether one regular expression accepts everything another one does'
          : 'formats are not ordered, so the effect of the change cannot be determined',
    },
  );
}

/** Compares minLength/maxLength, pattern and format. */
export function compareStrings(ctx: Context, o: JsonObject, n: JsonObject, path: string): void {
  compareCounts(ctx, o, n, path, ['minLength', 'maxLength']);
  compareAssertion(ctx, o, n, path, 'pattern');
  compareAssertion(ctx, o, n, path, 'format');
}
