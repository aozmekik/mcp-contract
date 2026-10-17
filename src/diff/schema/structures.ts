/**
 * Arrays (`items`, `prefixItems`, draft-07 tuples) and objects (`properties`,
 * `required`, `additionalProperties`, `patternProperties`, `propertyNames`).
 *
 * Interacting keywords are always analysed together: whether removing a
 * property breaks a request depends on `additionalProperties` of the *new*
 * schema, and whether adding one is safe depends on `additionalProperties`
 * of the *old* schema.
 */
import {
  compareCodeUnits,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from '../../core/json.ts';
import { emit, equivalent, get, isSchema, propertyPath, type Context } from './context.ts';
import { compareCounts } from './scalars.ts';
import { declaredInScope } from './scope.ts';

interface ArrayShape {
  readonly prefix: readonly JsonValue[];
  readonly rest: JsonValue;
}

function arrayShape(schema: JsonObject): ArrayShape {
  const items = get(schema, 'items');
  if (Array.isArray(items)) {
    // draft-04 to 2019-09 tuple form.
    return { prefix: items, rest: get(schema, 'additionalItems') ?? true };
  }
  const prefixItems = get(schema, 'prefixItems');
  return { prefix: Array.isArray(prefixItems) ? prefixItems : [], rest: items ?? true };
}

/** Compares item schemas position by position, then the schema for the remaining items. */
export function compareArrays(ctx: Context, o: JsonObject, n: JsonObject, path: string): void {
  const before = arrayShape(o);
  const after = arrayShape(n);
  const length = Math.max(before.prefix.length, after.prefix.length);
  for (let index = 0; index < length; index += 1) {
    ctx.compare(
      before.prefix[index] ?? before.rest,
      after.prefix[index] ?? after.rest,
      `${path}[${index}]`,
      { kind: 'items', index },
    );
  }
  ctx.compare(before.rest, after.rest, `${path}[*]`, { kind: 'items', index: undefined });
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
  readonly additional: JsonValue;
  readonly patterns: JsonObject;
}

function objectShape(schema: JsonObject): ObjectShape {
  const properties = get(schema, 'properties');
  const required = get(schema, 'required');
  const patterns = get(schema, 'patternProperties');
  return {
    properties: new Map(isJsonObject(properties) ? Object.entries(properties) : []),
    required: new Set(
      Array.isArray(required)
        ? required.filter((key): key is string => typeof key === 'string')
        : [],
    ),
    additional: get(schema, 'additionalProperties') ?? true,
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

function addedProperty(ctx: Context, change: PropertyChange, oldAdditional: JsonValue): void {
  const { key, path, schema, wasRequired, isRequired } = change;
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
    const declared = declaredInScope(ctx.scope, ctx.oldRoot);
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

function removedProperty(ctx: Context, change: PropertyChange, newAdditional: JsonValue): void {
  const { key, path, schema, wasRequired, isRequired } = change;
  if (ctx.direction === 'output') {
    emit(ctx, 'narrow', 'property-removed', path, `field \`${key}\` removed`, {
      reason: 'clients that read it will no longer receive it',
      severity: 'breaking',
    });
  } else {
    const kind = additionalKind(newAdditional);
    if (kind === 'none') {
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
      addedProperty(ctx, change, before.additional);
    } else if (oldProperty !== undefined) {
      const change = { key, path: keyPath, schema: oldProperty, wasRequired, isRequired };
      removedProperty(ctx, change, after.additional);
    }
  }

  compareAdditional(ctx, before.additional, after.additional, path);
  compareCounts(ctx, o, n, path, ['minProperties', 'maxProperties']);
  const oldNames = get(o, 'propertyNames');
  const newNames = get(n, 'propertyNames');
  if (oldNames !== undefined || newNames !== undefined) {
    ctx.compare(oldNames ?? true, newNames ?? true, `${path} (property names)`, { kind: 'names' });
  }
}
