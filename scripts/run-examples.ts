/**
 * Runs the documented example workflow with the built CLI (dist/cli.js) and
 * checks every exit code and the exact classification summary. CI runs it
 * after `npm run build`; locally: `npm run build && npm run examples`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = 'dist/cli.js';
const snapshot = 'examples/notes-server/v1.snapshot.json';
const scenarios = 'examples/notes-server/scenarios.yaml';

interface Result {
  readonly code: number | null;
  readonly stdout: string;
}

async function run(args: readonly string[]): Promise<Result> {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  const [code] = (await once(child, 'exit')) as [number | null];
  return { code, stdout };
}

async function startHttpServer(file: string): Promise<{ url: string; child: ChildProcess }> {
  const child = spawn(process.execPath, [file, '--http'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout });
  for await (const line of lines) {
    const match = /^listening on (\S+)$/.exec(line);
    if (match?.[1] !== undefined) {
      return { url: match[1], child };
    }
  }
  throw new Error(`${file} exited before printing its URL`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
}

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` (${detail})`}\n`);
  if (!ok) {
    failures += 1;
  }
}

const v1 = 'node examples/notes-server/v1.ts';
const v2 = 'node examples/notes-server/v2.ts';

const same = await run(['check', '--stdio', v1, '--snapshot', snapshot]);
check('v1 matches its committed snapshot (stdio)', same.code === 0, `exit ${String(same.code)}`);

const changed = await run(['check', '--stdio', v2, '--snapshot', snapshot, '--format', 'json']);
const summary = JSON.stringify((JSON.parse(changed.stdout) as { summary: unknown }).summary);
check(
  'v2 is classified as 8 breaking, 3 unknown, 10 non-breaking',
  changed.code === 1 && summary === '{"breaking":8,"unknown":3,"nonBreaking":10}',
  `exit ${String(changed.code)}, ${summary}`,
);

const identical = await run(['diff', snapshot, snapshot, '--fail-on', 'any']);
check(
  'a snapshot diffed with itself passes even with --fail-on any',
  identical.code === 0,
  `exit ${String(identical.code)}`,
);

const passing = await run(['test', scenarios]);
check('scenarios pass against v1', passing.code === 0, `exit ${String(passing.code)}`);

const failing = await run(['test', scenarios, '--stdio', v2]);
check('scenarios catch the v2 regressions', failing.code === 1, `exit ${String(failing.code)}`);

const server = await startHttpServer('examples/notes-server/v1.ts');
try {
  const http = await run(['check', '--url', server.url, '--snapshot', snapshot]);
  check(
    'v1 matches its committed snapshot (Streamable HTTP)',
    http.code === 0,
    `exit ${String(http.code)}`,
  );
} finally {
  await stop(server.child);
}

if (failures > 0) {
  process.stderr.write(`${failures} example check(s) failed\n`);
  process.exitCode = 1;
}
