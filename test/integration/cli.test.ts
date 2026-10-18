import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main, type CliIo } from '../../src/cli/main.ts';
import { serializeSnapshot } from '../../src/snapshot/format.ts';
import { VERSION } from '../../src/version.ts';
import { FIXTURE_SERVER, ROOT, example, nodeCommand } from '../helpers/processes.ts';
import { snapshotOf, tool } from '../helpers/snapshots.ts';

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(argv: readonly string[], overrides: Partial<CliIo> = {}): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: {},
    cwd: ROOT,
    stdoutIsTTY: false,
    ...overrides,
  });
  return { code, stdout, stderr };
}

let directory: string;
let oldFile: string;
let newFile: string;
const baseline = example('v1.snapshot.json');
const v1 = nodeCommand(example('v1.ts'));
const v2 = nodeCommand(example('v2.ts'));

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mcp-contract-cli-'));
  oldFile = join(directory, 'old.json');
  newFile = join(directory, 'new.json');
  await writeFile(
    oldFile,
    serializeSnapshot(snapshotOf({ tools: [tool('search'), tool('legacy')] })),
  );
  await writeFile(
    newFile,
    serializeSnapshot(snapshotOf({ tools: [tool('search', { description: 'Search.' })] })),
  );
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('help and usage', () => {
  it.each([
    [[]],
    [['--help']],
    [['help']],
    [['diff', '--help']],
    [['check', '-h']],
    [['snapshot', '--help']],
    [['test', '--help']],
  ])('prints help for %j', async (argv) => {
    const run = await cli(argv);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Usage:');
    expect(run.stdout).toContain('Exit codes:');
  });

  it('prints the version', async () => {
    expect(await cli(['--version'])).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: '' });
  });

  it.each([
    [['launch'], 'Unknown command "launch"'],
    [['diff', '--nope', 'a', 'b'], "Unknown option '--nope'"],
    [['diff', 'only-one.json'], 'expects <old.json> <new.json>, got only-one.json'],
    [['diff', 'a', 'b', '--format', 'xml'], '--format must be one of text, json, github'],
    [['diff', 'a', 'b', '--fail-on', 'never'], '--fail-on must be one of breaking, unknown, any'],
    [['diff', 'a', 'b', '--color', '--no-color'], 'either --color or --no-color'],
    [['snapshot'], 'Specify the server with --stdio'],
    [['snapshot', 'extra'], 'expects no positional arguments'],
    [['snapshot', '--stdio', 'x', '--url', 'http://localhost/mcp'], 'either --stdio or --url'],
    [['snapshot', '--url', 'http://localhost/mcp', '--cwd', '.'], 'only apply to --stdio'],
    [['snapshot', '--stdio', 'x', '--header', 'a=b'], '--header only applies to --url'],
    [
      ['snapshot', '--url', 'http://localhost/mcp', '--header', 'novalue'],
      '--header expects name=value',
    ],
    [
      ['snapshot', '--url', 'http://localhost/mcp', '--header', 'bad name=x'],
      'is not a valid HTTP header name',
    ],
    [
      ['snapshot', '--stdio', 'x', '--env', 'MCP_CONTRACT_UNSET_VARIABLE'],
      'is not set in the current environment',
    ],
    [['snapshot', '--stdio', 'x', '--timeout', '0'], '--timeout must be a positive integer'],
    [['snapshot', '--stdio', 'x', '--timeout', '-5'], "Option '--timeout' argument is ambiguous"],
    [
      ['snapshot', '--stdio', 'x', '--protocol', 'newest'],
      '--protocol must be auto, legacy or a revision',
    ],
    [
      ['snapshot', '--stdio', 'x', '--protocol', '2025-11-25'],
      'only revisions from 2026-07-28 on can be pinned; use --protocol legacy',
    ],
    [
      ['snapshot', '--stdio', 'x', '--probe-timeout', '0'],
      '--probe-timeout must be a positive integer',
    ],
    [['snapshot', '--stdio', 'x', '--server-stderr', 'loud'], '--server-stderr must be one of'],
    [['snapshot', '--stdio', '"unterminated'], 'Unterminated double quote'],
    [['snapshot', '--url', 'not a url'], 'Invalid server URL'],
    [['snapshot', '--url', 'ftp://example.com/mcp'], 'must use http or https'],
    [['test'], 'expects <scenarios.yaml>'],
  ])('rejects %j with exit code 2', async (argv, message) => {
    const run = await cli(argv);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
    expect(run.stdout).toBe('');
  });
});

