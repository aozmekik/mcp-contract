/**
 * A stdio server for process-lifecycle tests. It appends its pid to the file
 * named by MCP_CONTRACT_PID_FILE (so tests can check that every spawned
 * process is gone afterwards) and then behaves according to its mode:
 *
 *   ok        a working MCP server (default) with two tools: `echo`, and
 *             `sleep`, which appends a line to MCP_CONTRACT_CALL_FILE when it
 *             starts and then waits `ms` milliseconds
 *   hang      reads stdin but never answers; exits when stdin closes
 *   stubborn  never answers and ignores both stdin EOF and SIGTERM
 *   crash     writes an error to stderr and exits with status 1
 *   commands  like crash, but its stderr contains GitHub workflow commands
 */
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';

const pidFile = process.env.MCP_CONTRACT_PID_FILE;
if (pidFile !== undefined) {
  appendFileSync(pidFile, `${String(process.pid)}\n`);
}

const mode = process.argv[2] ?? 'ok';

if (mode === 'crash') {
  process.stderr.write('fatal: MISSING_API_KEY is not set\n');
  process.exit(1);
} else if (mode === 'commands') {
  process.stderr.write('starting\n::error title=Spoofed::all checks passed\n');
  process.exit(1);
} else if (mode === 'hang') {
  process.stdin.resume();
} else if (mode === 'stubborn') {
  process.stdin.resume();
  process.on('SIGTERM', () => undefined);
  setInterval(() => undefined, 1000);
} else {
  serveStdio(() => {
    const server = new McpServer({ name: 'fixture', version: '0.0.1' });
    server.registerTool(
      'echo',
      { description: 'Echoes its input.', inputSchema: z.object({ text: z.string() }) },
      ({ text }) => ({ content: [{ type: 'text', text }] }),
    );
    server.registerTool(
      'sleep',
      { description: 'Waits.', inputSchema: z.object({ ms: z.number() }) },
      async ({ ms }) => {
        const callFile = process.env.MCP_CONTRACT_CALL_FILE;
        if (callFile !== undefined) {
          appendFileSync(callFile, 'sleep\n');
        }
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { content: [{ type: 'text', text: 'done' }] };
      },
    );
    return server;
  });
}
