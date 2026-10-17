/**
 * Micro-benchmarks for the diff engine. Prints a Markdown table.
 *
 *   node scripts/bench.ts
 *
 * Cases:
 * - examples: the committed v1 snapshot against a live-equivalent v2 snapshot
 *   (taken from the example servers, 21 changes);
 * - synthetic-200: a generated contract of 200 tools with 25 properties each
 *   (nested objects, arrays, enums, unions), against a copy with every tenth
 *   tool changed. Synthetic data, labelled as such in the README.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { diffSnapshots } from '../src/diff/snapshot-diff.ts';
import { createSnapshot, parseSnapshot } from '../src/snapshot/format.ts';
import type { JsonObject } from '../src/core/json.ts';
import type { Snapshot } from '../src/snapshot/model.ts';
import { snapshotServer } from '../src/snapshot/capture.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN;
}

function measure(name: string, iterations: number, fn: () => unknown): string {
  for (let i = 0; i < Math.min(50, iterations); i += 1) {
    fn(); // warm-up
  }
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return `| ${name} | ${iterations} | ${percentile(samples, 50).toFixed(3)} | ${percentile(samples, 95).toFixed(3)} |`;
}

function syntheticTool(index: number, variant: number): JsonObject {
  const properties: Record<string, JsonObject> = {};
  for (let p = 0; p < 25; p += 1) {
    const kind = p % 5;
    // In the second variant every tenth tool tightens field_0 and drops an enum value of field_2.
    const changed = variant === 1 && index % 10 === 0 && (p === 0 || p === 2);
    properties[`field_${String(p)}`] =
      kind === 0
        ? { type: 'string', maxLength: changed ? 50 : 100, description: `Field ${String(p)}` }
        : kind === 1
          ? { type: 'integer', minimum: 0, maximum: 1000 }
          : kind === 2
            ? { enum: changed ? ['a', 'b'] : ['a', 'b', 'c'] }
            : kind === 3
              ? { anyOf: [{ type: 'string' }, { type: 'null' }] }
              : {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    tags: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['id'],
                };
  }
  return {
    name: `tool_${String(index)}`,
    description: `Synthetic tool ${String(index)}`,
    inputSchema: { type: 'object', properties, required: ['field_0'] },
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  };
}

function syntheticSnapshot(variant: number): Snapshot {
  return createSnapshot({
    protocol: { era: 'modern', version: '2026-07-28' },
    server: { name: 'synthetic', version: '1.0.0' },
    capabilities: { tools: {} },
    tools: Array.from({ length: 200 }, (_, index) => syntheticTool(index, variant)),
    prompts: [],
    resources: [],
    resourceTemplates: [],
  });
}

const v1 = parseSnapshot(await readFile(`${root}examples/notes-server/v1.snapshot.json`, 'utf8'));
const v2 = await snapshotServer({
  type: 'stdio',
  command: process.execPath,
  args: ['examples/notes-server/v2.ts'],
  cwd: root,
});
const before = syntheticSnapshot(0);
const after = syntheticSnapshot(1);

const exampleChanges = diffSnapshots(v1, v2).changes.length;
const syntheticChanges = diffSnapshots(before, after).changes.length;

process.stdout.write(`Node ${process.version} on ${process.platform}/${process.arch}\n\n`);
process.stdout.write('| Case | Iterations | Median (ms) | p95 (ms) |\n| --- | --- | --- | --- |\n');
process.stdout.write(
  `${measure(`examples v1 -> v2 (${String(exampleChanges)} changes)`, 2000, () => diffSnapshots(v1, v2))}\n`,
);
process.stdout.write(
  `${measure('examples v1 -> v1 (no changes)', 2000, () => diffSnapshots(v1, v1))}\n`,
);
process.stdout.write(
  `${measure(`synthetic-200, 200 tools x 25 properties (${String(syntheticChanges)} changes)`, 50, () => diffSnapshots(before, after))}\n`,
);
