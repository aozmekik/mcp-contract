import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidFileError } from '../../src/core/errors.ts';
import { readSnapshot, writeSnapshot } from '../../src/snapshot/files.ts';
import {
  createSnapshot,
  normalizeSnapshot,
  parseSnapshot,
  serializeSnapshot,
} from '../../src/snapshot/format.ts';
import { snapshotOf, tool } from '../helpers/snapshots.ts';

describe('createSnapshot', () => {
  it('sorts every list by identity and every object by key', () => {
    const snapshot = snapshotOf({
      tools: [
        tool('zeta'),
        tool('alpha', { description: 'first', annotations: { readOnlyHint: true } }),
      ],
      prompts: [{ name: 'b' }, { name: 'a' }],
      resources: [
        { uri: 'notes://z', name: 'z' },
        { uri: 'notes://a', name: 'a' },
      ],
      resourceTemplates: [
        { uriTemplate: 'x://{b}', name: 'b' },
        { uriTemplate: 'x://{a}', name: 'a' },
      ],
    });
    expect(snapshot.tools.map((t) => t.name)).toEqual(['alpha', 'zeta']);
    expect(snapshot.prompts.map((p) => p.name)).toEqual(['a', 'b']);
    expect(snapshot.resources.map((r) => r.uri)).toEqual(['notes://a', 'notes://z']);
    expect(snapshot.resourceTemplates.map((r) => r.uriTemplate)).toEqual(['x://{a}', 'x://{b}']);
    expect(Object.keys(snapshot.tools[0] ?? {})).toEqual([
      'annotations',
      'description',
      'inputSchema',
      'name',
    ]);
  });

  it('normalises set-valued schema keywords without touching enum order', () => {
    const snapshot = snapshotOf({
      tools: [
        tool('t', {
          inputSchema: {
            type: 'object',
            properties: { b: { type: ['null', 'string', 'null'] }, a: { enum: ['z', 'a'] } },
            required: ['b', 'a', 'b'],
          },
        }),
      ],
    });
    expect(snapshot.tools[0]?.inputSchema).toEqual({
      type: 'object',
      properties: { a: { enum: ['z', 'a'] }, b: { type: ['null', 'string'] } },
      required: ['a', 'b'],
    });
  });

  it('keeps duplicates in a stable order', () => {
    const snapshot = snapshotOf({
      tools: [tool('t', { description: 'b' }), tool('t', { description: 'a' })],
    });
    expect(snapshot.tools.map((t) => t.description)).toEqual(['a', 'b']);
  });

  it('rejects data without identity fields', () => {
    expect(() =>
      createSnapshot({
        protocol: { era: 'legacy', version: '2025-11-25' },
        server: {},
        capabilities: {},
        tools: [{ description: 'no name' }],
        prompts: [],
        resources: [],
        resourceTemplates: [],
      }),
    ).toThrow(/Invalid snapshot data/);
  });
});

describe('serializeSnapshot', () => {
  it('is deterministic and independent of input order (property)', () => {
    const tools = fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), {
      minLength: 0,
      maxLength: 6,
    });
    fc.assert(
      fc.property(tools, (names) => {
        const forward = serializeSnapshot(snapshotOf({ tools: names.map((name) => tool(name)) }));
        const backward = serializeSnapshot(
          snapshotOf({ tools: [...names].reverse().map((name) => tool(name)) }),
        );
        expect(forward).toBe(backward);
        expect(serializeSnapshot(parseSnapshot(forward))).toBe(forward);
      }),
    );
  });

  it('writes two-space JSON with a trailing newline and no timestamps', () => {
    const text = serializeSnapshot(snapshotOf({ instructions: 'Be careful.' }));
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "formatVersion": 1,');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('normalizeSnapshot is idempotent', () => {
    const snapshot = snapshotOf({ tools: [tool('b'), tool('a')] });
    expect(normalizeSnapshot(normalizeSnapshot(snapshot))).toEqual(normalizeSnapshot(snapshot));
  });
});

describe('parseSnapshot', () => {
  it('reports invalid JSON', () => {
    expect(() => parseSnapshot('{', 'old.json')).toThrow(InvalidFileError);
    expect(() => parseSnapshot('{', 'old.json')).toThrow(/^old\.json: not valid JSON/);
  });

  it('reports unsupported format versions', () => {
    expect(() => parseSnapshot('{"formatVersion": 2}', 's.json')).toThrow(
      /snapshot format version 2 is not supported/,
    );
  });

  it('reports schema violations with their location', () => {
    const text = JSON.stringify({
      ...JSON.parse(serializeSnapshot(snapshotOf())),
      tools: [{ name: 1 }],
    });
    expect(() => parseSnapshot(text, 's.json')).toThrow(
      /not a valid mcp-contract snapshot[\s\S]*tools/,
    );
  });
});

describe('snapshot files', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mcp-contract-files-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('writes atomically and reads back the same snapshot', async () => {
    const path = join(directory, 'contract.json');
    const snapshot = snapshotOf({ tools: [tool('search')] });
    const text = await writeSnapshot(path, snapshot);
    expect(await readFile(path, 'utf8')).toBe(text);
    expect(await readSnapshot(path)).toEqual(snapshot);
    expect(await readdir(directory)).toEqual(['contract.json']);
  });

  it('replaces an existing file', async () => {
    const path = join(directory, 'contract.json');
    await writeFile(path, 'old', 'utf8');
    await writeSnapshot(path, snapshotOf());
    expect(await readSnapshot(path)).toEqual(snapshotOf());
  });

  it('cleans up the temporary file when the target cannot be written', async () => {
    const target = join(directory, 'missing-dir', 'contract.json');
    await expect(writeSnapshot(target, snapshotOf())).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it('distinguishes a missing file from an unreadable one', async () => {
    await expect(readSnapshot(join(directory, 'nope.json'))).rejects.toThrow(/file not found/);
    await expect(readSnapshot(directory)).rejects.toThrow(/cannot read file \(EISDIR\)/);
  });
});
