/**
 * Shared state and helpers for the schema comparison modules.
 *
 * The recursive entry point is reached through `ctx.compare`, so the keyword
 * modules (scalars, structures, composition) depend only on this file and
 * never on each other or on the dispatcher.
 */
import { jsonEqual, type JsonObject, type JsonValue } from '../../core/json.ts';
import type { ChangeCode, SchemaDirection, Severity } from '../model.ts';
import type { SchemaDocument } from './refs.ts';

/** A classified difference inside one schema. */
export interface SchemaChange {
  /** Impact on clients for the analysed direction. */
  readonly severity: Severity;
  /** Stable identifier of the rule that fired. */
  readonly code: ChangeCode;
  /** Instance path, e.g. `$.filters[*].tag`; `$` is the schema root. */
  readonly path: string;
  /** Human explanation. */
  readonly message: string;
  /** Previous value of the changed keyword, when meaningful. */
  readonly before?: JsonValue;
  /** New value of the changed keyword, when meaningful. */
  readonly after?: JsonValue;
}

/**
 * What a change does to the set of accepted instances, independent of
 * direction. `annotation` changes never affect validation.
 */
export type Effect = 'widen' | 'narrow' | 'incompatible' | 'unknown' | 'annotation';

/** A change plus the effect it was derived from. */
export interface Finding extends SchemaChange {
  /** Direction-independent effect. */
  readonly effect: Effect;
}

/**
 * How a recursive comparison moves through the instance: into a member, into
 * array items, into undeclared members, or into property names. A comparison
 * without a step stays at the same instance location (an alternative of
 * `anyOf`, a `$ref` target, ...).
 */
export type Step =
  | { readonly kind: 'property'; readonly key: string }
  | { readonly kind: 'items'; readonly index: number | undefined }
  | { readonly kind: 'additional' }
  | { readonly kind: 'names' };

/**
 * The question a comparison answers. `report` collects the findings of the
 * run; `equivalent` and `compatible` are the yes/no questions that pair union
 * alternatives and check coverage. Cycle hypotheses are kept per question: a
 * pair assumed compatible while reporting cannot be assumed equivalent.
 */
export type Judgment = 'report' | 'equivalent' | 'compatible';

/** Bits of {@link Context.closing}. */
export const CLOSING_PROPERTIES = 1;
/** Bits of {@link Context.closing}. */
export const CLOSING_ITEMS = 2;

/** Mutable state of one {@link diffSchemas} run. */
export interface Context {
  /** Direction under analysis. */
  readonly direction: SchemaDirection;
  /** Root of the old schema. */
  readonly oldRoot: JsonValue;
  /** Root of the new schema. */
  readonly newRoot: JsonValue;
  /** The old schema, indexed for `$ref` resolution. */
  readonly oldDoc: SchemaDocument;
  /** The new schema, indexed for `$ref` resolution. */
  readonly newDoc: SchemaDocument;
  /** Pairs currently being compared, per judgment (coinductive cycle detection). */
  readonly stack: Set<string>;
  /** The question the current comparison answers. */
  judgment: Judgment;
  /**
   * Set while an `unevaluatedProperties` ({@link CLOSING_PROPERTIES}) or
   * `unevaluatedItems` ({@link CLOSING_ITEMS}) keyword whose effect is not
   * modelled applies at the current instance location, on either side.
   */
  closing: number;
  /** Nesting depth of the current comparison. */
  depth: number;
  /** Remaining comparison steps; `exhausted` is also set when the depth limit is hit. */
  readonly budget: { remaining: number; exhausted: boolean; tooDeep: boolean };
  /** Memo for objects derived from schema nodes, keyed by node and purpose. */
  readonly derived: WeakMap<object, Map<string, JsonValue>>;
  /** Memo: does this reference point at the same definition, transitively, in both schemas? */
  readonly stableRefs: Map<string, boolean>;
  /** Memo: child scopes by parent scope key and step, so equal scopes share one array. */
  readonly scopes: Map<string, readonly JsonValue[]>;
  /** Findings collected so far; swapped out by {@link scratch}. */
  out: Finding[];
  /**
   * Old subschemas that apply at the current instance location (before
   * expanding combinators). Used to decide whether a property that the new
   * schema adds is one that clients may already send.
   */
  scope: readonly JsonValue[];
  /**
   * Compares two subschemas; the recursive entry point. `step` says how the
   * instance location changes; omit it for alternatives of the same location.
   */
  readonly compare: (oldSchema: JsonValue, newSchema: JsonValue, path: string, step?: Step) => void;
}

/** Optional parts of a finding. */
export interface EmitDetails {
  /** Previous value. */
  readonly before?: JsonValue | undefined;
  /** New value. */
  readonly after?: JsonValue | undefined;
  /** Replaces the generic consequence sentence. */
  readonly reason?: string;
  /** Overrides the severity derived from the effect and direction. */
  readonly severity?: Severity;
}

function severityOf(effect: Effect, direction: SchemaDirection): Severity {
  switch (effect) {
    case 'annotation':
      return 'non-breaking';
    case 'unknown':
      return 'unknown';
    case 'incompatible':
      return 'breaking';
    case 'widen':
      return direction === 'input' ? 'non-breaking' : 'breaking';
    case 'narrow':
      return direction === 'input' ? 'breaking' : 'non-breaking';
  }
}

