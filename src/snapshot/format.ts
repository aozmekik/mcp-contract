import * as z from 'zod';
import { InvalidFileError } from '../core/errors.ts';
import {
  canonicalJson,
  canonicalize,
  compareCodeUnits,
  isJsonObject,
  type JsonObject,
} from '../core/json.ts';
import { normalizeSchema } from '../schema/keywords.ts';
import { VERSION } from '../version.ts';
import {
  SNAPSHOT_FORMAT_VERSION,
  type PromptSnapshot,
  type ResourceSnapshot,
  type ResourceTemplateSnapshot,
  type Snapshot,
  type ToolSnapshot,
} from './model.ts';

const objectSchema = z.record(z.string(), z.unknown());

const snapshotFileSchema = z.object({
  formatVersion: z.number(),
  protocol: z.object({ era: z.enum(['legacy', 'modern']), version: z.string() }),
  server: objectSchema,
  capabilities: objectSchema,
  instructions: z.string().optional(),
  tools: z.array(z.looseObject({ name: z.string(), inputSchema: objectSchema })),
  prompts: z.array(z.looseObject({ name: z.string() })),
  resources: z.array(z.looseObject({ uri: z.string() })),
  resourceTemplates: z.array(z.looseObject({ uriTemplate: z.string() })),
});

function asObject(value: unknown): JsonObject {
  const canonical = canonicalize(value);
  if (!isJsonObject(canonical)) {
    throw new TypeError('expected a JSON object');
  }
  return canonical;
}

function sortByKey<T extends JsonObject>(items: readonly T[], key: (item: T) => string): T[] {
  return items
    .map((item) => ({ item, key: key(item), canonical: canonicalJson(item) }))
    .sort((a, b) => compareCodeUnits(a.key, b.key) || compareCodeUnits(a.canonical, b.canonical))
    .map(({ item }) => item);
}

function normalizeTool(tool: ToolSnapshot): ToolSnapshot {
  const result: JsonObject = { ...asObject(tool) };
  for (const field of ['inputSchema', 'outputSchema'] as const) {
    const schema = result[field];
    if (schema !== undefined) {
      result[field] = normalizeSchema(schema);
    }
  }
  return result as ToolSnapshot;
}

/** Raw material for {@link createSnapshot}, typically straight from the SDK. */
export interface SnapshotInput {
  /** Negotiated protocol revision. */
  readonly protocol: Snapshot['protocol'];
  /** Server `Implementation` info. */
  readonly server: unknown;
  /** Server capabilities. */
  readonly capabilities: unknown;
  /** Server instructions, if any. */
  readonly instructions?: string | undefined;
  /** Tools from `tools/list`. */
  readonly tools: readonly unknown[];
  /** Prompts from `prompts/list`. */
  readonly prompts: readonly unknown[];
  /** Resources from `resources/list`. */
  readonly resources: readonly unknown[];
  /** Resource templates from `resources/templates/list`. */
  readonly resourceTemplates: readonly unknown[];
}

/**
 * Builds a canonical snapshot: keys sorted, lists sorted by identity, and
 * set-valued schema keywords (`required`, array `type`) in a stable order.
 *
 * @throws {TypeError} if an element is missing its identity field or is not JSON.
 */
export function createSnapshot(input: SnapshotInput): Snapshot {
  const result = snapshotFileSchema.safeParse({ formatVersion: SNAPSHOT_FORMAT_VERSION, ...input });
  if (!result.success) {
    throw new TypeError(`Invalid snapshot data:\n${z.prettifyError(result.error)}`);
  }
  const parsed = result.data;
  const tools = parsed.tools.map((tool) => normalizeTool(asObject(tool) as ToolSnapshot));
  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    protocol: { era: parsed.protocol.era, version: parsed.protocol.version },
    server: asObject(parsed.server),
    capabilities: asObject(parsed.capabilities),
    ...(parsed.instructions === undefined ? {} : { instructions: parsed.instructions }),
    tools: sortByKey(tools, (tool) => tool.name),
    prompts: sortByKey(
      parsed.prompts.map((prompt) => asObject(prompt) as PromptSnapshot),
      (prompt) => prompt.name,
    ),
    resources: sortByKey(
      parsed.resources.map((resource) => asObject(resource) as ResourceSnapshot),
      (resource) => resource.uri,
    ),
    resourceTemplates: sortByKey(
      parsed.resourceTemplates.map((template) => asObject(template) as ResourceTemplateSnapshot),
      (template) => template.uriTemplate,
    ),
  };
}

/** Returns `snapshot` in canonical form. Idempotent. */
export function normalizeSnapshot(snapshot: Snapshot): Snapshot {
  return createSnapshot(snapshot);
}

/**
 * Serialises a snapshot deterministically: canonical form, two-space
 * indentation, trailing newline. Equal snapshots give identical bytes.
 */
export function serializeSnapshot(snapshot: Snapshot): string {
  return `${JSON.stringify(canonicalize(normalizeSnapshot(snapshot)), null, 2)}\n`;
}

/**
 * Parses and validates snapshot text.
 *
 * @param source Name used in error messages, usually the file path.
 * @throws {InvalidFileError} if the text is not JSON or not a supported snapshot.
 */
export function parseSnapshot(text: string, source = '<snapshot>'): Snapshot {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new InvalidFileError(source, `not valid JSON (${(error as Error).message})`, {
      cause: error,
    });
  }
  if (
    isJsonObject(data) &&
    typeof data.formatVersion === 'number' &&
    data.formatVersion !== SNAPSHOT_FORMAT_VERSION
  ) {
    throw new InvalidFileError(
      source,
      `snapshot format version ${data.formatVersion} is not supported by mcp-contract ${VERSION} (expected ${SNAPSHOT_FORMAT_VERSION})`,
    );
  }
  const result = snapshotFileSchema.safeParse(data);
  if (!result.success) {
    throw new InvalidFileError(
      source,
      `not a valid mcp-contract snapshot:\n${z.prettifyError(result.error)}`,
    );
  }
  return createSnapshot(result.data);
}
