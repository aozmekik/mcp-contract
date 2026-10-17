import type { JsonObject } from '../core/json.ts';
import type { ProtocolInfo } from '../connect/connect.ts';

/** Version of the snapshot file layout. Bumped only for incompatible layout changes. */
export const SNAPSHOT_FORMAT_VERSION = 1;

/** A tool as listed by `tools/list`. Unknown fields are preserved. */
export type ToolSnapshot = JsonObject & {
  /** Tool name, the identity used for matching. */
  readonly name: string;
  /** JSON Schema of the arguments. */
  readonly inputSchema: JsonObject;
};

/** A prompt as listed by `prompts/list`. Unknown fields are preserved. */
export type PromptSnapshot = JsonObject & {
  /** Prompt name, the identity used for matching. */
  readonly name: string;
};

/** A resource as listed by `resources/list`. Unknown fields are preserved. */
export type ResourceSnapshot = JsonObject & {
  /** Resource URI, the identity used for matching. */
  readonly uri: string;
};

/** A resource template as listed by `resources/templates/list`. Unknown fields are preserved. */
export type ResourceTemplateSnapshot = JsonObject & {
  /** RFC 6570 URI template, the identity used for matching. */
  readonly uriTemplate: string;
};

/**
 * Everything a client can observe about a server's contract, in canonical form:
 * object keys sorted, lists sorted by identity, no timestamps. Two snapshots of
 * an unchanged server serialise to identical bytes.
 */
export interface Snapshot {
  /** Snapshot layout version, currently {@link SNAPSHOT_FORMAT_VERSION}. */
  readonly formatVersion: typeof SNAPSHOT_FORMAT_VERSION;
  /** Protocol revision negotiated while taking the snapshot. */
  readonly protocol: ProtocolInfo;
  /** The server's self-reported `Implementation` (name, version, ...). */
  readonly server: JsonObject;
  /** Server capabilities. */
  readonly capabilities: JsonObject;
  /** Server instructions for the model, when provided. */
  readonly instructions?: string;
  /** Tools sorted by name. */
  readonly tools: readonly ToolSnapshot[];
  /** Prompts sorted by name. */
  readonly prompts: readonly PromptSnapshot[];
  /** Resources sorted by URI. */
  readonly resources: readonly ResourceSnapshot[];
  /** Resource templates sorted by URI template. */
  readonly resourceTemplates: readonly ResourceTemplateSnapshot[];
}
