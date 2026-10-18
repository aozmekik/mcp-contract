import type { JsonValue } from '../core/json.ts';

/**
 * How a change affects existing clients.
 *
 * - `breaking`: a client that worked against the old contract can fail against the new one.
 * - `non-breaking`: existing clients keep working (additions, widened inputs, docs).
 * - `unknown`: mcp-contract cannot prove either; a human should review it.
 */
export type Severity = 'breaking' | 'non-breaking' | 'unknown';

/** All severities, most severe first. */
export const SEVERITIES: readonly Severity[] = ['breaking', 'unknown', 'non-breaking'];

/** The kind of contract element a change belongs to. */
export type EntityKind = 'server' | 'tool' | 'prompt' | 'resource' | 'resource-template';

/** Which side of a schema produces the data, and therefore which direction is safe to evolve. */
export type SchemaDirection = 'input' | 'output';

/** Stable machine-readable identifiers for every kind of change mcp-contract reports. */
export type ChangeCode =
  // Entities
  | 'tool-added'
  | 'tool-removed'
  | 'prompt-added'
  | 'prompt-removed'
  | 'resource-added'
  | 'resource-removed'
  | 'resource-template-added'
  | 'resource-template-removed'
  | 'duplicate-name'
  // Entity fields
  | 'title-changed'
  | 'description-changed'
  | 'icons-changed'
  | 'metadata-changed'
  | 'field-changed'
  | 'output-schema-added'
  | 'output-schema-removed'
  | 'hint-changed'
  | 'task-support-changed'
  | 'argument-added'
  | 'argument-removed'
  | 'argument-required'
  | 'argument-optional'
  | 'mime-type-changed'
  | 'name-changed'
  | 'size-changed'
  // Server
  | 'server-info-changed'
  | 'protocol-changed'
  | 'instructions-changed'
  | 'capability-added'
  | 'capability-removed'
  | 'capability-changed'
  // JSON Schema
  | 'type-narrowed'
  | 'type-widened'
  | 'enum-narrowed'
  | 'enum-widened'
  | 'constraint-tightened'
  | 'constraint-loosened'
  | 'constraint-changed'
  | 'property-added'
  | 'required-property-added'
  | 'property-removed'
  | 'property-required'
  | 'property-optional'
  | 'additional-properties-restricted'
  | 'additional-properties-allowed'
  | 'schema-narrowed'
  | 'schema-widened'
  | 'alternatives-added'
  | 'alternatives-removed'
  | 'alternatives-changed'
  | 'subschema-added'
  | 'subschema-removed'
  | 'composition-changed'
  | 'default-changed'
  | 'deprecated-changed'
  | 'annotation-changed'
  | 'keyword-changed'
  | 'dialect-changed'
  | 'ref-unresolved'
  | 'invalid-schema'
  | 'schema-too-complex';

/** One classified difference between two snapshots. */
export interface Change {
  /** Impact on existing clients. */
  readonly severity: Severity;
  /** Stable identifier of the rule that produced this change. */
  readonly code: ChangeCode;
  /** Kind of element that changed. */
  readonly entity: EntityKind;
  /** Tool or prompt name, resource URI, resource template, or server name. */
  readonly name: string;
  /** Field of the element, e.g. `inputSchema`, `outputSchema`, `arguments`, `capabilities`. */
  readonly location?: string;
  /** Instance path inside a schema, e.g. `$.filters[*].tag`. */
  readonly path?: string;
  /** Human explanation: what changed and why it matters to clients. */
  readonly message: string;
  /** Previous value, when a single value changed. */
  readonly before?: JsonValue;
  /** New value, when a single value changed. */
  readonly after?: JsonValue;
}

/** Number of changes per severity. */
export interface DiffSummary {
  /** Number of breaking changes. */
  readonly breaking: number;
  /** Number of changes that could not be classified. */
  readonly unknown: number;
  /** Number of compatible changes. */
  readonly nonBreaking: number;
}

/** The result of comparing two snapshots. */
export interface DiffResult {
  /** All changes in a deterministic order. */
  readonly changes: readonly Change[];
  /** Counts per severity. */
  readonly summary: DiffSummary;
}

/**
 * Which changes fail a check:
 * `breaking` fails on breaking changes only, `unknown` (the default) also on
 * unclassifiable ones, and `any` on every change (useful to detect drift).
 */
export type FailOn = 'breaking' | 'unknown' | 'any';

/** The default {@link FailOn} policy: fail when compatibility is not proven. */
export const DEFAULT_FAIL_ON: FailOn = 'unknown';

/** Returns true when a change of `severity` fails a check under `failOn`. */
export function severityFails(severity: Severity, failOn: FailOn): boolean {
  switch (failOn) {
    case 'any':
      return true;
    case 'unknown':
      return severity !== 'non-breaking';
    case 'breaking':
      return severity === 'breaking';
  }
}

/**
 * Returns the changes that fail a check under `failOn`. A `schema-too-complex`
 * change fails at every level: the analysis it stands for is incomplete, and
 * the part that was not analysed may contain breaking changes.
 */
export function failingChanges(result: DiffResult, failOn: FailOn = DEFAULT_FAIL_ON): Change[] {
  return result.changes.filter(
    (change) => change.code === 'schema-too-complex' || severityFails(change.severity, failOn),
  );
}

/** Counts changes per severity. */
export function summarize(changes: readonly Change[]): DiffSummary {
  let breaking = 0;
  let unknown = 0;
  let nonBreaking = 0;
  for (const change of changes) {
    if (change.severity === 'breaking') {
      breaking += 1;
    } else if (change.severity === 'unknown') {
      unknown += 1;
    } else {
      nonBreaking += 1;
    }
  }
  return { breaking, unknown, nonBreaking };
}
