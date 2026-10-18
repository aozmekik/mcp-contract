/**
 * The bin entry point, run from source with Node's type stripping: process
 * exit codes, stdout, and SIGINT handling with child-process cleanup.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VERSION } from '../../src/version.ts';
import {
  FIXTURE_SERVER,
  ROOT,
  createPidLog,
  nodeCommand,
  waitForExit,
  type PidLog,
} from '../helpers/processes.ts';

const BIN = join(ROOT, 'src', 'cli.ts');

function start(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exit = once(child, 'exit').then(([code]) => ({
    code: code as number | null,
    stdout,
    stderr,
  }));
  return { child, exit };
}

let log: PidLog;

beforeEach(async () => {
  log = await createPidLog();
});

afterEach(async () => {
  await log.dispose();
});

describe('mcp-contract bin', () => {
  it('prints the version and exits 0', async () => {
    const { exit } = start(['--version']);
    expect(await exit).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: '' });
  });

  it('exits 2 on usage errors', async () => {
    const { exit } = start(['frobnicate']);
    const result = await exit;
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Unknown command "frobnicate"');
  });

  it('stops on SIGINT with exit code 130 and leaves no server running', async () => {
    const { child, exit } = start(
      [
        'snapshot',
        '--stdio',
        nodeCommand(FIXTURE_SERVER, ['hang']),
        '--env',
        'MCP_CONTRACT_PID_FILE',
        '-o',
        '-',
      ],
      {
        MCP_CONTRACT_PID_FILE: log.path,
      },
    );
    // Interrupt once the server process exists, however long that takes.
    while ((await log.pids()).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    child.kill('SIGINT');
    const result = await exit;
    expect(result.code).toBe(130);
    expect(result.stdout).toBe('');
    expect(await waitForExit(await log.pids())).toEqual([]);
  });

  it('stops a scenario run on SIGINT with exit code 130 and reports no failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-contract-bin-'));
    try {
      const calls = join(directory, 'calls.txt');
      const scenarios = join(directory, 'slow.yaml');
      await writeFile(
        scenarios,
        ['one', 'two', 'three']
          .map((name) => `  - { name: ${name}, tool: sleep, arguments: { ms: 30000 } }`)
          .join('\n')
          .replace(/^/, 'scenarios:\n'),
      );
      const { child, exit } = start(
        [
          'test',
          scenarios,
          '--stdio',
          nodeCommand(FIXTURE_SERVER),
          '--protocol',
          'legacy',
          '--env',
          'MCP_CONTRACT_PID_FILE',
          '--env',
          'MCP_CONTRACT_CALL_FILE',
        ],
        { MCP_CONTRACT_PID_FILE: log.path, MCP_CONTRACT_CALL_FILE: calls },
      );
      // Interrupt while the first tool call is running, however long it takes to start.
      const called = async (): Promise<boolean> =>
        (await readFile(calls, 'utf8').catch(() => '')).includes('sleep');
      while (!(await called())) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      child.kill('SIGINT');
      const result = await exit;
      expect(result.code).toBe(130);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('mcp-contract: interrupted\n');
      expect(await waitForExit(await log.pids())).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
