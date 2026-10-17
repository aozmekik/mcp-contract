import { ProtocolError } from '@modelcontextprotocol/client';
import { ServerError, describeError } from '../core/errors.ts';
import {
  withServer,
  type ConnectOptions,
  type ServerConnection,
  type ServerTarget,
} from '../connect/connect.ts';
import { createSnapshot } from './format.ts';
import type { Snapshot } from './model.ts';

/** Options for {@link captureSnapshot}. */
export interface CaptureOptions {
  /**
   * Maximum number of pages fetched per list method before giving up.
   * Protects against servers whose cursors never terminate. Defaults to 1000.
   */
  readonly maxPages?: number;
}

/** Options for {@link snapshotServer}: connection options plus capture options. */
export interface SnapshotServerOptions extends ConnectOptions, CaptureOptions {}

const DEFAULT_MAX_PAGES = 1000;

/** JSON-RPC "method not found". */
const METHOD_NOT_FOUND = -32601;

type ListMethod = 'tools/list' | 'prompts/list' | 'resources/list' | 'resources/templates/list';

const LIST_FIELDS = {
  'tools/list': 'tools',
  'prompts/list': 'prompts',
  'resources/list': 'resources',
  'resources/templates/list': 'resourceTemplates',
} as const satisfies Record<ListMethod, string>;

interface Page {
  readonly items: readonly unknown[];
  readonly nextCursor: string | undefined;
}

async function fetchPage(
  connection: ServerConnection,
  method: ListMethod,
  cursor: string | undefined,
): Promise<Page> {
  const result: Record<string, unknown> = await connection.client.request(
    { method, params: cursor === undefined ? {} : { cursor } },
    {
      timeout: connection.timeoutMs,
      ...(connection.signal === undefined ? {} : { signal: connection.signal }),
    },
  );
  const items = result[LIST_FIELDS[method]];
  const nextCursor = result.nextCursor;
  return {
    items: Array.isArray(items) ? (items as unknown[]) : [],
    nextCursor: typeof nextCursor === 'string' ? nextCursor : undefined,
  };
}

/**
 * Fetches every page of a list method, following `nextCursor` until the server
 * stops returning one. A cursor seen twice, or more than `maxPages` pages, is
 * reported as a server error instead of looping forever.
 */
async function listAll(
  connection: ServerConnection,
  method: ListMethod,
  maxPages: number,
): Promise<unknown[]> {
  const items: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 1; ; page += 1) {
    let result: Page;
    try {
      result = await fetchPage(connection, method, cursor);
    } catch (error) {
      if (
        method === 'resources/templates/list' &&
        error instanceof ProtocolError &&
        error.code === METHOD_NOT_FOUND
      ) {
        return []; // Servers with static resources only often omit this method.
      }
      throw new ServerError(`${method} failed: ${describeError(error)}`, {
        cause: error,
        serverStderr: connection.serverStderr(),
      });
    }
    items.push(...result.items);
    const next = result.nextCursor;
    if (next === undefined) {
      return items;
    }
    if (seen.has(next)) {
      throw new ServerError(
        `${method} returned the cursor ${JSON.stringify(next)} twice; stopping to avoid an infinite loop`,
      );
    }
    if (page >= maxPages) {
      throw new ServerError(`${method} still returned a next cursor after ${maxPages} pages`);
    }
    seen.add(next);
    cursor = next;
  }
}

/**
 * Lists everything the connected server advertises (tools, prompts, resources
 * and resource templates, each only when the matching capability is declared)
 * and returns it as a canonical {@link Snapshot}.
 *
 * @throws {ServerError} if a list request fails or the server returns malformed data.
 */
export async function captureSnapshot(
  connection: ServerConnection,
  options: CaptureOptions = {},
): Promise<Snapshot> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const { client } = connection;
  const capabilities = client.getServerCapabilities() ?? {};
  const none = Promise.resolve([]);
  const [tools, prompts, resources, resourceTemplates] = await Promise.all([
    capabilities.tools === undefined ? none : listAll(connection, 'tools/list', maxPages),
    capabilities.prompts === undefined ? none : listAll(connection, 'prompts/list', maxPages),
    capabilities.resources === undefined ? none : listAll(connection, 'resources/list', maxPages),
    capabilities.resources === undefined
      ? none
      : listAll(connection, 'resources/templates/list', maxPages),
  ]);
  try {
    return createSnapshot({
      protocol: connection.protocol,
      server: client.getServerVersion() ?? {},
      capabilities,
      instructions: client.getInstructions(),
      tools,
      prompts,
      resources,
      resourceTemplates,
    });
  } catch (error) {
    throw new ServerError(
      `${connection.description} returned data that cannot be snapshotted: ${describeError(error)}`,
      { cause: error },
    );
  }
}

/**
 * Connects to a server, captures a snapshot and disconnects (terminating a
 * spawned process), whether or not capturing succeeds.
 *
 * @example
 * ```ts
 * const snapshot = await snapshotServer({ type: 'stdio', command: 'node', args: ['server.js'] });
 * ```
 */
export async function snapshotServer(
  target: ServerTarget,
  options: SnapshotServerOptions = {},
): Promise<Snapshot> {
  return withServer(target, options, (connection) => captureSnapshot(connection, options));
}
