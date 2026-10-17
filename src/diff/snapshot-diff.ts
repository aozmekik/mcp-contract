import {
  compareCodeUnits,
  isJsonObject,
  jsonEqual,
  type JsonObject,
  type JsonValue,
} from '../core/json.ts';
import { normalizeSnapshot } from '../snapshot/format.ts';
import type { Snapshot } from '../snapshot/model.ts';
import {
  summarize,
  type Change,
  type ChangeCode,
  type DiffResult,
  type EntityKind,
  type Severity,
} from './model.ts';
import { diffSchemas, type SchemaChange } from './schema.ts';

/** Options for {@link diffSnapshots}. */
export interface DiffOptions {
  /** Step budget per schema comparison; see {@link DiffSchemasOptions.maxSteps}. */
  readonly maxSchemaSteps?: number;
}

interface Scope {
  readonly entity: EntityKind;
  readonly name: string;
  readonly out: Change[];
  readonly options: DiffOptions;
}

interface ChangeDetails {
  readonly location?: string | undefined;
  readonly path?: string | undefined;
  readonly before?: JsonValue | undefined;
  readonly after?: JsonValue | undefined;
}

function push(
  scope: Scope,
  severity: Severity,
  code: ChangeCode,
  message: string,
  details: ChangeDetails = {},
): void {
  scope.out.push({
    severity,
    code,
    entity: scope.entity,
    name: scope.name,
    ...(details.location === undefined ? {} : { location: details.location }),
    ...(details.path === undefined ? {} : { path: details.path }),
    message,
    ...(details.before === undefined ? {} : { before: details.before }),
    ...(details.after === undefined ? {} : { after: details.after }),
  });
}

function field(object: JsonObject, key: string): JsonValue | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function same(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return a === undefined || b === undefined ? a === b : jsonEqual(a, b);
}

