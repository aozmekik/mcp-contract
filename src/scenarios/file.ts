import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import * as z from 'zod';
import { InvalidFileError } from '../core/errors.ts';
import { canonicalize, isJsonObject, type JsonObject, type JsonValue } from '../core/json.ts';
import type { ServerTarget } from '../connect/connect.ts';
import { validateExpectation } from './match.ts';
import { parseSelector, type SelectorSegment } from './selector.ts';

/** What a scenario expects from its tool call. */
export interface ScenarioExpectation {
  /** Expected value of `isError` on the result. Defaults to `false` unless `error` is set. */
  readonly isError: boolean;
  /** Expectation matched against the whole `CallToolResult`. */
  readonly result?: JsonValue;
  /** Expectations for values picked by selectors, e.g. `$.structuredContent.total`. */
  readonly select: readonly SelectExpectation[];
  /** When set, the call must fail with a JSON-RPC error matching this expectation (`code`, `message`, `data`). */
  readonly error?: JsonValue;
}

/** One selector with its expectation. */
export interface SelectExpectation {
  /** The selector as written. */
  readonly selector: string;
  /** Parsed selector. */
  readonly segments: readonly SelectorSegment[];
  /** Expectation every selected value must meet. */
  readonly expected: JsonValue;
}

/** One fixture tool call and its assertions. */
export interface Scenario {
  /** Unique, human-readable name. */
  readonly name: string;
  /** Tool to call. */
  readonly tool: string;
  /** Arguments to send. */
  readonly arguments: JsonObject;
  /** Per-call timeout in milliseconds, overriding the connection default. */
  readonly timeoutMs?: number;
  /** Assertions on the outcome. */
  readonly expect: ScenarioExpectation;
}

/** A parsed scenario file. */
export interface ScenarioFile {
  /** Server declared in the file, with relative paths resolved against the file's directory. */
  readonly server?: ServerTarget;
  /** Scenarios in file order. */
  readonly scenarios: readonly Scenario[];
}

const expectSchema = z.strictObject({
  isError: z.boolean().optional(),
  result: z.unknown().optional(),
  select: z.record(z.string(), z.unknown()).optional(),
  error: z.unknown().optional(),
});

const scenarioSchema = z.strictObject({
  name: z.string().min(1),
  tool: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  expect: expectSchema.optional(),
});

const serverSchema = z.union([
  z.strictObject({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.strictObject({
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

const fileSchema = z.strictObject({
  server: serverSchema.optional(),
  scenarios: z.array(scenarioSchema).min(1),
});

type RawServer = z.infer<typeof serverSchema>;

function toTarget(server: RawServer, baseDirectory: string): ServerTarget {
  if ('url' in server) {
    return {
      type: 'http',
      url: server.url,
      ...(server.headers === undefined ? {} : { headers: server.headers }),
    };
  }
  return {
    type: 'stdio',
    command: server.command,
    args: server.args ?? [],
    cwd: resolve(baseDirectory, server.cwd ?? '.'),
    ...(server.env === undefined ? {} : { env: server.env }),
  };
}

/**
 * Parses scenario YAML (or JSON, which is valid YAML).
 *
 * @param source File path, used in error messages and to resolve a relative `server.cwd`.
 * @throws {InvalidFileError} for YAML syntax errors, schema violations, duplicate
 *   names, invalid selectors or malformed expectations.
 */
export function parseScenarios(text: string, source = '<scenarios>'): ScenarioFile {
  let data: unknown;
  try {
    data = parseYaml(text, { prettyErrors: true });
  } catch (error) {
    const reason = error instanceof YAMLParseError ? error.message : String(error);
    throw new InvalidFileError(source, `not valid YAML: ${reason}`, { cause: error });
  }
  const parsed = fileSchema.safeParse(data);
  if (!parsed.success) {
    throw new InvalidFileError(
      source,
      `not a valid scenario file:\n${z.prettifyError(parsed.error)}`,
    );
  }

  const problems: string[] = [];
  const names = new Set<string>();
  const scenarios: Scenario[] = [];
  for (const raw of parsed.data.scenarios) {
    const toJson = (value: unknown): JsonValue => {
      try {
        return canonicalize(value);
      } catch (error) {
        problems.push(`scenario "${raw.name}": ${(error as Error).message}`);
        return null;
      }
    };
    if (names.has(raw.name)) {
      problems.push(`duplicate scenario name "${raw.name}"`);
    }
    names.add(raw.name);
    const expectation = raw.expect ?? {};
    if (
      expectation.error !== undefined &&
      (expectation.isError !== undefined ||
        expectation.result !== undefined ||
        expectation.select !== undefined)
    ) {
      problems.push(
        `scenario "${raw.name}": expect.error cannot be combined with isError, result or select`,
      );
    }
    const select: SelectExpectation[] = [];
    for (const [selector, expected] of Object.entries(expectation.select ?? {})) {
      const json = toJson(expected);
      try {
        select.push({ selector, segments: parseSelector(selector), expected: json });
      } catch (error) {
        problems.push(`scenario "${raw.name}": ${(error as Error).message}`);
      }
      problems.push(
        ...validateExpectation(json, selector).map(
          (problem) => `scenario "${raw.name}": ${problem}`,
        ),
      );
    }
    const result = expectation.result === undefined ? undefined : toJson(expectation.result);
    const error = expectation.error === undefined ? undefined : toJson(expectation.error);
    for (const [label, value] of [
      ['result', result],
      ['error', error],
    ] as const) {
      if (value !== undefined) {
        problems.push(
          ...validateExpectation(value, label).map(
            (problem) => `scenario "${raw.name}": ${problem}`,
          ),
        );
      }
    }
    const args = toJson(raw.arguments ?? {});
    scenarios.push({
      name: raw.name,
      tool: raw.tool,
      arguments: isJsonObject(args) ? args : {},
      ...(raw.timeoutMs === undefined ? {} : { timeoutMs: raw.timeoutMs }),
      expect: {
        isError: expectation.isError ?? false,
        select,
        ...(result === undefined ? {} : { result }),
        ...(error === undefined ? {} : { error }),
      },
    });
  }
  if (problems.length > 0) {
    throw new InvalidFileError(source, problems.join('\n'));
  }
  const server = parsed.data.server;
  return {
    scenarios,
    ...(server === undefined ? {} : { server: toTarget(server, dirname(resolve(source))) }),
  };
}

/**
 * Reads and parses a scenario file.
 *
 * @throws {InvalidFileError} if the file cannot be read or is invalid.
 */
export async function loadScenarios(path: string): Promise<ScenarioFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new InvalidFileError(
      path,
      code === 'ENOENT' ? 'file not found' : `cannot read file (${String(code)})`,
      {
        cause: error,
      },
    );
  }
  return parseScenarios(text, path);
}