describe('diff', () => {
  it('passes identical snapshots', async () => {
    const run = await cli(['diff', oldFile, oldFile, '--fail-on', 'any']);
    expect(run).toMatchObject({ code: 0, stdout: 'No changes.\n\nPASS (fail-on: any)\n' });
  });

  it('fails on breaking changes with exit code 1', async () => {
    const run = await cli(['diff', oldFile, newFile]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('BREAKING      tool removed');
  });

  it('respects --fail-on', async () => {
    expect((await cli(['diff', newFile, oldFile, '--fail-on', 'breaking'])).code).toBe(0);
    expect((await cli(['diff', newFile, oldFile, '--fail-on', 'any'])).code).toBe(1);
  });

  it('writes JSON', async () => {
    const run = await cli(['diff', oldFile, newFile, '--format', 'json']);
    expect(JSON.parse(run.stdout)).toMatchObject({
      passed: false,
      summary: { breaking: 1, unknown: 0, nonBreaking: 1 },
    });
  });

  it('colors text when forced', async () => {
    expect((await cli(['diff', oldFile, newFile, '--color'])).stdout).toContain('\u001B[');
    expect((await cli(['diff', oldFile, newFile], { env: { FORCE_COLOR: '1' } })).stdout).toContain(
      '\u001B[',
    );
    expect(
      (await cli(['diff', oldFile, newFile], { stdoutIsTTY: true, env: { NO_COLOR: '1' } })).stdout,
    ).not.toContain('\u001B[');
  });

  it('writes GitHub annotations and appends to the step summary', async () => {
    const summary = join(directory, 'summary.md');
    await writeFile(summary, '# Earlier step\n');
    const run = await cli(['diff', oldFile, newFile, '--format', 'github'], {
      env: { GITHUB_STEP_SUMMARY: summary },
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(
      /^::error file=.*new\.json,title=BREAKING tool legacy::tool removed/m,
    );
    expect(run.stdout).toContain('FAIL: 1 change at or above the fail-on threshold');
    const markdown = await readFile(summary, 'utf8');
    expect(markdown.startsWith('# Earlier step\n### mcp-contract: 2 changes')).toBe(true);
  });

  it('fences the text report off from workflow command processing', async () => {
    const name = 'evil\n::notice title=Injected::all good';
    const hostileOld = join(directory, 'hostile-old.json');
    const hostileNew = join(directory, 'hostile-new.json');
    await writeFile(hostileOld, serializeSnapshot(snapshotOf({ tools: [tool(name)] })));
    await writeFile(hostileNew, serializeSnapshot(snapshotOf()));
    const run = await cli(['diff', hostileOld, hostileNew, '--format', 'github']);
    const commands = run.stdout
      .split('\n')
      .filter((line) => line.trimStart().startsWith('::'))
      .map((line) => line.split(' ')[0]);
    const token = /^::stop-commands::(\w+)$/m.exec(run.stdout)?.[1];
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(commands).toEqual(['::error', `::stop-commands::${token ?? ''}`, `::${token ?? ''}::`]);
  });

  it('points annotations at paths relative to the repository root', async () => {
    const run = await cli(['diff', oldFile, newFile, '--format', 'github'], {
      env: { GITHUB_WORKSPACE: directory },
      cwd: join(directory, 'sub'),
    });
    expect(run.stdout).toMatch(/^::error file=new\.json,title=BREAKING tool legacy::/m);
    const outside = await cli(['diff', oldFile, newFile, '--format', 'github'], {
      env: { GITHUB_WORKSPACE: join(directory, 'elsewhere') },
    });
    expect(outside.stdout).toMatch(/^::error title=BREAKING tool legacy::/m);
  });

  it('reports a step summary that cannot be written as an output error', async () => {
    const run = await cli(['diff', oldFile, oldFile, '--format', 'github'], {
      env: { GITHUB_STEP_SUMMARY: directory },
    });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('cannot append the step summary (EISDIR)');
  });

  it('reports unreadable snapshots as input errors', async () => {
    const run = await cli(['diff', join(directory, 'missing.json'), newFile]);
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/missing\.json: file not found/);
  });
});

describe('snapshot and check against the example server', () => {
  it('writes a snapshot identical to the committed baseline', async () => {
    const output = join(directory, 'live.json');
    const run = await cli(['snapshot', '--stdio', v1, '-o', output]);
    expect(run.code).toBe(0);
    expect(run.stderr).toMatch(
      /^Wrote .*live\.json \(5 tools, 1 prompt, 1 resource, 1 resource template; protocol 2026-07-28\)\.\n$/,
    );
    expect(await readFile(output, 'utf8')).toBe(await readFile(baseline, 'utf8'));
  });

  it('reports an output file that cannot be written as exit code 2', async () => {
    const run = await cli(['snapshot', '--stdio', v1, '-o', join(directory, 'none', 'x.json')]);
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/x\.json: cannot write file \(its directory does not exist\)/);
  });

  it('negotiates the way the baseline was negotiated', async () => {
    const legacyBaseline = join(directory, 'legacy.json');
    expect(
      (await cli(['snapshot', '--stdio', v1, '--protocol', 'legacy', '-o', legacyBaseline])).code,
    ).toBe(0);
    const same = await cli([
      'check',
      '--stdio',
      v1,
      '--snapshot',
      legacyBaseline,
      '--fail-on',
      'any',
    ]);
    expect(same).toMatchObject({ code: 0, stderr: '' });
    const other = await cli([
      'check',
      '--stdio',
      v1,
      '--snapshot',
      legacyBaseline,
      '--protocol',
      'auto',
    ]);
    expect(other.code).toBe(0);
    expect(other.stderr).toContain(
      'legacy.json was negotiated with --protocol legacy and this run uses --protocol auto',
    );
    expect(other.stdout).toContain('NON-BREAKING  protocol: the snapshots were negotiated');
  });

  it('explains a protocol probe that used up its timeout', async () => {
    const silent = nodeCommand(join(ROOT, 'test', 'fixtures', 'silent-legacy-server.ts'));
    const run = await cli(['snapshot', '--stdio', silent, '--probe-timeout', '300', '-o', '-']);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      protocol: { era: 'legacy', negotiation: 'auto' },
    });
    expect(run.stderr).toContain(
      'was treated as a 2025-era server after the server/discover probe ran for its whole timeout (300 ms)',
    );
  });

  it('defuses workflow commands in the server stderr it shows', async () => {
    const run = await cli([
      'snapshot',
      '--stdio',
      nodeCommand(FIXTURE_SERVER, ['commands']),
      '--protocol',
      'legacy',
      '-o',
      '-',
    ]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain(': :error title=Spoofed::all checks passed');
    expect(run.stderr.split('\n').some((line) => line.trimStart().startsWith('::'))).toBe(false);
  });

  it('writes to stdout with -o -', async () => {
    const run = await cli(['snapshot', '--stdio', v1, '-o', '-', '--protocol', 'legacy']);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      protocol: { era: 'legacy' },
      server: { name: 'notes' },
    });
  });

  it('passes check for an unchanged server', async () => {
    const run = await cli(['check', '--stdio', v1, '--snapshot', baseline, '--fail-on', 'any']);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('No changes.\n\nPASS (fail-on: any)\n');
  });

  it('fails check for a breaking server and explains how to accept the change', async () => {
    const run = await cli(['check', '--stdio', v2, '--snapshot', baseline]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('21 changes: 8 breaking, 3 unknown, 10 non-breaking.');
    expect(run.stderr).toContain('update the baseline');
  });

  it('reads the baseline before starting the server', async () => {
    const run = await cli([
      'check',
      '--stdio',
      nodeCommand(FIXTURE_SERVER, ['crash']),
      '--snapshot',
      join(directory, 'none.json'),
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).not.toContain('MISSING_API_KEY');
  });

  it('reports server failures with exit code 3 and the server stderr', async () => {
    const run = await cli([
      'snapshot',
      '--stdio',
      nodeCommand(FIXTURE_SERVER, ['crash']),
      '--protocol',
      'legacy',
      '-o',
      '-',
    ]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain('Could not connect to stdio:');
    expect(run.stderr).toContain(
      'server stderr (last 1 lines):\n  fatal: MISSING_API_KEY is not set',
    );
  });

  it('passes environment variables to the server', async () => {
    const run = await cli(
      [
        'snapshot',
        '--stdio',
        nodeCommand(FIXTURE_SERVER),
        '--env',
        'FROM_PARENT',
        '--env',
        'A=1',
        '-o',
        '-',
      ],
      {
        env: { FROM_PARENT: 'yes' },
      },
    );
    expect(run.code).toBe(0);
  });

  it('exits with 130 when interrupted', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = await cli(['snapshot', '--stdio', v1, '-o', '-'], { signal: controller.signal });
    expect(run.code).toBe(130);
  });
});

