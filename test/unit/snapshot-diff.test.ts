import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../../src/core/json.ts';
import type { Change } from '../../src/diff/model.ts';
import { failingChanges, severityFails } from '../../src/diff/model.ts';
import { diffSnapshots } from '../../src/diff/snapshot-diff.ts';
import { snapshotOf, tool, type SnapshotParts } from '../helpers/snapshots.ts';

type Row = readonly [Change['severity'], Change['code'], string, string?];

/** `[severity, code, name, location]` rows. */
function rows(before: SnapshotParts, after: SnapshotParts): Row[] {
  return diffSnapshots(snapshotOf(before), snapshotOf(after)).changes.map((change) =>
    change.location === undefined
      ? [change.severity, change.code, change.name]
      : [change.severity, change.code, change.name, change.location],
  );
}

describe('tools', () => {
  it('reports removed tools as breaking and added ones as non-breaking', () => {
    expect(rows({ tools: [tool('a'), tool('b')] }, { tools: [tool('b'), tool('c')] })).toEqual([
      ['breaking', 'tool-removed', 'a'],
      ['non-breaking', 'tool-added', 'c'],
    ]);
  });

  it('reports description, title and icon changes as non-breaking', () => {
    const before = tool('t', { description: 'old', title: 'T' });
    const after = tool('t', {
      description: 'new',
      title: 'T2',
      icons: [{ src: 'https://x/icon.png' }],
    });
    expect(rows({ tools: [before] }, { tools: [after] })).toEqual([
      ['non-breaking', 'title-changed', 't'],
      ['non-breaking', 'description-changed', 't'],
      ['non-breaking', 'icons-changed', 't'],
    ]);
  });

  it('diffs input schemas as client-sent data', () => {
    const before = tool('t', {
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    });
    const after = tool('t', {
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    });
    const [change] = diffSnapshots(
      snapshotOf({ tools: [before] }),
      snapshotOf({ tools: [after] }),
    ).changes;
    expect(change).toMatchObject({
      severity: 'breaking',
      code: 'property-required',
      entity: 'tool',
      name: 't',
      location: 'inputSchema',
      path: '$.q',
    });
  });

  it('diffs output schemas as server-sent data', () => {
    const schema = (type: string): JsonObject => ({ type: 'object', properties: { n: { type } } });
    const before = tool('t', { outputSchema: schema('integer') });
    const after = tool('t', { outputSchema: schema('number') });
    expect(rows({ tools: [before] }, { tools: [after] })).toEqual([
      ['breaking', 'type-widened', 't', 'outputSchema'],
    ]);
  });

  it('treats a removed outputSchema as breaking and an added one as non-breaking', () => {
    const typed = tool('t', { outputSchema: { type: 'object' } });
    expect(rows({ tools: [typed] }, { tools: [tool('t')] })).toEqual([
      ['breaking', 'output-schema-removed', 't', 'outputSchema'],
    ]);
    expect(rows({ tools: [tool('t')] }, { tools: [typed] })).toEqual([
      ['non-breaking', 'output-schema-added', 't', 'outputSchema'],
    ]);
  });

  it('flags riskier behaviour hints for review and accepts safer ones', () => {
    const hints = (annotations: JsonObject): JsonObject => tool('t', { annotations });
    expect(rows({ tools: [hints({ readOnlyHint: true })] }, { tools: [hints({})] })).toEqual([
      ['unknown', 'hint-changed', 't', 'annotations'],
    ]);
    expect(
      rows(
        { tools: [hints({ destructiveHint: true })] },
        { tools: [hints({ destructiveHint: false })] },
      ),
    ).toEqual([['non-breaking', 'hint-changed', 't', 'annotations']]);
    // Explicitly stating a default is not a change.
    expect(
      rows(
        { tools: [hints({})] },
        { tools: [hints({ openWorldHint: true, idempotentHint: false })] },
      ),
    ).toEqual([]);
    expect(
      rows({ tools: [hints({ title: 'a' })] }, { tools: [hints({ title: 'b', custom: 1 })] }),
    ).toEqual([
      ['non-breaking', 'title-changed', 't', 'annotations'],
      ['unknown', 'field-changed', 't', 'annotations'],
    ]);
  });

  it('classifies task support by the invocation modes it removes', () => {
    const task = (taskSupport?: string): JsonObject =>
      tool('t', taskSupport === undefined ? {} : { execution: { taskSupport } });
    expect(rows({ tools: [task()] }, { tools: [task('optional')] })).toEqual([
      ['non-breaking', 'task-support-changed', 't', 'execution'],
    ]);
    expect(rows({ tools: [task('optional')] }, { tools: [task('required')] })).toEqual([
      ['breaking', 'task-support-changed', 't', 'execution'],
    ]);
    expect(rows({ tools: [task('required')] }, { tools: [task('forbidden')] })).toEqual([
      ['breaking', 'task-support-changed', 't', 'execution'],
    ]);
    expect(rows({ tools: [task('optional')] }, { tools: [task('sometimes')] })).toEqual([
      ['unknown', 'task-support-changed', 't', 'execution'],
    ]);
  });

  it('reports _meta and unknown fields as unknown', () => {
    expect(
      rows(
        { tools: [tool('t', { _meta: { a: 1 } })] },
        { tools: [tool('t', { _meta: { a: 2 }, extra: true })] },
      ),
    ).toEqual([
      ['unknown', 'metadata-changed', 't'],
      ['unknown', 'field-changed', 't'],
    ]);
  });

  it('reports duplicate names instead of guessing which one to compare', () => {
    const changes = diffSnapshots(
      snapshotOf({ tools: [tool('t'), tool('t', { description: 'x' })] }),
      snapshotOf({ tools: [tool('t')] }),
    ).changes;
    expect(changes[0]).toMatchObject({ severity: 'unknown', code: 'duplicate-name', name: 't' });
  });
});

