import type { JsonObject } from '../../src/core/json.ts';
import { createSnapshot } from '../../src/snapshot/format.ts';
import type { Snapshot } from '../../src/snapshot/model.ts';

/** Fields of a snapshot that tests usually vary. */
export interface SnapshotParts {
  readonly server?: JsonObject;
  readonly capabilities?: JsonObject;
  readonly instructions?: string;
  readonly protocol?: Snapshot['protocol'];
  readonly tools?: readonly JsonObject[];
  readonly prompts?: readonly JsonObject[];
  readonly resources?: readonly JsonObject[];
  readonly resourceTemplates?: readonly JsonObject[];
}

/** Builds a canonical snapshot with sensible defaults. */
export function snapshotOf(parts: SnapshotParts = {}): Snapshot {
  return createSnapshot({
    protocol: parts.protocol ?? { era: 'modern', version: '2026-07-28' },
    server: parts.server ?? { name: 'test', version: '1.0.0' },
    capabilities: parts.capabilities ?? { tools: {}, prompts: {}, resources: {} },
    instructions: parts.instructions,
    tools: parts.tools ?? [],
    prompts: parts.prompts ?? [],
    resources: parts.resources ?? [],
    resourceTemplates: parts.resourceTemplates ?? [],
  });
}

/** A tool with an object input schema. */
export function tool(name: string, extra: JsonObject = {}): JsonObject {
  return { name, inputSchema: { type: 'object' }, ...extra };
}
