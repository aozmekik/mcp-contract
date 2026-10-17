import { InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  connectServer,
  type ConnectOptions,
  type ServerConnection,
} from '../../src/connect/connect.ts';
import type { RawServer } from './raw-server.ts';

/**
 * Connects mcp-contract to an in-process server over the SDK's linked
 * in-memory transport. The legacy handshake is used because a server connected
 * directly to a transport (rather than through serveStdio/createMcpHandler)
 * only speaks the 2025 protocol.
 */
export async function connectInMemory(
  server: RawServer | McpServer,
  options: ConnectOptions = {},
): Promise<ServerConnection> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return connectServer(
    { type: 'transport', transport: clientTransport },
    { protocol: 'legacy', ...options },
  );
}

/** Splits `items` into pages addressed by numeric string cursors. */
export function paginate<T>(
  items: readonly T[],
  pageSize: number,
  cursor: string | undefined,
): { items: T[]; nextCursor?: string } {
  const start = cursor === undefined ? 0 : Number(cursor);
  const end = start + pageSize;
  return {
    items: items.slice(start, end),
    ...(end < items.length ? { nextCursor: String(end) } : {}),
  };
}
