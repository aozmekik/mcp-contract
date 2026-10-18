/**
 * A minimal hand-written 2025-era stdio server that, like some real servers,
 * silently ignores every request it does not know, including the
 * `server/discover` probe sent before `initialize`. It records its pid in the
 * file named by MCP_CONTRACT_PID_FILE.
 */
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';

const pidFile = process.env.MCP_CONTRACT_PID_FILE;
if (pidFile !== undefined) {
  appendFileSync(pidFile, `${String(process.pid)}\n`);
}

interface Request {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: { readonly protocolVersion?: string };
}

const results: Readonly<Record<string, (request: Request) => unknown>> = {
  initialize: (request) => ({
    protocolVersion: request.params?.protocolVersion ?? '2025-11-25',
    capabilities: { tools: {} },
    serverInfo: { name: 'silent', version: '1.0.0' },
  }),
  ping: () => ({}),
  'tools/list': () => ({ tools: [{ name: 'noop', inputSchema: { type: 'object' } }] }),
};

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line) as Request;
  const result = request.method === undefined ? undefined : results[request.method];
  if (request.id !== undefined && result !== undefined) {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: result(request) })}\n`,
    );
  }
});
lines.on('close', () => {
  process.exit(0);
});
