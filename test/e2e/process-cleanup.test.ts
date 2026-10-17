/**
 * Every child process mcp-contract spawns must be gone afterwards, whether the
 * run succeeds, times out, crashes or is aborted. The fixture server records
 * its pid, including the short-lived sibling the SDK spawns to probe the
 * protocol revision.
 */
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectServer } from '../../src/connect/connect.ts';
import { ServerError } from '../../src/core/errors.ts';
import { snapshotServer } from '../../src/snapshot/capture.ts';
import {
  FIXTURE_SERVER,
  createPidLog,
  nodeTarget,
  waitForExit,
  type PidLog,
} from '../helpers/processes.ts';

let log: PidLog;

beforeEach(async () => {
  log = await createPidLog();
});

afterEach(async () => {
  await log.dispose();
});

function fixture(mode: string) {
  return nodeTarget(FIXTURE_SERVER, [mode], { env: { MCP_CONTRACT_PID_FILE: log.path } });
}

/**
 * Records the child's pid as soon as it is spawned, so tests that time out
 * quickly do not depend on how fast the child process starts up.
 */
class RecordingTransport extends StdioClientTransport {
  readonly pids: number[] = [];

  override async start(): Promise<void> {
    await super.start();
    if (this.pid !== null) {
      this.pids.push(this.pid);
    }
  }
}

function recording(mode: string): RecordingTransport {
  return new RecordingTransport({
    command: process.execPath,
    args: [FIXTURE_SERVER, mode],
    stderr: 'ignore',
  });
}

async function expectAllExited(minimum: number): Promise<void> {
  const pids = await log.pids();
  expect(pids.length).toBeGreaterThanOrEqual(minimum);
  expect(await waitForExit(pids)).toEqual([]);
}

describe('child process cleanup', () => {
  it('terminates the server and the protocol probe after a successful snapshot', async () => {
    const snapshot = await snapshotServer(fixture('ok'));
    expect(snapshot.tools.map((tool) => tool.name)).toEqual(['echo']);
    expect(snapshot.protocol).toEqual({ era: 'modern', version: '2026-07-28' });
    await expectAllExited(2); // probe sibling + session process
  });

  it('spawns exactly one process with the legacy handshake', async () => {
    const snapshot = await snapshotServer(fixture('ok'), { protocol: 'legacy' });
    expect(snapshot.protocol.era).toBe('legacy');
    expect(await log.pids()).toHaveLength(1);
    await expectAllExited(1);
  });

  it('terminates a server that never answers', async () => {
    const transport = recording('hang');
    const failure = connectServer(
      { type: 'transport', transport },
      { protocol: 'legacy', timeoutMs: 300 },
    );
    await expect(failure).rejects.toBeInstanceOf(ServerError);
    await expect(failure).rejects.toThrow(/^Could not connect to custom transport: .*timed out/i);
    expect(transport.pids).toHaveLength(1);
    expect(await waitForExit(transport.pids)).toEqual([]);
  });

  it('reports the stderr of a server that crashes on start', async () => {
    let error: unknown;
    try {
      await connectServer(fixture('crash'), { protocol: 'legacy', timeoutMs: 5_000 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ServerError);
    expect((error as ServerError).serverStderr).toContain('MISSING_API_KEY is not set');
    await expectAllExited(1);
  });

  it('kills a server that ignores stdin EOF and SIGTERM', async () => {
    const transport = recording('stubborn');
    await expect(
      connectServer({ type: 'transport', transport }, { protocol: 'legacy', timeoutMs: 300 }),
    ).rejects.toBeInstanceOf(ServerError);
    expect(transport.pids).toHaveLength(1);
    expect(await waitForExit(transport.pids)).toEqual([]);
  });

  it.each(['legacy', 'auto'] as const)(
    'cleans up when the caller aborts (%s negotiation)',
    async (protocol) => {
      // With `auto` the process that exists at this point is the SDK's protocol probe.
      const controller = new AbortController();
      const failure = connectServer(fixture('hang'), {
        protocol,
        timeoutMs: 60_000,
        signal: controller.signal,
      });
      // Abort once a child exists, without depending on how long that takes.
      while ((await log.pids()).length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.abort();
      await expect(failure).rejects.toBeInstanceOf(ServerError);
      await expectAllExited(1);
    },
  );

  it('closing a connection twice is harmless and await using closes it', async () => {
    {
      await using connection = await connectServer(fixture('ok'), { protocol: 'legacy' });
      expect(connection.protocol.version).toBe('2025-11-25');
      expect(connection.description).toMatch(/^stdio: .*fixture-server\.ts ok$/);
      await connection.close();
    }
    await expectAllExited(1);
  });

  it('reports a command that cannot be started', async () => {
    await expect(
      connectServer(
        { type: 'stdio', command: 'mcp-contract-no-such-command-xyz' },
        { protocol: 'legacy' },
      ),
    ).rejects.toBeInstanceOf(ServerError);
  });
});
