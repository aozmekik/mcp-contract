/**
 * mcp-contract: contract testing for Model Context Protocol servers.
 *
 * Take a snapshot of what a server exposes, compare snapshots with
 * client-centred compatibility rules, and run fixture tool calls.
 *
 * @packageDocumentation
 */

export {
  connectServer,
  describeTarget,
  withServer,
  DEFAULT_TIMEOUT_MS,
  type ConnectOptions,
  type HttpTarget,
  type NegotiationKind,
  type ProtocolInfo,
  type ProtocolMode,
  type ServerConnection,
  type ServerTarget,
  type StdioTarget,
  type TransportTarget,
} from './connect/connect.ts';
export { splitCommandLine } from './connect/command-line.ts';
export {
  ExitCode,
  InvalidFileError,
  McpContractError,
  ServerError,
  UsageError,
} from './core/errors.ts';
export type { JsonObject, JsonPrimitive, JsonValue } from './core/json.ts';
export {
  DEFAULT_FAIL_ON,
  SEVERITIES,
  failingChanges,
  severityFails,
  type Change,
  type ChangeCode,
  type DiffResult,
  type DiffSummary,
  type EntityKind,
  type FailOn,
  type SchemaDirection,
  type Severity,
} from './diff/model.ts';
export {
  DEFAULT_MAX_STEPS,
  diffSchemas,
  type DiffSchemasOptions,
  type SchemaChange,
} from './diff/schema.ts';
export { diffSnapshots, type DiffOptions } from './diff/snapshot-diff.ts';
export {
  formatDiffJson,
  formatDiffMarkdown,
  formatDiffText,
  type DiffReportOptions,
} from './report/diff-report.ts';
export {
  loadScenarios,
  parseScenarios,
  type Scenario,
  type ScenarioExpectation,
  type ScenarioFile,
  type SelectExpectation,
} from './scenarios/file.ts';
export { matchValue, type Mismatch } from './scenarios/match.ts';
export { runScenarios, type RunScenariosOptions, type ScenarioResult } from './scenarios/run.ts';
export {
  parseSelector,
  select,
  type SelectedValue,
  type SelectorSegment,
} from './scenarios/selector.ts';
export {
  captureSnapshot,
  snapshotServer,
  type CaptureOptions,
  type SnapshotServerOptions,
} from './snapshot/capture.ts';
export { DEFAULT_SNAPSHOT_FILE, readSnapshot, writeSnapshot } from './snapshot/files.ts';
export {
  createSnapshot,
  normalizeSnapshot,
  parseSnapshot,
  serializeSnapshot,
  type SnapshotInput,
} from './snapshot/format.ts';
export {
  SNAPSHOT_FORMAT_VERSION,
  type PromptSnapshot,
  type ResourceSnapshot,
  type ResourceTemplateSnapshot,
  type Snapshot,
  type ToolSnapshot,
} from './snapshot/model.ts';
export { ContractViolationError, expectNoBreakingChanges, type ExpectOptions } from './testing.ts';
export { VERSION } from './version.ts';
