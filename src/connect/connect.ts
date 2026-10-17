import {
  Client,
  StreamableHTTPClientTransport,
  type ProtocolEra,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { ServerError, UsageError, describeError } from '../core/errors.ts';
import { VERSION } from '../version.ts';
import { quoteWord } from './command-line.ts';

/** Spawn a server as a child process and speak MCP over its stdin/stdout. */
export interface StdioTarget {
  /** Discriminator. */
  readonly type: 'stdio';
  /** Executable to run (resolved through `PATH`). */
  readonly command: string;
  /** Arguments passed to the executable. */
  readonly args?: readonly string[];
  /** Working directory of the child process. Defaults to the current directory. */
  readonly cwd?: string;
  /**
   * Extra environment variables. They are added on top of the SDK's safe default
   * environment (`PATH`, `HOME`, ...); the rest of the parent environment is
   * not inherited, so secrets do not leak into servers by accident.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * What to do with the server's stderr. `pipe` (default) keeps the last 16 KiB
   * so it can be shown when something goes wrong; `inherit` streams it to this
   * process's stderr; `ignore` discards it.
   */
  readonly stderr?: 'pipe' | 'inherit' | 'ignore';
}

/** Connect to a server over the Streamable HTTP transport. */
export interface HttpTarget {
  /** Discriminator. */
  readonly type: 'http';
  /** The MCP endpoint, e.g. `http://localhost:3000/mcp`. */
  readonly url: string | URL;
  /** Headers sent with every request, e.g. `Authorization`. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Use an already-constructed SDK transport, e.g. an in-memory pair in unit tests. */
export interface TransportTarget {
  /** Discriminator. */
  readonly type: 'transport';
  /** The transport to connect through. It is closed together with the connection. */
  readonly transport: Transport;
}

/** Where the server under test lives. */
export type ServerTarget = StdioTarget | HttpTarget | TransportTarget;

/**
 * How to negotiate the protocol revision:
 *
 * - `auto` (default): probe with `server/discover` (revision 2026-07-28) and fall
 *   back to the `initialize` handshake used by 2025-era servers;
 * - `legacy`: only use the `initialize` handshake (no probe);
 * - `{ pin: '2026-07-28' }`: require exactly that modern revision.
 */
export type ProtocolMode = 'auto' | 'legacy' | { readonly pin: string };

/** The protocol revision a connection negotiated. */
export interface ProtocolInfo {
  /** `legacy` for the initialize-based revisions (2025-11-25 and earlier), `modern` for 2026-07-28+. */
  readonly era: ProtocolEra;
  /** The negotiated revision, e.g. `2025-11-25` or `2026-07-28`. */
  readonly version: string;
}

/** Options for {@link connectServer}. */
export interface ConnectOptions {
  /** Protocol negotiation mode. Defaults to `auto`. */
  readonly protocol?: ProtocolMode;
  /** Timeout for connecting and for each request, in milliseconds. Defaults to 30 000. */
  readonly timeoutMs?: number;
  /** Aborts the connection attempt and any request made through the connection. */
  readonly signal?: AbortSignal;
}

/** An open connection to an MCP server. Close it (or `await using` it) when done. */
export interface ServerConnection extends AsyncDisposable {
  /** The underlying SDK client, for calls mcp-contract does not wrap. */
  readonly client: Client;
  /** The negotiated protocol revision. */
  readonly protocol: ProtocolInfo;
  /** A human-readable description of the target, safe to print. */
  readonly description: string;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Signal that aborts requests made through this connection, if one was given. */
  readonly signal: AbortSignal | undefined;
  /** The captured tail of the server's stderr (stdio targets with `stderr: 'pipe'`). */
  serverStderr(): string;
  /** Closes the connection and, for stdio targets, terminates the child process. Idempotent. */
  close(): Promise<void>;
}

/** Default timeout for connecting and for each request. */
export const DEFAULT_TIMEOUT_MS = 30_000;

const STDERR_TAIL_BYTES = 16 * 1024;

/** Returns a printable description of a target that does not leak query strings or credentials. */
export function describeTarget(target: ServerTarget): string {
  switch (target.type) {
    case 'stdio':
      return `stdio: ${[target.command, ...(target.args ?? [])].map(quoteWord).join(' ')}`;
    case 'http': {
      if (!URL.canParse(String(target.url))) {
        return 'http: (invalid URL)';
      }
      const url = new URL(target.url);
      return `http: ${url.origin}${url.pathname}`;
    }
    case 'transport':
      return 'custom transport';
  }
}

interface PreparedTransport {
  readonly transport: Transport;
  readonly stderrTail: () => string;
}

function prepareTransport(target: ServerTarget): PreparedTransport {
  switch (target.type) {
    case 'stdio': {
      const stderrMode = target.stderr ?? 'pipe';
      const transport = new StdioClientTransport({
        command: target.command,
        args: [...(target.args ?? [])],
        env: { ...getDefaultEnvironment(), ...target.env },
        stderr: stderrMode,
        ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
      });
      let tail = '';
      if (stderrMode === 'pipe') {
        // The SDK hands out the PassThrough before start(), so no early output is lost.
        transport.stderr?.on('data', (chunk: Buffer | string) => {
          tail = (tail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
        });
      }
      return { transport, stderrTail: () => tail };
    }
    case 'http': {
      let url: URL;
      try {
        url = new URL(target.url);
      } catch (error) {
        throw new UsageError(`Invalid server URL: ${String(target.url)}`, { cause: error });
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new UsageError(`Server URL must use http or https: ${url.href}`);
      }
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { ...target.headers } },
      });
      return { transport, stderrTail: () => '' };
    }
    case 'transport':
      return { transport: target.transport, stderrTail: () => '' };
  }
}

