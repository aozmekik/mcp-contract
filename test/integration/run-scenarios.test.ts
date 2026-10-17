import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { parseScenarios } from '../../src/scenarios/file.ts';
import { runScenarios } from '../../src/scenarios/run.ts';
import { connectInMemory } from '../helpers/in-memory.ts';
import { rawServer } from '../helpers/raw-server.ts';

function server(): McpServer {
  const mcp = new McpServer({ name: 'fixture', version: '1.0.0' });
  mcp.registerTool(
    'add',
    {
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      outputSchema: z.object({ sum: z.number() }),
    },
    ({ a, b }) => ({
      content: [{ type: 'text', text: `sum is ${String(a + b)}` }],
      structuredContent: { sum: a + b },
    }),
  );
  mcp.registerTool('fail', { inputSchema: z.object({}) }, () => ({
    content: [{ type: 'text', text: 'Something went wrong on purpose.' }],
    isError: true,
  }));
  mcp.registerTool(
    'lie',
    { inputSchema: z.object({}), outputSchema: z.object({ sum: z.number() }) },
    // Deliberately wrong: the output schema says sum is a number.
    () => ({ content: [], structuredContent: { sum: 'not a number' } }),
  );
  mcp.registerTool(
    'hang',
    { inputSchema: z.object({}) },
    () => new Promise<never>(() => undefined),
  );
  return mcp;
}

async function run(yaml: string) {
  const { scenarios } = parseScenarios(yaml);
  await using connection = await connectInMemory(server());
  let tick = 0;
  // `return await`: the connection must stay open until the scenarios finish.
  return await runScenarios(connection, scenarios, { now: () => (tick += 5) });
}

describe('runScenarios', () => {
  it('passes matching scenarios and measures them with the injected clock', async () => {
    const results = await run(`
scenarios:
  - name: adds
    tool: add
    arguments: { a: 2, b: 3 }
    expect:
      result: { structuredContent: { sum: 5 } }
      select:
        $.content[0].text: { $regex: '^sum is 5$' }
        $.content[*].type: text
        $.structuredContent.missing: { $exists: false }
  - name: expected tool error
    tool: fail
    expect:
      isError: true
      select:
        $.content[0].text: { $contains: 'on purpose' }
  - name: expected protocol error
    tool: nope
    expect:
      error: { code: -32602, message: { $regex: nope } }
`);
    expect(results).toEqual([
      { name: 'adds', tool: 'add', passed: true, failures: [], durationMs: 5 },
      { name: 'expected tool error', tool: 'fail', passed: true, failures: [], durationMs: 5 },
      { name: 'expected protocol error', tool: 'nope', passed: true, failures: [], durationMs: 5 },
    ]);
  });

  it('explains every kind of failure', async () => {
    const results = await run(`
scenarios:
  - name: wrong value
    tool: add
    arguments: { a: 2, b: 3 }
    expect:
      result: { structuredContent: { sum: 6 } }
      select:
        $.structuredContent.sum: { $gt: 10 }
        $.nothing.here: 1
        $.structuredContent: { $exists: false }
  - name: unexpected tool error
    tool: fail
  - name: expected an error but succeeded
    tool: add
    arguments: { a: 1, b: 1 }
    expect: { isError: true }
  - name: expected a protocol error but got a result
    tool: add
    arguments: { a: 1, b: 1 }
    expect: { error: { code: -32602 } }
  - name: wrong protocol error
    tool: nope
    expect: { error: { code: -32000 } }
  - name: unexpected protocol error
    tool: nope
`);
    expect(results.map((result) => [result.name, result.passed, result.failures])).toEqual([
      [
        'wrong value',
        false,
        [
          'result mismatch at $.structuredContent.sum: expected 6, found 5',
          '$.structuredContent.sum: expected a number gt 10, found 5',
          '$.nothing.here: selected nothing',
          '$.structuredContent: expected no value, found 1',
        ],
      ],
      [
        'unexpected tool error',
        false,
        [
          'expected the tool to succeed, but it returned isError: true (Something went wrong on purpose.)',
        ],
      ],
      [
        'expected an error but succeeded',
        false,
        ['expected isError: true, but the tool succeeded'],
      ],
      [
        'expected a protocol error but got a result',
        false,
        ['expected the call to fail with a protocol error, but it returned a result'],
      ],
      [
        'wrong protocol error',
        false,
        ['error mismatch at error.code: expected -32000, found -32602'],
      ],
      ['unexpected protocol error', false, [expect.stringMatching(/^tool call failed: .*nope/)]],
    ]);
  });

  it('reports output the SDK server rejects itself', async () => {
    const [result] = await run('scenarios: [{ name: lies, tool: lie }]');
    expect(result?.passed).toBe(false);
    expect(result?.failures[0]).toMatch(/isError: true \(Output validation error/);
  });

  it('reports structuredContent that violates the listed outputSchema', async () => {
    // A low-level server that does not validate its own output.
    const raw = rawServer('raw', { tools: {} });
    raw.setRequestHandler('tools/list', () => ({
      tools: [
        {
          name: 'lie',
          inputSchema: { type: 'object' },
          outputSchema: {
            type: 'object',
            properties: { sum: { type: 'number' } },
            required: ['sum'],
          },
        },
      ],
    }));
    raw.setRequestHandler('tools/call', () => ({ content: [], structuredContent: { sum: 'x' } }));
    await using connection = await connectInMemory(raw);
    const [result] = await runScenarios(
      connection,
      parseScenarios('scenarios: [{ name: lies, tool: lie }]').scenarios,
    );
    expect(result?.failures[0]).toMatch(
      /^tool call failed: Structured content does not match the tool's output schema/,
    );
  });

  it('applies per-scenario timeouts and carries on with the next scenario', async () => {
    const results = await run(`
scenarios:
  - { name: slow, tool: hang, timeoutMs: 50 }
  - { name: fast, tool: add, arguments: { a: 1, b: 2 } }
`);
    expect(results.map((result) => result.passed)).toEqual([false, true]);
    expect(results[0]?.failures[0]).toMatch(/^tool call failed: .*timed out/i);
  });

  it('shows the selector path only once when it is the mismatch path', async () => {
    const [result] = await run(`
scenarios:
  - name: nested
    tool: add
    arguments: { a: 1, b: 1 }
    expect:
      select:
        $.structuredContent: { sum: 3 }
        $.structuredContent.sum: 4
`);
    expect(result?.failures).toEqual([
      '$.structuredContent: at $.structuredContent.sum: expected 3, found 2',
      '$.structuredContent.sum: expected 4, found 2',
    ]);
  });
});
