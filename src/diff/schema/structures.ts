/**
 * Arrays (`items`, `prefixItems`, draft-07 tuples) and objects (`properties`,
 * `required`, `additionalProperties`, `patternProperties`, `propertyNames`).
 *
 * Interacting keywords are always analysed together: whether removing a
 * property breaks a request depends on `additionalProperties` of the *new*
 * schema, and whether adding one is safe depends on `additionalProperties`
 * of the *old* schema.
 *
 * `unevaluatedProperties`/`unevaluatedItems` take the place of
 * `additionalProperties`/`items` when nothing else evaluates members (see
 * `unevaluatedRole`). When one applies whose effect is not modelled (the
 * context's `closing` bits), a member that falls back to the default "anything
 * goes" on one side only may in fact be rejected there, so such changes are
 * `unknown`.
 */
import {
  compareCodeUnits,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from '../../core/json.ts';
import {
  CLOSING_ITEMS,
  CLOSING_PROPERTIES,
  emit,
  equivalent,
  get,
  isSchema,
  propertyPath,
  type Context,
} from './context.ts';
import { unevaluatedRole } from './refs.ts';
import { compareCounts } from './scalars.ts';
import { declaredInScope } from './scope.ts';

interface ArrayShape {
  readonly prefix: readonly JsonValue[];
  /** Schema for items after the prefix. */
  readonly rest: JsonValue;
  /** True when no keyword says anything about items after the prefix. */
  readonly restIsDefault: boolean;
}

function arrayShape(schema: JsonObject): ArrayShape {
  const items = get(schema, 'items');
  const fallback =
    unevaluatedRole(schema, 'items') === 'rest' ? get(schema, 'unevaluatedItems') : undefined;
  const shape = (prefix: readonly JsonValue[], rest: JsonValue | undefined): ArrayShape => {
    const chosen = rest ?? fallback;
    return { prefix, rest: chosen ?? true, restIsDefault: chosen === undefined };
  };
  if (Array.isArray(items)) {
    // draft-04 to 2019-09 tuple form.
    return shape(items, get(schema, 'additionalItems'));
  }
  const prefixItems = get(schema, 'prefixItems');
  return shape(Array.isArray(prefixItems) ? prefixItems : [], items);
}

function unevaluatedItemsUnknown(ctx: Context, path: string): void {
  emit(ctx, 'unknown', 'keyword-changed', path, 'item schema changed under unevaluatedItems', {
    reason:
      'whether unevaluatedItems still accepts this item depends on which subschemas evaluate it, which mcp-contract does not track',
  });
}

/** Compares item schemas position by position, then the schema for the remaining items. */
export function compareArrays(ctx: Context, o: JsonObject, n: JsonObject, path: string): void {
  const before = arrayShape(o);
  const after = arrayShape(n);
  const closing = (ctx.closing & CLOSING_ITEMS) !== 0;
  const length = Math.max(before.prefix.length, after.prefix.length);
  for (let index = 0; index < length; index += 1) {
    const oldItem = before.prefix[index];
    const newItem = after.prefix[index];
    if (
      closing &&
      ((oldItem === undefined && before.restIsDefault) ||
        (newItem === undefined && after.restIsDefault))
    ) {
      unevaluatedItemsUnknown(ctx, `${path}[${index}]`);
      continue;
    }
    ctx.compare(oldItem ?? before.rest, newItem ?? after.rest, `${path}[${index}]`, {
      kind: 'items',
      index,
    });
  }
  if (closing && before.restIsDefault !== after.restIsDefault) {
    unevaluatedItemsUnknown(ctx, `${path}[*]`);
  } else {
    ctx.compare(before.rest, after.rest, `${path}[*]`, { kind: 'items', index: undefined });
  }
  compareCounts(ctx, o, n, path, ['minItems', 'maxItems']);
  const wasUnique = get(o, 'uniqueItems') === true;
  const isUnique = get(n, 'uniqueItems') === true;
  if (!wasUnique && isUnique) {
    emit(ctx, 'narrow', 'constraint-tightened', path, 'items must now be unique');
  } else if (wasUnique && !isUnique) {
    emit(ctx, 'widen', 'constraint-loosened', path, 'items no longer need to be unique');
  }
}

interface ObjectShape {
  readonly properties: ReadonlyMap<string, JsonValue>;
  readonly required: ReadonlySet<string>;
  /** Schema for undeclared properties. */
  readonly additional: JsonValue;
  /** True when no keyword says anything about undeclared properties. */
  readonly additionalIsDefault: boolean;
  readonly patterns: JsonObject;
}

function objectShape(schema: JsonObject): ObjectShape {
  const properties = get(schema, 'properties');
  const required = get(schema, 'required');
  const patterns = get(schema, 'patternProperties');
  const additional =
    get(schema, 'additionalProperties') ??
    (unevaluatedRole(schema, 'properties') === 'rest'
      ? get(schema, 'unevaluatedProperties')
      : undefined);
  return {
    properties: new Map(isJsonObject(properties) ? Object.entries(properties) : []),
    required: new Set(
      Array.isArray(required)
        ? required.filter((key): key is string => typeof key === 'string')
        : [],
    ),
    additional: additional ?? true,
    additionalIsDefault: additional === undefined,
    patterns: isJsonObject(patterns) ? patterns : {},
  };
}

type AdditionalKind = 'any' | 'none' | 'schema';

function additionalKind(schema: JsonValue): AdditionalKind {
  if (schema === true || (isJsonObject(schema) && Object.keys(schema).length === 0)) {
    return 'any';
  }
  return schema === false ? 'none' : 'schema';
}

function matchesPattern(key: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, 'u').test(key);
    } catch {
      return true; // An invalid pattern might match anything; stay conservative.
    }
  });
}