function negotiationMode(protocol: ProtocolMode | undefined): 'auto' | 'legacy' | { pin: string } {
  if (protocol === undefined || protocol === 'auto') {
    return 'auto';
  }
  if (protocol === 'legacy') {
    return 'legacy';
  }
  return { pin: protocol.pin };
}

async function closeQuietly(client: Client, transport: Transport): Promise<void> {
  if (transport instanceof StreamableHTTPClientTransport) {
    try {
      await transport.terminateSession();
    } catch {
      // Best effort: a stateless server has no session to terminate.
    }
  }
  try {
    await client.close();
  } catch {
    // Closing must never mask the error that made us close.
  }
  try {
    // client.close() closes the transport once connected; this covers the
    // not-yet-connected case. Transports treat a second close as a no-op.
    await transport.close();
  } catch {
    // Ignore: already closed.
  }
}

/**
 * Connects to an MCP server and negotiates the protocol revision.
 *
 * The returned connection owns the transport: closing it terminates a spawned
 * child process (stdin closed, then `SIGTERM`, then `SIGKILL`), and the child is
 * also cleaned up when connecting fails.
 *
 * @throws {UsageError} for an invalid target.
 * @throws {ServerError} when the server cannot be started or reached, or the handshake fails.
 */
export async function connectServer(
  target: ServerTarget,
  options: ConnectOptions = {},
): Promise<ServerConnection> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new UsageError(`Timeout must be a positive number of milliseconds, got ${timeoutMs}`);
  }
  const { signal } = options;
  if (signal?.aborted === true) {
    throw new ServerError(
      `Could not connect to ${describeTarget(target)}: aborted before starting`,
      {
        cause: signal.reason,
      },
    );
  }
  const { transport, stderrTail } = prepareTransport(target);
  const description = describeTarget(target);
  const client = new Client(
    { name: 'mcp-contract', version: VERSION },
    { versionNegotiation: { mode: negotiationMode(options.protocol) } },
  );

  // The SDK does not watch the signal while it probes a stdio server on a
  // sibling process, but closing the transport aborts that probe and reaps the
  // sibling. Closing on abort therefore stops every phase of the connect.
  const onAbort = (): void => {
    transport.close().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await client.connect(transport, {
      timeout: timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    await closeQuietly(client, transport);
    throw new ServerError(`Could not connect to ${description}: ${describeError(error)}`, {
      cause: error,
      serverStderr: stderrTail(),
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  const era = client.getProtocolEra();
  const version = client.getNegotiatedProtocolVersion();
  if (era === undefined || version === undefined) {
    await closeQuietly(client, transport);
    throw new ServerError(`${description} connected without negotiating a protocol version`, {
      serverStderr: stderrTail(),
    });
  }

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => (closing ??= closeQuietly(client, transport));
  return {
    client,
    protocol: { era, version },
    description,
    timeoutMs,
    signal: options.signal,
    serverStderr: stderrTail,
    close,
    [Symbol.asyncDispose]: close,
  };
}

/**
 * Connects, runs `fn`, and always closes the connection afterwards, even when
 * `fn` throws or the signal aborts.
 */
export async function withServer<T>(
  target: ServerTarget,
  options: ConnectOptions,
  fn: (connection: ServerConnection) => Promise<T>,
): Promise<T> {
  const connection = await connectServer(target, options);
  try {
    return await fn(connection);
  } finally {
    await connection.close();
  }
}