function consequence(direction: SchemaDirection, severity: Severity): string {
  if (direction === 'input') {
    return severity === 'breaking'
      ? 'arguments that were valid before can now be rejected'
      : 'arguments that were valid before are still accepted';
  }
  return severity === 'breaking'
    ? 'results can now contain values that clients written against the old schema do not expect'
    : 'results stay within what clients already handle';
}

/** Records a finding; the severity follows from the effect and the direction unless overridden. */
export function emit(
  ctx: Context,
  effect: Effect,
  code: ChangeCode,
  path: string,
  what: string,
  details: EmitDetails = {},
): void {
  const severity = details.severity ?? severityOf(effect, ctx.direction);
  let message = what;
  if (details.reason !== undefined) {
    message = `${what}; ${details.reason}`;
  } else if (effect !== 'annotation' && effect !== 'unknown') {
    message = `${what}; ${consequence(ctx.direction, severity)}`;
  }
  ctx.out.push({
    severity,
    code,
    path,
    message,
    effect,
    ...(details.before === undefined ? {} : { before: details.before }),
    ...(details.after === undefined ? {} : { after: details.after }),
  });
}

/** Runs `fn` with a private findings buffer and returns what it found. */
export function scratch(ctx: Context, fn: () => void): Finding[] {
  const saved = ctx.out;
  ctx.out = [];
  try {
    fn();
    return ctx.out;
  } finally {
    ctx.out = saved;
  }
}

/** Read through a function: comparisons mutate the budget behind the type checker's back. */
function exhausted(ctx: Context): boolean {
  return ctx.budget.exhausted;
}

/**
 * Answers a yes/no question about `a` and `b` with a private findings buffer
 * and its own cycle hypotheses. A question the budget cut short is answered
 * "no", because the part that was not compared might differ.
 */
function ask(
  ctx: Context,
  judgment: Exclude<Judgment, 'report'>,
  accept: (finding: Finding) => boolean,
  run: () => void,
): boolean {
  if (exhausted(ctx)) {
    return false;
  }
  const saved = ctx.judgment;
  ctx.judgment = judgment;
  try {
    const findings = scratch(ctx, run);
    return !exhausted(ctx) && findings.every(accept);
  } finally {
    ctx.judgment = saved;
  }
}

/** True when the two schemas accept exactly the same values (annotations may differ). */
export function equivalent(
  ctx: Context,
  a: JsonValue,
  b: JsonValue,
  path: string,
  step?: Step,
): boolean {
  return ask(
    ctx,
    'equivalent',
    (finding) => finding.effect === 'annotation',
    () => {
      ctx.compare(a, b, path, step);
    },
  );
}

/** True when replacing `a` by `b` is non-breaking in the context's direction. */
export function compatible(
  ctx: Context,
  a: JsonValue,
  b: JsonValue,
  path: string,
  step?: Step,
): boolean {
  return ask(
    ctx,
    'compatible',
    (finding) => finding.severity === 'non-breaking',
    () => {
      ctx.compare(a, b, path, step);
    },
  );
}

/** Returns the object derived from `node` for `purpose`, computing it once per run. */
export function derive<T extends JsonValue>(
  ctx: Context,
  node: JsonObject,
  purpose: string,
  compute: () => T,
): T {
  let entries = ctx.derived.get(node);
  if (entries === undefined) {
    entries = new Map();
    ctx.derived.set(node, entries);
  }
  let value = entries.get(purpose) as T | undefined;
  if (value === undefined) {
    value = compute();
    entries.set(purpose, value);
  }
  return value;
}

const identities = new WeakMap<object, number>();
let nextIdentity = 0;

/** Stable identity of a schema node, used to recognise pairs already on the stack. */
export function identity(value: JsonValue): string {
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

/** True for the two shapes a JSON Schema can take: an object or a boolean. */
export function isSchema(value: JsonValue): value is JsonObject | boolean {
  return (
    typeof value === 'boolean' ||
    (typeof value === 'object' && value !== null && !Array.isArray(value))
  );
}

/** Own-property lookup that never reads from the prototype chain. */
export function get(schema: JsonObject, key: string): JsonValue | undefined {
  return Object.hasOwn(schema, key) ? schema[key] : undefined;
}

/** Equality for values that may be absent. */
export function sameOptional(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return jsonEqual(a, b);
}

/** Returns `value` when it is a finite number. */
export function finite(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Short JSON rendering for messages. */
export function formatValue(value: JsonValue): string {
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** Renders at most five values for messages. */
export function formatValues(values: readonly JsonValue[]): string {
  const shown = values.slice(0, 5).map(formatValue).join(', ');
  return values.length > 5 ? `${shown} and ${values.length - 5} more` : shown;
}

/** English plural for counts in messages. */
export function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/** Appends an object member to an instance path. */
export function propertyPath(path: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

/** Describes a keyword change as added, removed or changed. */
export function describeChange(
  keyword: string,
  before: JsonValue | undefined,
  after: JsonValue | undefined,
): string {
  if (before === undefined) {
    return `${keyword} added`;
  }
  if (after === undefined) {
    return `${keyword} removed`;
  }
  return `${keyword} changed`;
}