function equivalentMaps(ctx: Context, a: JsonObject, b: JsonObject, path: string): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => {
    const left = get(a, key);
    const right = get(b, key);
    return (
      left !== undefined &&
      right !== undefined &&
      equivalent(ctx, left, right, path, { kind: 'additional' })
    );
  });
}

function comparePresence(
  ctx: Context,
  key: string,
  path: string,
  wasRequired: boolean,
  isRequired: boolean,
): void {
  if (!wasRequired && isRequired) {
    emit(ctx, 'narrow', 'property-required', path, `\`${key}\` is now required`, {
      reason:
        ctx.direction === 'input'
          ? 'requests that omit it are now rejected'
          : 'results now always include it',
    });
  } else if (wasRequired && !isRequired) {
    emit(ctx, 'widen', 'property-optional', path, `\`${key}\` is now optional`, {
      reason:
        ctx.direction === 'input'
          ? 'requests that include it are still accepted'
          : 'results may now omit it',
    });
  }
}

interface PropertyChange {
  readonly key: string;
  readonly path: string;
  readonly schema: JsonValue;
  readonly wasRequired: boolean;
  readonly isRequired: boolean;
}

/**
 * True when undeclared properties at this location may have been validated by
 * a schema-valued `unevaluatedProperties` that is not modelled: old results
 * could then contain such a property, typed by that schema.
 */
function typedByUnevaluated(ctx: Context, before: ObjectShape): boolean {
  return (
    before.additionalIsDefault &&
    (ctx.closing & CLOSING_PROPERTIES) !== 0 &&
    declaredInScope(ctx.scope, ctx.oldDoc).typedUnevaluated
  );
}

