import {
  DEFAULT_FAIL_ON,
  failingChanges,
  type Change,
  type DiffResult,
  type FailOn,
} from './diff/model.ts';
import { diffSnapshots, type DiffOptions } from './diff/snapshot-diff.ts';
import { formatDiffText } from './report/diff-report.ts';
import type { Snapshot } from './snapshot/model.ts';

/** Thrown by {@link expectNoBreakingChanges}; its message is the full text report. */
export class ContractViolationError extends Error {
  /** The complete diff. */
  readonly result: DiffResult;
  /** The changes that caused the failure. */
  readonly failing: readonly Change[];
  /** The threshold that was applied. */
  readonly failOn: FailOn;

  /** Creates the error from a diff and the threshold that it violated. */
  constructor(result: DiffResult, failOn: FailOn) {
    super(`MCP contract violated:\n${formatDiffText(result, { failOn })}`);
    this.name = 'ContractViolationError';
    this.result = result;
    this.failing = failingChanges(result, failOn);
    this.failOn = failOn;
  }
}

/** Options for {@link expectNoBreakingChanges}. */
export interface ExpectOptions extends DiffOptions {
  /**
   * Which changes fail the assertion. Defaults to `unknown`: breaking changes
   * and changes whose compatibility cannot be proven. Use `breaking` to
   * tolerate unknown changes, or `any` to require an identical contract.
   */
  readonly failOn?: FailOn;
}

/**
 * Test-framework-agnostic assertion (works in Vitest, Jest, node:test, ...):
 * throws a {@link ContractViolationError} when `current` would break clients
 * written against `baseline`, and returns the diff otherwise.
 *
 * @example
 * ```ts
 * test('MCP contract is backwards compatible', async () => {
 *   const baseline = await readSnapshot('mcp-contract.snapshot.json');
 *   const current = await snapshotServer({ type: 'stdio', command: 'node', args: ['dist/server.js'] });
 *   expectNoBreakingChanges(baseline, current);
 * });
 * ```
 */
export function expectNoBreakingChanges(
  baseline: Snapshot,
  current: Snapshot,
  options: ExpectOptions = {},
): DiffResult {
  const failOn = options.failOn ?? DEFAULT_FAIL_ON;
  const result = diffSnapshots(baseline, current, options);
  if (failingChanges(result, failOn).length > 0) {
    throw new ContractViolationError(result, failOn);
  }
  return result;
}
