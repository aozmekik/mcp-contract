import { ProtocolError, SdkError } from '@modelcontextprotocol/client';
import { canonicalize, isJsonObject, type JsonObject, type JsonValue } from '../core/json.ts';
import { InterruptedError, describeError } from '../core/errors.ts';
import type { ServerConnection } from '../connect/connect.ts';
import type { Scenario } from './file.ts';
import { isOperatorObject, matchValue } from './match.ts';
import { select } from './selector.ts';

/** Outcome of one scenario. */
export interface ScenarioResult {
  /** Scenario name. */
  readonly name: string;
  /** Tool that was called. */
  readonly tool: string;
  /** True when every expectation held. */
  readonly passed: boolean;
  /** Human-readable reasons for failure; empty when passed. */
  readonly failures: readonly string[];
  /** Wall-clock duration of the call in milliseconds. */
  readonly durationMs: number;
}

/** Options for {@link runScenarios}. */
export interface RunScenariosOptions {
  /** Clock used for durations; injectable for deterministic tests. Defaults to `performance.now`. */
  readonly now?: () => number;
}

type Outcome =
  | { readonly kind: 'result'; readonly result: JsonObject }
  | { readonly kind: 'error'; readonly error: JsonObject };

function errorOutcome(error: unknown): JsonObject {
  if (error instanceof ProtocolError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: canonicalize(error.data) }),
    };
  }
  if (error instanceof SdkError) {
    return { code: error.code, message: error.message };
  }
  return { message: describeError(error) };
}

function firstText(result: JsonObject): string | undefined {
  const content = result.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    if (isJsonObject(block) && block.type === 'text' && typeof block.text === 'string') {
      return block.text.length > 200 ? `${block.text.slice(0, 197)}...` : block.text;
    }
  }
  return undefined;
}

function evaluate(scenario: Scenario, outcome: Outcome): string[] {
  const { expect } = scenario;
  const failures: string[] = [];
  const mismatch = (prefix: string) => (m: { path: string; reason: string }) =>
    `${prefix} ${m.path}: ${m.reason}`;

  if (expect.error !== undefined) {
    if (outcome.kind === 'result') {
      return ['expected the call to fail with a protocol error, but it returned a result'];
    }
    return matchValue(outcome.error, expect.error, 'error').map(mismatch('error mismatch at'));
  }
  if (outcome.kind === 'error') {
    const message = outcome.error.message;
    return [`tool call failed: ${typeof message === 'string' ? message : JSON.stringify(message)}`];
  }

  const { result } = outcome;
  const isError = result.isError === true;
  if (isError !== expect.isError) {
    const text = firstText(result);
    failures.push(
      expect.isError
        ? 'expected isError: true, but the tool succeeded'
        : `expected the tool to succeed, but it returned isError: true${text === undefined ? '' : ` (${text})`}`,
    );
  }
  if (expect.result !== undefined) {
    failures.push(...matchValue(result, expect.result, '$').map(mismatch('result mismatch at')));
  }
  for (const { selector, segments, expected } of expect.select) {
    const nodes = select(result, segments);
    const existence = isOperatorObject(expected) ? expected.$exists : undefined;
    if (existence === false) {
      if (nodes.length > 0) {
        failures.push(`${selector}: expected no value, found ${nodes.length}`);
      }
      continue;
    }
    if (nodes.length === 0) {
      failures.push(`${selector}: selected nothing`);
      continue;
    }
    for (const node of nodes) {
      failures.push(
        ...matchValue(node.value, expected, node.path).map((m) =>
          m.path === selector
            ? `${selector}: ${m.reason}`
            : `${selector}: at ${m.path}: ${m.reason}`,
        ),
      );
    }
  }
  return failures;
}

/**
 * Runs scenarios one after another (tool calls may have side effects, so
 * they are never parallelised) and reports each outcome. A failing scenario
 * does not stop the run.
 *
 * Before the first call the tool list is fetched once, so the SDK validates
 * `structuredContent` against each tool's `outputSchema`.
 *
 * @throws {InterruptedError} when the connection's signal aborts; the
 *   remaining scenarios are not run, and none is reported as failed.
 */
export async function runScenarios(
  connection: ServerConnection,
  scenarios: readonly Scenario[],
  options: RunScenariosOptions = {},
): Promise<ScenarioResult[]> {
  const now = options.now ?? (() => performance.now());
  const signalOptions = connection.signal === undefined ? {} : { signal: connection.signal };
  try {
    await connection.client.listTools(undefined, {
      timeout: connection.timeoutMs,
      ...signalOptions,
    });
  } catch {
    // Without a tool list the SDK simply skips output validation; the calls themselves still run.
  }
  const { signal } = connection;
  const stopIfAborted = (cause?: unknown): void => {
    if (signal?.aborted === true) {
      throw new InterruptedError({ cause: cause ?? signal.reason });
    }
  };
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    stopIfAborted();
    const started = now();
    let outcome: Outcome;
    try {
      const result: unknown = await connection.client.callTool(
        { name: scenario.tool, arguments: scenario.arguments },
        { timeout: scenario.timeoutMs ?? connection.timeoutMs, ...signalOptions },
      );
      const json: JsonValue = canonicalize(result);
      outcome = { kind: 'result', result: isJsonObject(json) ? json : {} };
    } catch (error) {
      stopIfAborted(error); // an aborted call is not a failed scenario
      outcome = { kind: 'error', error: errorOutcome(error) };
    }
    const failures = evaluate(scenario, outcome);
    results.push({
      name: scenario.name,
      tool: scenario.tool,
      passed: failures.length === 0,
      failures,
      durationMs: Math.max(0, now() - started),
    });
  }
  return results;
}