describe('prompts', () => {
  const prompt = (args: JsonObject[], extra: JsonObject = {}): JsonObject => ({
    name: 'p',
    arguments: args,
    ...extra,
  });

  it('classifies argument changes', () => {
    expect(
      rows(
        {
          prompts: [prompt([{ name: 'id', required: true }, { name: 'style' }, { name: 'gone' }])],
        },
        {
          prompts: [
            prompt([
              { name: 'id' },
              { name: 'style', required: true },
              { name: 'lang' },
              { name: 'tone', required: true },
            ]),
          ],
        },
      ),
    ).toEqual([
      ['unknown', 'argument-removed', 'p', 'arguments.gone'],
      ['non-breaking', 'argument-optional', 'p', 'arguments.id'],
      ['non-breaking', 'argument-added', 'p', 'arguments.lang'],
      ['breaking', 'argument-required', 'p', 'arguments.style'],
      ['breaking', 'argument-added', 'p', 'arguments.tone'],
    ]);
  });

  it('reports argument descriptions and removed prompts', () => {
    expect(
      rows(
        { prompts: [prompt([{ name: 'a', description: 'x' }])] },
        { prompts: [prompt([{ name: 'a', description: 'y' }])] },
      ),
    ).toEqual([['non-breaking', 'description-changed', 'p', 'arguments.a']]);
    expect(rows({ prompts: [prompt([])] }, {})).toEqual([['breaking', 'prompt-removed', 'p']]);
    expect(rows({}, { prompts: [prompt([])] })).toEqual([['non-breaking', 'prompt-added', 'p']]);
  });
});

