/**
 * Expectation matching for scenario results.
 *
 * An expected value is either a literal or an operator object (an object whose
 * keys all start with `$`):
 *
 * - literal objects match when every listed key matches (extra keys in the
 *   actual value are fine), arrays match element by element with equal length,
 *   primitives match by equality;
 * - operators: `$equals` (exact deep equality), `$regex` (+ optional `$flags`),
 *   `$type`, `$length`, `$contains`, `$exists`, `$gt`, `$gte`, `$lt`, `$lte`.
 */
import {
  isJsonObject,
  jsonEqual,
  jsonTypeOf,
  type JsonObject,
  type JsonValue,
} from '../core/json.ts';

/** Names accepted by the `$type` operator. */
export const MATCH_TYPES = [
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
] as const;

const OPERATORS: ReadonlySet<string> = new Set([
  '$contains',
  '$equals',
  '$exists',
  '$flags',
  '$gt',
  '$gte',
  '$length',
  '$lt',
  '$lte',
  '$regex',
  '$type',
]);

/** A mismatch between an actual value and an expectation. */
export interface Mismatch {
  /** Location in the actual value. */
  readonly path: string;
  /** What was expected and what was found. */
  readonly reason: string;
}

/** True when `value` is an operator object such as `{ $regex: "^ok" }`. */
export function isOperatorObject(value: JsonValue): value is JsonObject {
  if (!isJsonObject(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith('$'));
}

/**
 * Checks that an expectation is well formed and returns a list of problems
 * (empty when valid). Used when loading scenario files, so mistakes surface
 * before any server is started.
 */
export function validateExpectation(expected: JsonValue, path = '$'): string[] {
  if (Array.isArray(expected)) {
    return expected.flatMap((item, index) => validateExpectation(item, `${path}[${index}]`));
  }
  if (!isJsonObject(expected)) {
    return [];
  }
  const keys = Object.keys(expected);
  const operatorKeys = keys.filter((key) => key.startsWith('$'));
  if (operatorKeys.length === 0) {
    return keys.flatMap((key) => validateExpectation(expected[key] as JsonValue, `${path}.${key}`));
  }
  if (operatorKeys.length !== keys.length) {
    return [`${path}: an object cannot mix operators (${operatorKeys.join(', ')}) with plain keys`];
  }
  const problems: string[] = [];
  for (const key of keys) {
    const value = expected[key] as JsonValue;
    if (!OPERATORS.has(key)) {
      problems.push(`${path}: unknown operator ${key}`);
    } else if (key === '$regex') {
      if (typeof value !== 'string') {
        problems.push(`${path}: $regex must be a string`);
      } else {
        const flags = expected.$flags;
        try {
          new RegExp(value, typeof flags === 'string' ? flags : undefined);
        } catch (error) {
          problems.push(`${path}: invalid regular expression: ${(error as Error).message}`);
        }
      }
    } else if (key === '$flags' && (typeof value !== 'string' || expected.$regex === undefined)) {
      problems.push(`${path}: $flags must be a string used together with $regex`);
    } else if (key === '$exists' && typeof value !== 'boolean') {
      problems.push(`${path}: $exists must be true or false`);
    } else if (
      key === '$length' &&
      (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    ) {
      problems.push(`${path}: $length must be a non-negative integer`);
    } else if (key === '$type' && !(MATCH_TYPES as readonly JsonValue[]).includes(value)) {
      problems.push(`${path}: $type must be one of ${MATCH_TYPES.join(', ')}`);
    } else if (['$gt', '$gte', '$lt', '$lte'].includes(key) && typeof value !== 'number') {
      problems.push(`${path}: ${key} must be a number`);
    } else if (key === '$contains') {
      problems.push(...validateExpectation(value, `${path}.$contains`));
    }
  }
  if (expected.$exists === false && keys.length > 1) {
    problems.push(`${path}: $exists: false cannot be combined with other operators`);
  }
  return problems;
}

function describe(value: JsonValue | undefined): string {
  if (value === undefined) {
    return 'nothing';
  }
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function typeMatches(value: JsonValue, type: string): boolean {
  if (type === 'integer') {
    return typeof value === 'number' && Number.isInteger(value);
  }
  return jsonTypeOf(value) === type;
}

function matchOperators(
  actual: JsonValue | undefined,
  expected: JsonObject,
  path: string,
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const fail = (reason: string): void => {
    mismatches.push({ path, reason });
  };
  if (expected.$exists !== undefined) {
    if (expected.$exists === true && actual === undefined) {
      fail('expected a value, found nothing');
    } else if (expected.$exists === false && actual !== undefined) {
      fail(`expected nothing, found ${describe(actual)}`);
    }
  }
  if (actual === undefined) {
    if (expected.$exists === undefined) {
      fail('expected a value, found nothing');
    }
    return mismatches;
  }
  for (const [operator, operand] of Object.entries(expected)) {
    switch (operator) {
      case '$equals':
        if (!jsonEqual(actual, operand)) {
          fail(`expected exactly ${describe(operand)}, found ${describe(actual)}`);
        }
        break;
      case '$regex': {
        const flags = typeof expected.$flags === 'string' ? expected.$flags : undefined;
        const pattern = new RegExp(typeof operand === 'string' ? operand : '', flags);
        if (typeof actual !== 'string' || !pattern.test(actual)) {
          fail(`expected a string matching ${String(pattern)}, found ${describe(actual)}`);
        }
        break;
      }
      case '$type':
        if (typeof operand === 'string' && !typeMatches(actual, operand)) {
          fail(`expected type ${operand}, found ${describe(actual)}`);
        }
        break;
      case '$length': {
        const length =
          typeof actual === 'string' || Array.isArray(actual) ? actual.length : undefined;
        if (length !== operand) {
          fail(
            `expected length ${describe(operand)}, found ${length === undefined ? describe(actual) : `length ${length}`}`,
          );
        }
        break;
      }
      case '$contains': {
        const found =
          typeof actual === 'string' && typeof operand === 'string'
            ? actual.includes(operand)
            : Array.isArray(actual) &&
              actual.some((item) => matchValue(item, operand, path).length === 0);
        if (!found) {
          fail(`expected ${describe(actual)} to contain ${describe(operand)}`);
        }
        break;
      }
      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte': {
        const limit = operand as number;
        const ok =
          typeof actual === 'number' &&
          (operator === '$gt'
            ? actual > limit
            : operator === '$gte'
              ? actual >= limit
              : operator === '$lt'
                ? actual < limit
                : actual <= limit);
        if (!ok) {
          fail(`expected a number ${operator.slice(1)} ${limit}, found ${describe(actual)}`);
        }
        break;
      }
      default:
        break; // $exists and $flags are handled above.
    }
  }
  return mismatches;
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

/**
 * Matches `actual` (`undefined` meaning "absent") against an expectation and
 * returns every mismatch; an empty list means the value matches.
 */
export function matchValue(
  actual: JsonValue | undefined,
  expected: JsonValue,
  path = '$',
): Mismatch[] {
  if (isOperatorObject(expected)) {
    return matchOperators(actual, expected, path);
  }
  if (actual === undefined) {
    return [{ path, reason: `expected ${describe(expected)}, found nothing` }];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return [{ path, reason: `expected an array, found ${describe(actual)}` }];
    }
    if (actual.length !== expected.length) {
      return [{ path, reason: `expected ${expected.length} elements, found ${actual.length}` }];
    }
    return expected.flatMap((item, index) => matchValue(actual[index], item, `${path}[${index}]`));
  }
  if (isJsonObject(expected)) {
    if (!isJsonObject(actual)) {
      return [{ path, reason: `expected an object, found ${describe(actual)}` }];
    }
    return Object.entries(expected).flatMap(([key, value]) =>
      matchValue(Object.hasOwn(actual, key) ? actual[key] : undefined, value, childPath(path, key)),
    );
  }
  return jsonEqual(actual, expected)
    ? []
    : [{ path, reason: `expected ${describe(expected)}, found ${describe(actual)}` }];
}
