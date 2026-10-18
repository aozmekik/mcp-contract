/**
 * Negotiation against genuine 2025-era servers, the main real-world path for
 * `--protocol auto`: one built with the v1 SDK (it rejects `server/discover`)
 * and a hand-written one that ignores requests it does not know.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectServer } from '../../src/connect/connect.ts';
import { diffSnapshots } from '../../src/diff/snapshot-diff.ts';
import { snapshotServer } from '../../src/snapshot/capture.ts';
import { ROOT, createPidLog, nodeTarget, waitForExit, type PidLog } from '../helpers/processes.ts';

const V1_SDK_SERVER = join(ROOT, 'test', 'fixtures', 'v1-sdk-server.ts');
const SILENT_SERVER = join(ROOT, 'test', 'fixtures', 'silent-legacy-server.ts');

let log: PidLog;

beforeEach(async () => {
  log = await createPidLog();
});

afterEach(async () => {
  await log.dispose();
});

function target(file: string) {
  return nodeTarget(file, [], { env: { MCP_CONTRACT_PID_FILE: log.path } });
}

describe('2025-era servers', () => {
  it('fall back to the initialize handshake under auto (v1 SDK server)', async () => {
    const snapshot = await snapshotServer(target(V1_SDK_SERVER));
    expect(snapshot.protocol).toEqual({
      era: 'legacy',
      version: '2025-11-25',
      negotiation: 'auto',
    });
    expect(snapshot.server).toMatchObject({ name: 'v1-sdk', version: '1.0.0' });
    expect(snapshot.tools[0]?.inputSchema).toMatchObject({
      properties: { text: { type: 'string', maxLength: 100 } },
      required: ['text'],
    });
    const pids = await log.pids();
    expect(pids).toHaveLength(2); // the protocol probe and the session
    expect(await waitForExit(pids)).toEqual([]);
  });

  it('give identical snapshots with auto and legacy negotiation, apart from the mode', async () => {
    const [auto, legacy] = await Promise.all([
      snapshotServer(target(V1_SDK_SERVER)),
      snapshotServer(target(V1_SDK_SERVER), { protocol: 'legacy' }),
    ]);
    expect(legacy.protocol.negotiation).toBe('legacy');
    expect(diffSnapshots(auto, legacy).changes).toEqual([]);
    expect(await waitForExit(await log.pids())).toEqual([]);
  });

  it('are detected after the probe timeout when they ignore the probe', async () => {
    const diagnostics: string[] = [];
    await using connection = await connectServer(target(SILENT_SERVER), {
      probeTimeoutMs: 300,
      onDiagnostic: (message) => diagnostics.push(message),
    });
    expect(connection.protocol).toEqual({
      era: 'legacy',
      version: '2025-11-25',
      negotiation: 'auto',
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('--protocol legacy');
    await connection.close();
    expect(await waitForExit(await log.pids())).toEqual([]);
  });

  it('produce no diagnostic when the legacy handshake is chosen up front', async () => {
    const diagnostics: string[] = [];
    await using connection = await connectServer(target(SILENT_SERVER), {
      protocol: 'legacy',
      onDiagnostic: (message) => diagnostics.push(message),
    });
    expect(connection.protocol.era).toBe('legacy');
    expect(diagnostics).toEqual([]);
  });
});
