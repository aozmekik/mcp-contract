/**
 * JSON value model and canonicalisation helpers.
 *
 * Snapshots must be byte-for-byte reproducible, so every value that ends up in
 * one goes through {@link canonicalize}: object keys are sorted by UTF-16 code
 * units (the ordering RFC 8785, JSON Canonicalization Scheme, uses) and
 * non-JSON values are rejected instead of being silently dropped.
 */

/** A JSON primitive. */
export type JsonPrimitive = string | number | boolean | null;

/** Any JSON value. */
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

/** A JSON object. */
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * Adds an own enumerable member to `object`. Unlike `object[key] = value`, this
 * also works for a key named `__proto__`, which JSON allows: assignment would
 * replace the object's prototype instead of creating a member.
 */
export function defineMember(object: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Returns true when `value` is a plain JSON object (not an array, not null). */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Error thrown when a value cannot be represented as JSON. */
export class NonJsonValueError extends TypeError {
  /** Location of the offending value, as a JSONPath-like string. */
  readonly path: string;

  /** Creates an error for the value found at `path`. */
  constructor(path: string, description: string) {
    super(`Value at ${path} is not JSON-serialisable: ${description}`);
    this.name = 'NonJsonValueError';
    this.path = path;
  }
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function canonicalizeAt(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new NonJsonValueError(path, `non-finite number ${String(value)}`);
    }
    // Normalise -0 to 0: JSON has a single zero.
    return value === 0 ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw new NonJsonValueError(path, `unsupported type ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new NonJsonValueError(path, 'circular reference');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item: unknown, index) =>
        canonicalizeAt(item, `${path}[${index}]`, ancestors),
      );
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new NonJsonValueError(path, 'not a plain object');
    }
    const result: JsonObject = {};
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record).sort(compareCodeUnits)) {
      const item = record[key];
      // `undefined` members are omitted, exactly like JSON.stringify does.
      if (item !== undefined) {
        defineMember(result, key, canonicalizeAt(item, childPath(path, key), ancestors));
      }
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/** Compares strings by UTF-16 code units, the key order mandated by RFC 8785. */
export function compareCodeUnits(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Returns a deep copy of `value` with object keys sorted recursively.
 *
 * @throws {NonJsonValueError} if `value` contains anything JSON cannot express
 *   (functions, symbols, bigints, non-finite numbers, class instances, cycles).
 */
export function canonicalize(value: unknown): JsonValue {
  return canonicalizeAt(value, '$', new Set());
}

/** Serialises `value` in canonical form without insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Structural equality for JSON values (object key order is irrelevant). */
export function jsonEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a)) {
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => jsonEqual(item, b[i] as JsonValue))
    );
  }
  if (isJsonObject(a)) {
    if (!isJsonObject(b)) {
      return false;
    }
    const keysA = Object.keys(a);
    if (keysA.length !== Object.keys(b).length) {
      return false;
    }
    return keysA.every(
      (key) => Object.hasOwn(b, key) && jsonEqual(a[key] as JsonValue, b[key] as JsonValue),
    );
  }
  return false;
}

/** Returns the JSON type name of `value` (`integer` is reported as `number`). */
export function jsonTypeOf(
  value: JsonValue,
): 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object' {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (typeof value === 'number') {
    return 'number';
  }
  return typeof value === 'string' ? 'string' : 'object';
}