describe('resources and templates', () => {
  const resource = (extra: JsonObject = {}): JsonObject => ({
    uri: 'notes://index',
    name: 'index',
    ...extra,
  });

  it('classifies MIME type changes', () => {
    expect(
      rows(
        { resources: [resource({ mimeType: 'application/json' })] },
        { resources: [resource({ mimeType: 'text/plain' })] },
      ),
    ).toEqual([['breaking', 'mime-type-changed', 'notes://index']]);
    expect(
      rows({ resources: [resource()] }, { resources: [resource({ mimeType: 'text/plain' })] }),
    ).toEqual([['non-breaking', 'mime-type-changed', 'notes://index']]);
    expect(
      rows({ resources: [resource({ mimeType: 'text/plain' })] }, { resources: [resource()] }),
    ).toEqual([['unknown', 'mime-type-changed', 'notes://index']]);
  });

  it('reports informational fields as non-breaking', () => {
    expect(
      rows(
        { resources: [resource({ size: 1 })] },
        { resources: [resource({ name: 'idx', size: 2, annotations: { priority: 1 } })] },
      ),
    ).toEqual([
      ['non-breaking', 'name-changed', 'notes://index'],
      ['non-breaking', 'size-changed', 'notes://index'],
      ['non-breaking', 'annotation-changed', 'notes://index'],
    ]);
  });

  it('matches templates by URI template', () => {
    const template = (uriTemplate: string): JsonObject => ({ uriTemplate, name: 'note' });
    expect(
      rows(
        { resourceTemplates: [template('n://{id}')] },
        { resourceTemplates: [template('n://{slug}')] },
      ),
    ).toEqual([
      ['breaking', 'resource-template-removed', 'n://{id}'],
      ['non-breaking', 'resource-template-added', 'n://{slug}'],
    ]);
  });
});

describe('server', () => {
  it('reports identity, instructions and protocol changes', () => {
    expect(
      rows(
        { server: { name: 's', version: '1.0.0' }, instructions: 'a' },
        {
          server: { name: 's', version: '2.0.0' },
          instructions: 'b',
          protocol: { era: 'legacy', version: '2025-11-25' },
        },
      ),
    ).toEqual([
      ['non-breaking', 'server-info-changed', 's', 'server'],
      ['unknown', 'protocol-changed', 's', 'protocol'],
      ['non-breaking', 'instructions-changed', 's', 'instructions'],
    ]);
  });

  it('shows short values inline in the message', () => {
    const [change] = diffSnapshots(
      snapshotOf({ server: { name: 's', version: '1.0.0' } }),
      snapshotOf({ server: { name: 's', version: '1.1.0' } }),
    ).changes;
    expect(change?.message).toBe('version changed from 1.0.0 to 1.1.0');
  });

  it('classifies capability changes', () => {
    expect(
      rows(
        {
          capabilities: {
            tools: { listChanged: true },
            logging: {},
            resources: { subscribe: false },
          },
        },
        {
          capabilities: {
            tools: { listChanged: false },
            prompts: {},
            resources: { subscribe: true },
            experimental: { x: { v: 1 } },
          },
        },
      ),
    ).toEqual([
      ['non-breaking', 'capability-added', 'test', 'capabilities'],
      ['breaking', 'capability-removed', 'test', 'capabilities'],
      ['non-breaking', 'capability-added', 'test', 'capabilities'],
      ['non-breaking', 'capability-added', 'test', 'capabilities'],
      ['breaking', 'capability-removed', 'test', 'capabilities'],
    ]);
    expect(
      rows(
        { capabilities: { completions: { mode: 'a' } } },
        { capabilities: { completions: { mode: 'b' } } },
      ),
    ).toEqual([['unknown', 'capability-changed', 'test', 'capabilities']]);
  });
});

describe('results', () => {
  it('summarises and orders changes deterministically', () => {
    const result = diffSnapshots(
      snapshotOf({
        tools: [tool('b'), tool('a', { annotations: { readOnlyHint: true } })],
        prompts: [{ name: 'p' }],
      }),
      snapshotOf({ tools: [tool('a'), tool('c')] }),
    );
    expect(result.changes.map((change) => `${change.entity}:${change.name}`)).toEqual([
      'tool:a',
      'tool:b',
      'tool:c',
      'prompt:p',
    ]);
    expect(result.summary).toEqual({ breaking: 2, unknown: 1, nonBreaking: 1 });
  });

  it('applies fail-on thresholds', () => {
    expect([
      severityFails('unknown', 'breaking'),
      severityFails('unknown', 'unknown'),
      severityFails('non-breaking', 'any'),
    ]).toEqual([false, true, true]);
    const result = diffSnapshots(
      snapshotOf({ tools: [tool('a')] }),
      snapshotOf({ tools: [tool('b')] }),
    );
    expect(failingChanges(result).map((change) => change.code)).toEqual(['tool-removed']);
    expect(failingChanges(result, 'any')).toHaveLength(2);
  });
});