function addedProperty(ctx: Context, change: PropertyChange, before: ObjectShape): void {
  const { key, path, schema, wasRequired, isRequired } = change;
  const oldAdditional = before.additional;
  const kind = additionalKind(oldAdditional);
  if (kind === 'schema') {
    // The key used to be validated by additionalProperties: compare against that.
    ctx.compare(oldAdditional, schema, path, { kind: 'property', key });
  }
  if (isRequired && !wasRequired) {
    emit(ctx, 'narrow', 'required-property-added', path, `new required property \`${key}\``, {
      reason:
        ctx.direction === 'input'
          ? 'requests without it are now rejected'
          : 'results now always include it',
    });
  } else if (kind === 'schema') {
    emit(
      ctx,
      'annotation',
      'property-added',
      path,
      `property \`${key}\` is now declared explicitly`,
    );
  } else if (ctx.direction === 'input') {
    // Assumption A1: clients only send properties the old schema declares at
    // this location, in this node or in any other subschema that applies here.
    const declared = declaredInScope(ctx.scope, ctx.oldDoc);
    if (declared.open || declared.keys.has(key)) {
      emit(ctx, 'unknown', 'property-added', path, `new property \`${key}\``, {
        reason: declared.open
          ? 'the old schema also accepts undeclared properties here, so clients may already send it'
          : 'another part of the old schema declares it here, so clients may already send it',
      });
    } else {
      emit(ctx, 'widen', 'property-added', path, `new optional property \`${key}\``, {
        reason: 'existing clients do not send it, so they are unaffected',
        severity: 'non-breaking',
      });
    }
  } else if (typedByUnevaluated(ctx, before)) {
    emit(ctx, 'unknown', 'property-added', path, `results may include the new field \`${key}\``, {
      reason:
        'old results could already contain it, validated by a schema-valued unevaluatedProperties, so clients may expect a different type',
    });
  } else {
    // Assumption A2: clients ignore result fields they do not know.
    emit(ctx, 'widen', 'property-added', path, `results may include the new field \`${key}\``, {
      reason: 'clients ignore fields they do not know',
      severity: 'non-breaking',
    });
  }
  if (wasRequired && !isRequired) {
    comparePresence(ctx, key, path, wasRequired, isRequired);
  }
}

function removedProperty(ctx: Context, change: PropertyChange, after: ObjectShape): void {
  const { key, path, schema, wasRequired, isRequired } = change;
  const newAdditional = after.additional;
  if (ctx.direction === 'output') {
    emit(ctx, 'narrow', 'property-removed', path, `field \`${key}\` removed`, {
      reason: 'clients that read it will no longer receive it',
      severity: 'breaking',
    });
  } else {
    const kind = additionalKind(newAdditional);
    if (after.additionalIsDefault && (ctx.closing & CLOSING_PROPERTIES) !== 0) {
      emit(ctx, 'unknown', 'property-removed', path, `property \`${key}\` is no longer declared`, {
        reason:
          'unevaluatedProperties applies here, so requests that include it may now be rejected, depending on which subschemas evaluate it',
      });
    } else if (kind === 'none') {
      emit(ctx, 'narrow', 'property-removed', path, `property \`${key}\` removed`, {
        reason: 'additionalProperties is false, so requests that include it are now rejected',
      });
    } else if (kind === 'any') {
      emit(ctx, 'widen', 'property-removed', path, `property \`${key}\` is no longer declared`, {
        reason: 'requests that include it are still accepted, but the server may ignore it',
      });
    } else {
      ctx.compare(schema, newAdditional, path, { kind: 'property', key });
      emit(
        ctx,
        'annotation',
        'property-removed',
        path,
        `property \`${key}\` is no longer declared and is now validated by additionalProperties`,
      );
    }
  }
  if (!wasRequired && isRequired) {
    comparePresence(ctx, key, path, wasRequired, isRequired);
  }
}

/**
 * Under an `unevaluatedProperties` that is not modelled, an absent
 * `additionalProperties` hands undeclared properties to it, while an explicit
 * one evaluates them itself. Returns true when that difference was reported.
 */
function compareClosedAdditional(
  ctx: Context,
  before: ObjectShape,
  after: ObjectShape,
  path: string,
): boolean {
  if (
    (ctx.closing & CLOSING_PROPERTIES) === 0 ||
    before.additionalIsDefault === after.additionalIsDefault
  ) {
    return false;
  }
  const explicit = additionalKind(
    before.additionalIsDefault ? after.additional : before.additional,
  );
  if (explicit === 'none') {
    return false; // Exactly like `true` -> `false` (or back): the general rule is right.
  }
  const typed = ctx.direction === 'output' && typedByUnevaluated(ctx, before);
  if (before.additionalIsDefault && explicit === 'any' && !typed) {
    emit(
      ctx,
      'widen',
      'additional-properties-allowed',
      path,
      'undeclared properties are now accepted here instead of being left to unevaluatedProperties',
      {
        severity: 'non-breaking',
        ...(ctx.direction === 'output' ? { reason: 'clients ignore fields they do not know' } : {}),
      },
    );
    return true;
  }
  emit(
    ctx,
    'unknown',
    'keyword-changed',
    path,
    'additionalProperties changed under unevaluatedProperties',
    {
      reason:
        'undeclared properties are now validated by a different keyword, and whether unevaluatedProperties accepts them depends on which subschemas evaluate them',
    },
  );
  return true;
}

