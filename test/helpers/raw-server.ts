// The SDK marks its low-level `Server` as deprecated in favour of `McpServer`.
// These tests use it on purpose: it can send raw pagination cursors and results
// that violate their own schema, which `McpServer` would never produce. Keeping
// the two references here leaves `no-deprecated` active for the rest of the code.
import { Server, type ServerCapabilities } from '@modelcontextprotocol/server';

/** The SDK's low-level server class. */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- see the comment at the top of this file
export type RawServer = Server;

/** Creates a low-level SDK server that only answers the handlers a test registers. */
export function rawServer(
  name: string,
  capabilities: ServerCapabilities,
  instructions?: string,
): RawServer {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see the comment at the top of this file
  return new Server(
    { name, version: '3.1.0' },
    { capabilities, ...(instructions === undefined ? {} : { instructions }) },
  );
}
