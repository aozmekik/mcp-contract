import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidFileError } from '../../src/core/errors.ts';
import { loadScenarios, parseScenarios } from '../../src/scenarios/file.ts';

describe('parseScenarios', () => {
  it('parses scenarios with defaults', () => {
    const file = parseScenarios(`
scenarios:
  - name: plain
    tool: ping
  - name: detailed
    tool: search
    arguments: { q: mcp }
    timeoutMs: 500
    expect:
      isError: true
      result: { isError: true }
      select:
        $.content[0].text: { $regex: '^x' }
`);
    expect(file.server).toBeUndefined();
    expect(file.scenarios).toEqual([
      { name: 'plain', tool: 'ping', arguments: {}, expect: { isError: false, select: [] } },
      {
        name: 'detailed',
        tool: 'search',
        arguments: { q: 'mcp' },
        timeoutMs: 500,
        expect: {
          isError: true,
          result: { isError: true },
          select: [
            {
              selector: '$.content[0].text',
              segments: [
                { kind: 'member', name: 'content' },
                { kind: 'index', index: 0 },
                { kind: 'member', name: 'text' },
              ],
              expected: { $regex: '^x' },
            },
          ],
        },
      },
    ]);
  });

  it('resolves a stdio server relative to the file', () => {
    const file = parseScenarios(
      'server: { command: node, args: [server.ts], cwd: sub, env: { A: "1" } }\nscenarios: [{ name: a, tool: t }]',
      '/work/tests/scenarios.yaml',
    );
    expect(file.server).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['server.ts'],
      cwd: resolve('/work/tests/sub'),
      env: { A: '1' },
    });
    expect(
      parseScenarios('server: { command: node }\nscenarios: [{ name: a, tool: t }]', '/w/s.yaml')
        .server,
    ).toMatchObject({
      cwd: resolve('/w'),
      args: [],
    });
  });

  it('accepts an HTTP server', () => {
    const file = parseScenarios(
      'server: { url: "http://localhost:3000/mcp", headers: { X: y } }\nscenarios: [{ name: a, tool: t }]',
    );
    expect(file.server).toEqual({
      type: 'http',
      url: 'http://localhost:3000/mcp',
      headers: { X: 'y' },
    });
  });

  it.each([
    ['scenarios: [', 'not valid YAML'],
    ['scenarios: []', 'not a valid scenario file'],
    ['scenarios: [{ name: a }]', 'tool'],
    ['scenarios: [{ name: a, tool: t, typo: 1 }]', 'typo'],
    [
      'server: { command: node, url: x }\nscenarios: [{ name: a, tool: t }]',
      'not a valid scenario file',
    ],
    ['scenarios: [{ name: a, tool: t }, { name: a, tool: u }]', 'duplicate scenario name "a"'],
    [
      'scenarios: [{ name: a, tool: t, expect: { error: {}, isError: true } }]',
      'expect.error cannot be combined',
    ],
    ['scenarios: [{ name: a, tool: t, expect: { select: { "$..x": 1 } } }]', 'descendant segments'],
    [
      'scenarios: [{ name: a, tool: t, expect: { select: { "$.x": { $regex: "(" } } } }]',
      'invalid regular expression',
    ],
    [
      'scenarios: [{ name: a, tool: t, expect: { result: { $bogus: 1 } } }]',
      'unknown operator $bogus',
    ],
    [
      'scenarios: [{ name: a, tool: t, expect: { error: { $bogus: 1 } } }]',
      'unknown operator $bogus',
    ],
    ['scenarios: [{ name: a, tool: t, arguments: { n: .nan } }]', 'non-finite number'],
  ])('rejects %j', (text, message) => {
    expect(() => parseScenarios(text, 'bad.yaml')).toThrow(InvalidFileError);
    expect(() => parseScenarios(text, 'bad.yaml')).toThrow(message);
  });

  it('reports every problem at once', () => {
    const text = `scenarios:
  - { name: a, tool: t, expect: { select: { "$..x": 1 } } }
  - { name: b, tool: t, expect: { result: { $bogus: 1 } } }`;
    expect(() => parseScenarios(text)).toThrow(/descendant[\s\S]*\$bogus/);
  });
});

describe('loadScenarios', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mcp-contract-scenarios-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('reads a file and resolves the server against its directory', async () => {
    const path = join(directory, 'scenarios.yaml');
    await writeFile(
      path,
      'server: { command: node, args: [s.ts] }\nscenarios: [{ name: a, tool: t }]',
    );
    const file = await loadScenarios(path);
    expect(file.server).toMatchObject({ cwd: directory });
  });

  it('distinguishes missing from unreadable files', async () => {
    await expect(loadScenarios(join(directory, 'none.yaml'))).rejects.toThrow('file not found');
    await expect(loadScenarios(directory)).rejects.toThrow('cannot read file (EISDIR)');
  });
});