function compareAdditional(ctx: Context, before: JsonValue, after: JsonValue, path: string): void {
  const oldKind = additionalKind(before);
  const newKind = additionalKind(after);
  if (oldKind === 'schema' || newKind === 'schema') {
    ctx.compare(before, after, `${path}.*`, { kind: 'additional' });
    return;
  }
  if (oldKind === 'any' && newKind === 'none') {
    emit(
      ctx,
      'narrow',
      'additional-properties-restricted',
      path,
      'additionalProperties is now false',
      {
        reason:
          ctx.direction === 'input'
            ? 'requests with undeclared properties are now rejected'
            : 'results no longer contain undeclared fields',
      },
    );
  } else if (oldKind === 'none' && newKind === 'any') {
    emit(
      ctx,
      'widen',
      'additional-properties-allowed',
      path,
      'undeclared properties are now allowed',
      {
        // Assumption A2 again for results.
        ...(ctx.direction === 'output'
          ? { reason: 'clients ignore fields they do not know', severity: 'non-breaking' as const }
          : {}),
      },
    );
  }
}

/** Compares declared properties, required-ness, additional and pattern properties. */
export function compareObjects(ctx: Context, o: JsonObject, n: JsonObject, path: string): void {
  const before = objectShape(o);
  const after = objectShape(n);
  const patterns = [...new Set([...Object.keys(before.patterns), ...Object.keys(after.patterns)])];
  if (!equivalentMaps(ctx, before.patterns, after.patterns, path)) {
    emit(ctx, 'unknown', 'keyword-changed', path, 'patternProperties changed', {
      reason: 'mcp-contract does not compare properties keyed by regular expressions',
    });
  }

  const keys = [
    ...new Set([
      ...before.properties.keys(),
      ...after.properties.keys(),
      ...before.required,
      ...after.required,
    ]),
  ].sort(compareCodeUnits);

  for (const key of keys) {
    const keyPath = propertyPath(path, key);
    const oldProperty = before.properties.get(key);
    const newProperty = after.properties.get(key);
    const wasRequired = before.required.has(key);
    const isRequired = after.required.has(key);
    if (oldProperty !== undefined && newProperty !== undefined) {
      ctx.compare(oldProperty, newProperty, keyPath, { kind: 'property', key });
      comparePresence(ctx, key, keyPath, wasRequired, isRequired);
    } else if (oldProperty === undefined && newProperty === undefined) {
      comparePresence(ctx, key, keyPath, wasRequired, isRequired);
    } else if (!isSchema(newProperty ?? oldProperty ?? true)) {
      emit(ctx, 'unknown', 'invalid-schema', keyPath, `property \`${key}\` changed`, {
        reason: 'its schema is not a valid JSON Schema (expected an object or a boolean)',
      });
    } else if (matchesPattern(key, patterns)) {
      const added = newProperty !== undefined;
      emit(
        ctx,
        'unknown',
        added ? 'property-added' : 'property-removed',
        keyPath,
        `property \`${key}\` ${added ? 'added' : 'removed'}`,
        { reason: 'the property name is also matched by patternProperties' },
      );
    } else if (newProperty !== undefined) {
      const change = { key, path: keyPath, schema: newProperty, wasRequired, isRequired };
      addedProperty(ctx, change, before);
    } else if (oldProperty !== undefined) {
      const change = { key, path: keyPath, schema: oldProperty, wasRequired, isRequired };
      removedProperty(ctx, change, after);
    }
  }

  if (!compareClosedAdditional(ctx, before, after, path)) {
    compareAdditional(ctx, before.additional, after.additional, path);
  }
  compareCounts(ctx, o, n, path, ['minProperties', 'maxProperties']);
  const oldNames = get(o, 'propertyNames');
  const newNames = get(n, 'propertyNames');
  if (oldNames !== undefined || newNames !== undefined) {
    ctx.compare(oldNames ?? true, newNames ?? true, `${path} (property names)`, { kind: 'names' });
  }
}