function display(value: JsonValue | undefined): string {
  if (value === undefined) {
    return 'nothing';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function changeVerb(before: JsonValue | undefined, after: JsonValue | undefined): string {
  if (before === undefined) {
    return 'added';
  }
  return after === undefined ? 'removed' : 'changed';
}

/** Reports changes to purely descriptive fields (title, description, icons, ...). */
function compareInfo(
  scope: Scope,
  before: JsonObject,
  after: JsonObject,
  key: string,
  code: ChangeCode,
  location?: string,
): void {
  const old = field(before, key);
  const current = field(after, key);
  if (!same(old, current)) {
    const scalar = (value: JsonValue | undefined): JsonValue | undefined =>
      typeof value === 'object' && value !== null ? undefined : value;
    // Short values such as versions or names are worth showing inline; prose is not.
    const short = (value: JsonValue | undefined): value is string =>
      typeof value === 'string' && value.length <= 40 && !value.includes('\n');
    const values = short(old) && short(current) ? ` from ${old} to ${current}` : '';
    push(scope, 'non-breaking', code, `${key} ${changeVerb(old, current)}${values}`, {
      location,
      before: scalar(old),
      after: scalar(current),
    });
  }
}

/** Reports changes to fields mcp-contract has no rule for. */
function compareRemaining(
  scope: Scope,
  before: JsonObject,
  after: JsonObject,
  known: ReadonlySet<string>,
  location?: string,
): void {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !known.has(key))
    .sort(compareCodeUnits);
  for (const key of keys) {
    const old = field(before, key);
    const current = field(after, key);
    if (same(old, current)) {
      continue;
    }
    const label = location === undefined ? key : `${location}.${key}`;
    if (key === '_meta') {
      push(
        scope,
        'unknown',
        'metadata-changed',
        `${label} ${changeVerb(old, current)}; its meaning is defined by extensions mcp-contract does not know`,
        { location },
      );
    } else {
      push(
        scope,
        'unknown',
        'field-changed',
        `${label} ${changeVerb(old, current)}; mcp-contract has no compatibility rule for this field`,
        { location },
      );
    }
  }
}

function pushSchemaChanges(scope: Scope, location: string, changes: readonly SchemaChange[]): void {
  for (const change of changes) {
    push(scope, change.severity, change.code, change.message, {
      location,
      path: change.path,
      before: change.before,
      after: change.after,
    });
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

interface HintRule {
  /** Value assumed when the hint is absent (MCP specification defaults). */
  readonly fallback: boolean;
  /** The value that describes the riskier behaviour. */
  readonly risky: boolean;
  readonly riskyText: string;
  readonly safeText: string;
}

const HINTS: Readonly<Record<string, HintRule>> = {
  readOnlyHint: {
    fallback: false,
    risky: false,
    riskyText: 'is no longer marked read-only',
    safeText: 'is now marked read-only',
  },
  destructiveHint: {
    fallback: true,
    risky: true,
    riskyText: 'may now perform destructive updates',
    safeText: 'no longer performs destructive updates',
  },
  idempotentHint: {
    fallback: false,
    risky: false,
    riskyText: 'is no longer marked idempotent',
    safeText: 'is now marked idempotent',
  },
  openWorldHint: {
    fallback: true,
    risky: true,
    riskyText: 'may now interact with external entities',
    safeText: 'no longer interacts with external entities',
  },
};

function compareAnnotations(scope: Scope, before: JsonObject, after: JsonObject): void {
  for (const [hint, rule] of Object.entries(HINTS)) {
    const old = field(before, hint);
    const current = field(after, hint);
    const oldValue = typeof old === 'boolean' ? old : rule.fallback;
    const newValue = typeof current === 'boolean' ? current : rule.fallback;
    if (oldValue === newValue) {
      continue;
    }
    const details = { location: 'annotations', before: oldValue, after: newValue };
    if (newValue === rule.risky) {
      push(
        scope,
        'unknown',
        'hint-changed',
        `tool ${rule.riskyText} (${hint}: ${String(oldValue)} -> ${String(newValue)}); clients that decide approval prompts from hints should review it`,
        details,
      );
    } else {
      push(
        scope,
        'non-breaking',
        'hint-changed',
        `tool ${rule.safeText} (${hint}: ${String(oldValue)} -> ${String(newValue)})`,
        details,
      );
    }
  }
  compareInfo(scope, before, after, 'title', 'title-changed', 'annotations');
  compareRemaining(scope, before, after, new Set([...Object.keys(HINTS), 'title']), 'annotations');
}

const TASK_MODES: Readonly<Record<string, readonly string[]>> = {
  forbidden: ['without a task'],
  optional: ['without a task', 'as a task'],
  required: ['as a task'],
};

function compareExecution(scope: Scope, before: JsonObject, after: JsonObject): void {
  const old = field(before, 'taskSupport');
  const current = field(after, 'taskSupport');
  const oldMode = typeof old === 'string' ? old : 'forbidden';
  const newMode = typeof current === 'string' ? current : 'forbidden';
  if (oldMode !== newMode) {
    const oldModes = TASK_MODES[oldMode];
    const newModes = TASK_MODES[newMode];
    const details = { location: 'execution', before: oldMode, after: newMode };
    if (oldModes === undefined || newModes === undefined) {
      push(
        scope,
        'unknown',
        'task-support-changed',
        `taskSupport changed from ${oldMode} to ${newMode}`,
        details,
      );
    } else {
      const lost = oldModes.filter((mode) => !newModes.includes(mode));
      if (lost.length > 0) {
        push(
          scope,
          'breaking',
          'task-support-changed',
          `taskSupport changed from ${oldMode} to ${newMode}; the tool can no longer be called ${lost.join(' or ')}`,
          details,
        );
      } else {
        push(
          scope,
          'non-breaking',
          'task-support-changed',
          `taskSupport changed from ${oldMode} to ${newMode}`,
          details,
        );
      }
    }
  }
  compareRemaining(scope, before, after, new Set(['taskSupport']), 'execution');
}

const TOOL_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'title',
  'description',
  'icons',
  'inputSchema',
  'outputSchema',
  'annotations',
  'execution',
]);

function objectField(object: JsonObject, key: string): JsonObject {
  const value = field(object, key);
  return isJsonObject(value) ? value : {};
}

function compareTool(scope: Scope, before: JsonObject, after: JsonObject): void {
  compareInfo(scope, before, after, 'title', 'title-changed');
  compareInfo(scope, before, after, 'description', 'description-changed');
  compareInfo(scope, before, after, 'icons', 'icons-changed');
  const steps =
    scope.options.maxSchemaSteps === undefined ? {} : { maxSteps: scope.options.maxSchemaSteps };
  pushSchemaChanges(
    scope,
    'inputSchema',
    diffSchemas(field(before, 'inputSchema') ?? {}, field(after, 'inputSchema') ?? {}, {
      direction: 'input',
      ...steps,
    }),
  );

  const oldOutput = field(before, 'outputSchema');
  const newOutput = field(after, 'outputSchema');
  if (oldOutput !== undefined && newOutput !== undefined) {
    pushSchemaChanges(
      scope,
      'outputSchema',
      diffSchemas(oldOutput, newOutput, { direction: 'output', ...steps }),
    );
  } else if (oldOutput !== undefined) {
    push(
      scope,
      'breaking',
      'output-schema-removed',
      'outputSchema removed; clients that rely on structuredContent lose that guarantee',
      { location: 'outputSchema' },
    );
  } else if (newOutput !== undefined) {
    push(
      scope,
      'non-breaking',
      'output-schema-added',
      'outputSchema added; results now carry validated structuredContent',
      { location: 'outputSchema' },
    );
  }

  compareAnnotations(scope, objectField(before, 'annotations'), objectField(after, 'annotations'));
  compareExecution(scope, objectField(before, 'execution'), objectField(after, 'execution'));
  compareRemaining(scope, before, after, TOOL_FIELDS);
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function promptArguments(prompt: JsonObject): Map<string, JsonObject> {
  const list = field(prompt, 'arguments');
  const result = new Map<string, JsonObject>();
  if (Array.isArray(list)) {
    for (const item of list) {
      if (isJsonObject(item) && typeof item.name === 'string' && !result.has(item.name)) {
        result.set(item.name, item);
      }
    }
  }
  return result;
}

const ARGUMENT_FIELDS: ReadonlySet<string> = new Set(['name', 'title', 'description', 'required']);

function comparePrompt(scope: Scope, before: JsonObject, after: JsonObject): void {
  compareInfo(scope, before, after, 'title', 'title-changed');
  compareInfo(scope, before, after, 'description', 'description-changed');
  compareInfo(scope, before, after, 'icons', 'icons-changed');
  const oldArguments = promptArguments(before);
  const newArguments = promptArguments(after);
  const names = [...new Set([...oldArguments.keys(), ...newArguments.keys()])].sort(
    compareCodeUnits,
  );
  for (const name of names) {
    const old = oldArguments.get(name);
    const current = newArguments.get(name);
    const location = `arguments.${name}`;
    if (old === undefined && current !== undefined) {
      if (current.required === true) {
        push(
          scope,
          'breaking',
          'argument-added',
          `new required argument \`${name}\`; requests without it are rejected`,
          { location },
        );
      } else {
        push(scope, 'non-breaking', 'argument-added', `new optional argument \`${name}\``, {
          location,
        });
      }
    } else if (old !== undefined && current === undefined) {
      push(
        scope,
        'unknown',
        'argument-removed',
        `argument \`${name}\` removed; servers may reject it or silently ignore it when clients still send it`,
        { location },
      );
    } else if (old !== undefined && current !== undefined) {
      const wasRequired = old.required === true;
      const isRequired = current.required === true;
      if (!wasRequired && isRequired) {
        push(
          scope,
          'breaking',
          'argument-required',
          `argument \`${name}\` is now required; requests without it are rejected`,
          { location },
        );
      } else if (wasRequired && !isRequired) {
        push(scope, 'non-breaking', 'argument-optional', `argument \`${name}\` is now optional`, {
          location,
        });
      }
      compareInfo(scope, old, current, 'title', 'title-changed', location);
      compareInfo(scope, old, current, 'description', 'description-changed', location);
      compareRemaining(scope, old, current, ARGUMENT_FIELDS, location);
    }
  }
  compareRemaining(
    scope,
    before,
    after,
    new Set(['name', 'title', 'description', 'icons', 'arguments']),
  );
}

// ---------------------------------------------------------------------------
// Resources and resource templates
// ---------------------------------------------------------------------------

const RESOURCE_FIELDS: ReadonlySet<string> = new Set([
  'uri',
  'uriTemplate',
  'name',
  'title',
  'description',
  'icons',
  'mimeType',
  'size',
  'annotations',
]);

function compareResource(scope: Scope, before: JsonObject, after: JsonObject): void {
  compareInfo(scope, before, after, 'name', 'name-changed');
  compareInfo(scope, before, after, 'title', 'title-changed');
  compareInfo(scope, before, after, 'description', 'description-changed');
  compareInfo(scope, before, after, 'icons', 'icons-changed');
  compareInfo(scope, before, after, 'size', 'size-changed');
  compareInfo(scope, before, after, 'annotations', 'annotation-changed');
  const old = field(before, 'mimeType');
  const current = field(after, 'mimeType');
  if (!same(old, current)) {
    const details = { before: old, after: current };
    if (old === undefined) {
      push(
        scope,
        'non-breaking',
        'mime-type-changed',
        `mimeType added (${display(current)})`,
        details,
      );
    } else if (current === undefined) {
      push(
        scope,
        'unknown',
        'mime-type-changed',
        `mimeType removed (was ${display(old)}); clients can no longer tell how to parse the content`,
        details,
      );
    } else {
      push(
        scope,
        'breaking',
        'mime-type-changed',
        `mimeType changed from ${display(old)} to ${display(current)}; clients that parse the content by type may fail`,
        details,
      );
    }
  }
  compareRemaining(scope, before, after, RESOURCE_FIELDS);
}

// ---------------------------------------------------------------------------
// Server identity, protocol and capabilities
// ---------------------------------------------------------------------------

function compareCapabilities(
  scope: Scope,
  before: JsonObject,
  after: JsonObject,
  prefix: string,
): void {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(compareCodeUnits);
  for (const key of keys) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const old = field(before, key);
    const current = field(after, key);
    const details = { location: 'capabilities', path };
    if (old === undefined) {
      if (current !== false) {
        push(scope, 'non-breaking', 'capability-added', `capability \`${path}\` added`, details);
      }
    } else if (current === undefined) {
      if (old !== false) {
        push(
          scope,
          'breaking',
          'capability-removed',
          `capability \`${path}\` removed; clients that use it will fail or stop receiving updates`,
          details,
        );
      }
    } else if (isJsonObject(old) && isJsonObject(current)) {
      compareCapabilities(scope, old, current, path);
    } else if (!jsonEqual(old, current)) {
      if (old === true && current === false) {
        push(
          scope,
          'breaking',
          'capability-removed',
          `capability \`${path}\` turned off; clients that use it will fail or stop receiving updates`,
          { ...details, before: old, after: current },
        );
      } else if (old === false && current === true) {
        push(scope, 'non-breaking', 'capability-added', `capability \`${path}\` turned on`, {
          ...details,
          before: old,
          after: current,
        });
      } else {
        push(scope, 'unknown', 'capability-changed', `capability \`${path}\` changed`, details);
      }
    }
  }
}

function compareServer(scope: Scope, before: Snapshot, after: Snapshot): void {
  const keys = [...new Set([...Object.keys(before.server), ...Object.keys(after.server)])].sort(
    compareCodeUnits,
  );
  for (const key of keys) {
    compareInfo(scope, before.server, after.server, key, 'server-info-changed', 'server');
  }
  if (
    before.protocol.version !== after.protocol.version ||
    before.protocol.era !== after.protocol.era
  ) {
    const describe = (snapshot: Snapshot): string =>
      `${snapshot.protocol.version} (${snapshot.protocol.era})`;
    push(
      scope,
      'unknown',
      'protocol-changed',
      `negotiated protocol changed from ${describe(before)} to ${describe(after)}; clients limited to the old revision may not be able to connect`,
      {
        location: 'protocol',
        before: before.protocol.version,
        after: after.protocol.version,
      },
    );
  }
  compareCapabilities(scope, before.capabilities, after.capabilities, '');
  if (before.instructions !== after.instructions) {
    push(
      scope,
      'non-breaking',
      'instructions-changed',
      `instructions ${changeVerb(before.instructions, after.instructions)}`,
      { location: 'instructions' },
    );
  }
}

// ---------------------------------------------------------------------------
// Entity matching
// ---------------------------------------------------------------------------

interface EntityRule<T extends JsonObject> {
  readonly entity: Exclude<EntityKind, 'server'>;
  readonly label: string;
  readonly key: (item: T) => string;
  readonly removedConsequence: string;
  readonly compare: (scope: Scope, before: T, after: T) => void;
}

function indexEntities<T extends JsonObject>(
  items: readonly T[],
  rule: EntityRule<T>,
  side: string,
  out: Change[],
): Map<string, T> {
  const result = new Map<string, T>();
  const reported = new Set<string>();
  for (const item of items) {
    const key = rule.key(item);
    if (!result.has(key)) {
      result.set(key, item);
    } else if (!reported.has(key)) {
      reported.add(key);
      out.push({
        severity: 'unknown',
        code: 'duplicate-name',
        entity: rule.entity,
        name: key,
        message: `the ${side} snapshot lists ${rule.label} "${key}" more than once; only the first definition is compared`,
      });
    }
  }
  return result;
}

function diffEntities<T extends JsonObject>(
  before: readonly T[],
  after: readonly T[],
  rule: EntityRule<T>,
  out: Change[],
  options: DiffOptions,
): void {
  const oldItems = indexEntities(before, rule, 'old', out);
  const newItems = indexEntities(after, rule, 'new', out);
  const keys = [...new Set([...oldItems.keys(), ...newItems.keys()])].sort(compareCodeUnits);
  for (const key of keys) {
    const scope: Scope = { entity: rule.entity, name: key, out, options };
    const old = oldItems.get(key);
    const current = newItems.get(key);
    if (old !== undefined && current !== undefined) {
      rule.compare(scope, old, current);
    } else if (old !== undefined) {
      push(
        scope,
        'breaking',
        `${rule.entity}-removed`,
        `${rule.label} removed; ${rule.removedConsequence}`,
      );
    } else {
      push(scope, 'non-breaking', `${rule.entity}-added`, `${rule.label} added`);
    }
  }
}

/**
 * Compares two snapshots and classifies every difference from the point of
 * view of existing clients. The result is deterministic: changes are ordered
 * by server, tools, prompts, resources and resource templates, then by name.
 *
 * @example
 * ```ts
 * const result = diffSnapshots(await readSnapshot('old.json'), await readSnapshot('new.json'));
 * if (result.summary.breaking > 0) process.exitCode = 1;
 * ```
 */
export function diffSnapshots(
  before: Snapshot,
  after: Snapshot,
  options: DiffOptions = {},
): DiffResult {
  const oldSnapshot = normalizeSnapshot(before);
  const newSnapshot = normalizeSnapshot(after);
  const changes: Change[] = [];
  const serverName =
    typeof newSnapshot.server.name === 'string' ? newSnapshot.server.name : 'server';
  compareServer(
    { entity: 'server', name: serverName, out: changes, options },
    oldSnapshot,
    newSnapshot,
  );
  diffEntities(
    oldSnapshot.tools,
    newSnapshot.tools,
    {
      entity: 'tool',
      label: 'tool',
      key: (tool) => tool.name,
      removedConsequence: 'agents that call it will get an error',
      compare: compareTool,
    },
    changes,
    options,
  );
  diffEntities(
    oldSnapshot.prompts,
    newSnapshot.prompts,
    {
      entity: 'prompt',
      label: 'prompt',
      key: (prompt) => prompt.name,
      removedConsequence: 'clients that request it will get an error',
      compare: comparePrompt,
    },
    changes,
    options,
  );
  diffEntities(
    oldSnapshot.resources,
    newSnapshot.resources,
    {
      entity: 'resource',
      label: 'resource',
      key: (resource) => resource.uri,
      removedConsequence: 'clients that read it will get an error',
      compare: compareResource,
    },
    changes,
    options,
  );
  diffEntities(
    oldSnapshot.resourceTemplates,
    newSnapshot.resourceTemplates,
    {
      entity: 'resource-template',
      label: 'resource template',
      key: (template) => template.uriTemplate,
      removedConsequence: 'clients that build URIs from it will get errors',
      compare: compareResource,
    },
    changes,
    options,
  );
  return { changes, summary: summarize(changes) };
}
