import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { quoteWord } from '../../src/connect/command-line.ts';
import type { StdioTarget } from '../../src/connect/connect.ts';

/** Repository root. */
export const ROOT: string = fileURLToPath(new URL('../..', import.meta.url));

/** Path of an example server file. */
export function example(file: string): string {
  return join(ROOT, 'examples', 'notes-server', file);
}

/** Path of the lifecycle fixture server. */
export const FIXTURE_SERVER: string = join(ROOT, 'test', 'fixtures', 'fixture-server.ts');

/** A stdio target running `file` with the current Node binary. */
export function nodeTarget(
  file: string,
  args: readonly string[] = [],
  extra: Partial<StdioTarget> = {},
): StdioTarget {
  return { type: 'stdio', command: process.execPath, args: [file, ...args], cwd: ROOT, ...extra };
}

/** The same target as a `--stdio` command line. */
export function nodeCommand(file: string, args: readonly string[] = []): string {
  return [process.execPath, file, ...args].map(quoteWord).join(' ');
}

/** True while a process with `pid` exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Polls until every pid has exited. Uses a generous deadline instead of a fixed
 * sleep, so the assertion does not depend on machine speed.
 */
export async function waitForExit(pids: readonly number[], deadlineMs = 10_000): Promise<number[]> {
  const deadline = Date.now() + deadlineMs;
  let alive = pids.filter(isAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await sleep(25);
    alive = alive.filter(isAlive);
  }
  return alive;
}

/** A temporary file that fixture servers append their pids to. */
export interface PidLog {
  readonly path: string;
  pids(): Promise<number[]>;
  dispose(): Promise<void>;
}

/** Creates a {@link PidLog} in a fresh temporary directory. */
export async function createPidLog(): Promise<PidLog> {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-contract-pids-'));
  const path = join(directory, 'pids.txt');
  return {
    path,
    async pids() {
      try {
        return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(Number);
      } catch {
        return [];
      }
    },
    async dispose() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** A running example server in HTTP mode. */
export interface HttpServer {
  readonly url: string;
  readonly child: ChildProcess;
  stop(): Promise<void>;
}

const running = new Set<ChildProcess>();

/** Starts `file --http` and resolves with its URL once it listens. */
export async function startHttp(file: string): Promise<HttpServer> {
  const child = spawn(process.execPath, [file, '--http'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  running.add(child);
  const stop = async (): Promise<void> => {
    running.delete(child);
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  };
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const match = /^listening on (\S+)$/.exec(line);
      if (match?.[1] !== undefined) {
        return { url: match[1], child, stop };
      }
    }
  } catch (error) {
    await stop();
    throw error;
  }
  await stop();
  throw new Error(`${file} exited before it started listening`);
}

/** Kills HTTP servers a failed test left behind (call from afterAll). */
export function killStrayServers(): void {
  for (const child of running) {
    child.kill('SIGKILL');
  }
  running.clear();
}
