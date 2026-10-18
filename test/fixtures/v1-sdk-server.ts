/**
 * A 2025-era stdio server built with the v1 SDK (`@modelcontextprotocol/sdk`),
 * which only speaks the `initialize` handshake. It records its pid in the file
 * named by MCP_CONTRACT_PID_FILE, like the lifecycle fixture.
 */
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';

const pidFile = process.env.MCP_CONTRACT_PID_FILE;
if (pidFile !== undefined) {
  appendFileSync(pidFile, `${String(process.pid)}\n`);
}

const server = new McpServer({ name: 'v1-sdk', version: '1.0.0' });
server.registerTool(
  'echo',
  { description: 'Echoes its input.', inputSchema: { text: z.string().max(100) } },
  ({ text }) => ({ content: [{ type: 'text', text }] }),
);
await server.connect(new StdioServerTransport());