describe('test', () => {
  const scenarios = example('scenarios.yaml');

  it('passes against v1 and fails against v2', async () => {
    const passing = await cli(['test', scenarios, '--stdio', v1]);
    expect(passing.code).toBe(0);
    expect(passing.stdout).toContain('5 scenarios: 5 passed, 0 failed');
    const failing = await cli(['test', scenarios, '--stdio', v2, '--format', 'json']);
    expect(failing.code).toBe(1);
    expect(JSON.parse(failing.stdout)).toMatchObject({
      passed: false,
      summary: { passed: 3, failed: 2 },
    });
  });

  it('writes annotations and a step summary', async () => {
    const summary = join(directory, 'test-summary.md');
    const run = await cli(['test', scenarios, '--stdio', v2, '--format', 'github'], {
      env: { GITHUB_STEP_SUMMARY: summary },
    });
    expect(run.stdout).toMatch(
      /^::error file=.*scenarios\.yaml,title=Scenario failed%3A create_note returns the new id::/m,
    );
    expect(await readFile(summary, 'utf8')).toContain('### mcp-contract test: 3 passed, 2 failed');
  });

  it('needs a server from the flags or the file', async () => {
    const file = join(directory, 'serverless.yaml');
    await writeFile(file, 'scenarios: [{ name: a, tool: t }]');
    const run = await cli(['test', file]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('No server: pass --stdio or --url');
  });
});

describe('unexpected errors', () => {
  it('are reported, not thrown', async () => {
    const run = await cli(['--version'], {
      stdout: () => {
        throw new Error('stdout closed');
      },
    });
    expect(run.code).toBe(4);
    expect(run.stderr).toBe(
      'mcp-contract: internal error: stdout closed\nThis is a bug in mcp-contract; please report it at https://github.com/aozmekik/mcp-contract/issues (set MCP_CONTRACT_DEBUG=1 to include the stack trace).\n',
    );
    const debug = await cli(['--version'], {
      env: { MCP_CONTRACT_DEBUG: '1' },
      stdout: () => {
        throw new Error('stdout closed');
      },
    });
    expect(debug.stderr).toContain('at ');
  });
});
