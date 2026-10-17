/**
 * Transport bootstrap shared by the example servers.
 *
 *   node v1.ts                    serve over stdio (default)
 *   node v1.ts --http [--port N]  serve over Streamable HTTP on 127.0.0.1
 *
 * In HTTP mode the server prints one line, `listening on http://127.0.0.1:<port>/mcp`,
 * to stdout once it accepts connections (port 0 picks a free port).
 */
import { createServer } from 'node:http';
import process from 'node:process';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

/** Serves the server built by `factory` over stdio or, with `--http`, over Streamable HTTP. */
export function serve(
  factory: () => McpServer,
  argv: readonly string[] = process.argv.slice(2),
): void {
  if (!argv.includes('--http')) {
    // One server instance per connection; the process exits when stdin closes.
    serveStdio(factory);
    return;
  }

  const port = Number(option(argv, '--port') ?? '0');
  // A fresh server per request: the 2026-07-28 protocol is stateless, and the
  // handler also answers 2025-era clients with its stateless legacy fallback.
  const handler = createMcpHandler(() => factory());
  const handle = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const http = createServer((request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response)) {
      return;
    }
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    // IncomingMessage declares `method?: string | undefined` while the SDK's structural
    // type declares `method?: string`; they only differ under exactOptionalPropertyTypes.
    void handle(request as Parameters<typeof handle>[0], response);
  });

  http.listen(port, '127.0.0.1', () => {
    const address = http.address();
    const actualPort = typeof address === 'object' && address !== null ? address.port : port;
    process.stdout.write(`listening on http://127.0.0.1:${actualPort}/mcp\n`);
  });

  const shutdown = (): void => {
    http.closeAllConnections();
    http.close();
    void handler.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
