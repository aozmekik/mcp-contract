import { InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { ServerError } from '../../src/core/errors.ts';
import { captureSnapshot, snapshotServer } from '../../src/snapshot/capture.ts';
import { connectInMemory, paginate } from '../helpers/in-memory.ts';
import { rawServer, type RawServer } from '../helpers/raw-server.ts';

const tools = Array.from({ length: 5 }, (_, i) => ({
  name: `tool_${String(4 - i)}`,
  inputSchema: { type: 'object' as const, properties: { n: { type: 'integer' } } },
}));

function pagedServer(): { server: RawServer; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const count = (method: string): void => {
    calls.set(method, (calls.get(method) ?? 0) + 1);
  };
  const server = rawServer('paged', { tools: {}, prompts: {}, resources: {} }, 'Read the docs.');
  server.setRequestHandler('tools/list', (request) => {
    count('tools/list');
    const page = paginate(tools, 2, request.params?.cursor);
    return {
      tools: page.items,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  });
  server.setRequestHandler('prompts/list', (request) => {
    count('prompts/list');
    const page = paginate([{ name: 'b' }, { name: 'a' }, { name: 'c' }], 1, request.params?.cursor);
    return {
      prompts: page.items,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  });
  server.setRequestHandler('resources/list', () => {
    count('resources/list');
    return { resources: [{ uri: 'r://1', name: 'one' }] };
  });
  server.setRequestHandler('resources/templates/list', (request) => {
    count('resources/templates/list');
    const page = paginate(
      [
        { uriTemplate: 't://{x}', name: 'x' },
        { uriTemplate: 't://{a}', name: 'a' },
      ],
      1,
      request.params?.cursor,
    );
    return {
      resourceTemplates: page.items,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  });
  return { server, calls };
}

describe('captureSnapshot', () => {
  it('follows every pagination cursor and records server metadata', async () => {
    const { server, calls } = pagedServer();
    await using connection = await connectInMemory(server);
    const snapshot = await captureSnapshot(connection);
    expect(snapshot.tools.map((tool) => tool.name)).toEqual([
      'tool_0',
      'tool_1',
      'tool_2',
      'tool_3',
      'tool_4',
    ]);
    expect(snapshot.prompts.map((prompt) => prompt.name)).toEqual(['a', 'b', 'c']);
    expect(snapshot.resourceTemplates.map((template) => template.uriTemplate)).toEqual([
      't://{a}',
      't://{x}',
    ]);
    expect(snapshot.resources).toHaveLength(1);
    expect(snapshot.server).toEqual({ name: 'paged', version: '3.1.0' });
    expect(snapshot.instructions).toBe('Read the docs.');
    expect(snapshot.protocol).toEqual({ era: 'legacy', version: '2025-11-25' });
    expect(Object.fromEntries(calls)).toEqual({
      'tools/list': 3,
      'prompts/list': 3,
      'resources/list': 1,
      'resources/templates/list': 2,
    });
  });

  it('only lists what the server advertises', async () => {
    // No prompts/resources handlers exist: calling them would fail with
    // "method not found", so a successful capture proves they were not called.
    const server = rawServer('tools-only', { tools: {} });
    server.setRequestHandler('tools/list', () => ({ tools: [] }));
    await using connection = await connectInMemory(server);
    const snapshot = await captureSnapshot(connection);
    expect(snapshot.prompts).toEqual([]);
    expect(snapshot.resources).toEqual([]);
    expect(snapshot.capabilities).toEqual({ tools: {} });
  });

  it('treats a missing resources/templates/list method as no templates', async () => {
    const server = rawServer('static', { resources: {} });
    server.setRequestHandler('resources/list', () => ({
      resources: [{ uri: 'r://a', name: 'a' }],
    }));
    await using connection = await connectInMemory(server);
    const snapshot = await captureSnapshot(connection);
    expect(snapshot.resourceTemplates).toEqual([]);
    expect(snapshot.resources).toHaveLength(1);
  });

  it('refuses to loop on a repeated cursor', async () => {
    const server = rawServer('loop', { tools: {} });
    server.setRequestHandler('tools/list', () => ({ tools: [], nextCursor: 'same' }));
    await using connection = await connectInMemory(server);
    await expect(captureSnapshot(connection)).rejects.toThrow(
      'tools/list returned the cursor "same" twice',
    );
  });

  it('stops after maxPages distinct cursors', async () => {
    const server = rawServer('endless', { tools: {} });
    server.setRequestHandler('tools/list', (request) => ({
      tools: [],
      nextCursor: `${request.params?.cursor ?? ''}x`,
    }));
    await using connection = await connectInMemory(server);
    await expect(captureSnapshot(connection, { maxPages: 3 })).rejects.toThrow(
      'tools/list still returned a next cursor after 3 pages',
    );
  });

  it('wraps list failures in a ServerError naming the method', async () => {
    const server = rawServer('broken', { tools: {} });
    server.setRequestHandler('tools/list', () => {
      throw new Error('database unavailable');
    });
    await using connection = await connectInMemory(server);
    const failure = captureSnapshot(connection);
    await expect(failure).rejects.toBeInstanceOf(ServerError);
    await expect(failure).rejects.toThrow(/tools\/list failed: .*database unavailable/);
  });

  it('rejects listings the SDK cannot validate', async () => {
    const server = rawServer('invalid', { tools: {} });
    server.setRequestHandler('tools/list', () => ({ tools: [{ name: 'no-schema' }] }) as never);
    await using connection = await connectInMemory(server);
    await expect(captureSnapshot(connection)).rejects.toBeInstanceOf(ServerError);
  });
});

describe('snapshotServer', () => {
  it('connects, captures and closes', async () => {
    const { server } = pagedServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    let closed = false;
    clientTransport.onclose = () => {
      closed = true;
    };
    const snapshot = await snapshotServer(
      { type: 'transport', transport: clientTransport },
      { protocol: 'legacy' },
    );
    expect(snapshot.tools).toHaveLength(5);
    expect(closed).toBe(true);
  });
});
