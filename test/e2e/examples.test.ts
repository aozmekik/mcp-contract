/**
 * End to end: the example servers are spawned over stdio and over Streamable
 * HTTP, snapshotted live, and the diff between v1 and v2 must be exactly the
 * classification documented in examples/notes-server/v2.ts.
 */
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectServer } from '../../src/connect/connect.ts';
import { diffSnapshots } from '../../src/diff/snapshot-diff.ts';
import { loadScenarios } from '../../src/scenarios/file.ts';
import { runScenarios } from '../../src/scenarios/run.ts';
import { snapshotServer } from '../../src/snapshot/capture.ts';
import { serializeSnapshot } from '../../src/snapshot/format.ts';
import type { Snapshot } from '../../src/snapshot/model.ts';
import { ContractViolationError, expectNoBreakingChanges } from '../../src/testing.ts';
import {
  example,
  killStrayServers,
  nodeTarget,
  startHttp,
  type HttpServer,
} from '../helpers/processes.ts';

/** The documented v1 -> v2 classification, in report order. */
const EXPECTED = [
  ['non-breaking', 'server-info-changed', 'server', 'notes', 'server', undefined],
  ['non-breaking', 'tool-added', 'tool', 'archive_note', undefined, undefined],
  ['breaking', 'required-property-added', 'tool', 'create_note', 'inputSchema', '$.folder'],
  ['non-breaking', 'constraint-loosened', 'tool', 'create_note', 'inputSchema', '$.title'],
  ['breaking', 'tool-removed', 'tool', 'delete_note', undefined, undefined],
  ['unknown', 'alternatives-added', 'tool', 'export_notes', 'inputSchema', '$.destination'],
  ['breaking', 'enum-narrowed', 'tool', 'export_notes', 'inputSchema', '$.format'],
  ['non-breaking', 'enum-widened', 'tool', 'export_notes', 'inputSchema', '$.format'],
  ['unknown', 'hint-changed', 'tool', 'export_notes', 'annotations', undefined],
  ['unknown', 'constraint-changed', 'tool', 'get_note', 'inputSchema', '$.id'],
  ['breaking', 'type-widened', 'tool', 'get_note', 'outputSchema', '$.body'],
  ['non-breaking', 'description-changed', 'tool', 'search_notes', undefined, undefined],
  ['non-breaking', 'property-added', 'tool', 'search_notes', 'inputSchema', '$.cursor'],
  ['breaking', 'constraint-tightened', 'tool', 'search_notes', 'inputSchema', '$.limit'],
  ['non-breaking', 'enum-widened', 'tool', 'search_notes', 'inputSchema', '$.sort'],
  ['non-breaking', 'property-added', 'tool', 'search_notes', 'outputSchema', '$.nextCursor'],
  ['breaking', 'property-removed', 'tool', 'search_notes', 'outputSchema', '$.results[*].score'],
  ['non-breaking', 'argument-added', 'prompt', 'summarize_note', 'arguments.language', undefined],
  ['breaking', 'argument-required', 'prompt', 'summarize_note', 'arguments.style', undefined],
  ['breaking', 'mime-type-changed', 'resource', 'notes://index', undefined, undefined],
  ['non-breaking', 'resource-added', 'resource', 'notes://stats', undefined, undefined],
] as const;

function classification(before: Snapshot, after: Snapshot) {
  return diffSnapshots(before, after).changes.map((change) => [
    change.severity,
    change.code,
    change.entity,
    change.name,
    change.location,
    change.path,
  ]);
}

describe('examples over stdio', () => {
  let v1: Snapshot;
  let v2: Snapshot;

  beforeAll(async () => {
    [v1, v2] = await Promise.all([
      snapshotServer(nodeTarget(example('v1.ts'))),
      snapshotServer(nodeTarget(example('v2.ts'))),
    ]);
  });

  it('negotiates the current protocol revision with the v2 SDK server', () => {
    expect(v1.protocol).toEqual({
      era: 'modern',
      version: '2026-07-28',
      negotiation: 'auto',
      supportedVersions: ['2026-07-28'],
    });
    expect(v1.tools.map((tool) => tool.name)).toEqual([
      'create_note',
      'delete_note',
      'export_notes',
      'get_note',
      'search_notes',
    ]);
  });

  it('produces exactly the committed baseline, byte for byte', async () => {
    expect(serializeSnapshot(v1)).toBe(await readFile(example('v1.snapshot.json'), 'utf8'));
  });

  it('classifies every v2 change exactly as documented', () => {
    expect(classification(v1, v2)).toEqual(EXPECTED);
    expect(diffSnapshots(v1, v2).summary).toEqual({ breaking: 8, unknown: 3, nonBreaking: 10 });
  });

  it('works as a test assertion', () => {
    expect(() => expectNoBreakingChanges(v1, v2)).toThrow(ContractViolationError);
    expect(expectNoBreakingChanges(v1, v1).changes).toEqual([]);
  });
});

describe('examples over Streamable HTTP', () => {
  let servers: HttpServer[] = [];

  beforeAll(async () => {
    servers = await Promise.all([startHttp(example('v1.ts')), startHttp(example('v2.ts'))]);
  });

  afterAll(async () => {
    await Promise.all(servers.map((server) => server.stop()));
    killStrayServers();
  });

  const target = (index: number) => ({ type: 'http' as const, url: servers[index]?.url ?? '' });

  it('gives the same snapshots and classification as stdio', async () => {
    const [httpV1, httpV2, stdioV1] = await Promise.all([
      snapshotServer(target(0)),
      snapshotServer(target(1)),
      snapshotServer(nodeTarget(example('v1.ts'))),
    ]);
    expect(diffSnapshots(stdioV1, httpV1).changes).toEqual([]);
    expect(classification(httpV1, httpV2)).toEqual(EXPECTED);
  });

  it('also serves 2025-era clients; revisions negotiated differently are not compared', async () => {
    const [modern, legacy] = await Promise.all([
      snapshotServer(target(0)),
      snapshotServer(target(0), { protocol: 'legacy' }),
    ]);
    expect(legacy.protocol).toEqual({
      era: 'legacy',
      version: '2025-11-25',
      negotiation: 'legacy',
    });
    expect(classification(modern, legacy)).toEqual([
      ['non-breaking', 'protocol-not-compared', 'server', 'notes', 'protocol', undefined],
    ]);
  });

  it('can require the modern revision', async () => {
    const pinned = await snapshotServer(target(0), { protocol: { pin: '2026-07-28' } });
    expect(pinned.protocol.version).toBe('2026-07-28');
  });

  it('runs the example scenarios: all pass on v1, two fail on v2', async () => {
    const { scenarios } = await loadScenarios(example('scenarios.yaml'));
    const outcomes: boolean[][] = [];
    for (const index of [0, 1]) {
      await using connection = await connectServer(target(index));
      outcomes.push((await runScenarios(connection, scenarios)).map((result) => result.passed));
    }
    expect(outcomes).toEqual([
      [true, true, true, true, true],
      [true, false, false, true, true],
    ]);
  });

  it('sends custom headers and reports unreachable servers as server errors', async () => {
    const snapshot = await snapshotServer({ ...target(0), headers: { 'X-Test': 'yes' } });
    expect(snapshot.tools).toHaveLength(5);
    await expect(
      snapshotServer(
        { type: 'http', url: `${servers[0]?.url ?? ''}/missing` },
        { timeoutMs: 2_000 },
      ),
    ).rejects.toThrow(/^Could not connect to http: http:\/\/127\.0\.0\.1:\d+\/mcp\/missing/);
  });
});
