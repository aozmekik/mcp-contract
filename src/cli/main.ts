import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { splitCommandLine } from '../connect/command-line.ts';
import {
  DEFAULT_TIMEOUT_MS,
  connectServer,
  type ConnectOptions,
  type ProtocolMode,
  type ServerTarget,
  type StdioTarget,
} from '../connect/connect.ts';
import {
  ExitCode,
  McpContractError,
  ServerError,
  UsageError,
  describeError,
} from '../core/errors.ts';
import { DEFAULT_FAIL_ON, failingChanges, type DiffResult, type FailOn } from '../diff/model.ts';
import { diffSnapshots } from '../diff/snapshot-diff.ts';
import {
  formatDiffAnnotations,
  formatDiffJson,
  formatDiffMarkdown,
  formatDiffText,
} from '../report/diff-report.ts';
import { shouldColor } from '../report/style.ts';
import {
  formatTestAnnotations,
  formatTestJson,
  formatTestMarkdown,
  formatTestText,
} from '../report/test-report.ts';
import { loadScenarios } from '../scenarios/file.ts';
import { runScenarios } from '../scenarios/run.ts';
import { snapshotServer } from '../snapshot/capture.ts';
import { DEFAULT_SNAPSHOT_FILE, readSnapshot, writeSnapshot } from '../snapshot/files.ts';
import { serializeSnapshot } from '../snapshot/format.ts';
import type { Snapshot } from '../snapshot/model.ts';
import { VERSION } from '../version.ts';

/** The process facilities the CLI uses, injected so it can run in-process in tests. */
export interface CliIo {
  /** Writes to standard output. */
  readonly stdout: (text: string) => void;
  /** Writes to standard error. */
  readonly stderr: (text: string) => void;
  /** Environment variables. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Directory relative paths are resolved against. */
  readonly cwd: string;
  /** Whether standard output is a terminal (enables color by default). */
  readonly stdoutIsTTY: boolean;
  /** Aborted on SIGINT/SIGTERM; in-flight work stops and child processes are cleaned up. */
  readonly signal?: AbortSignal | undefined;
}

/** Exit code used when the run was interrupted by a signal (128 + SIGINT). */
export const INTERRUPTED_EXIT_CODE = 130;

const HELP = `mcp-contract ${VERSION}: contract testing for Model Context Protocol servers

Usage:
  mcp-contract snapshot (--stdio <command> | --url <url>) [-o <file>]
  mcp-contract diff <old.json> <new.json>
  mcp-contract check (--stdio <command> | --url <url>) [--snapshot <file>]
  mcp-contract test <scenarios.yaml> [--stdio <command> | --url <url>]

Commands:
  snapshot   Connect to a server and write a normalized snapshot of its contract
  diff       Classify the changes between two snapshots
  check      Compare a live server against a committed snapshot
  test       Run tool-call scenarios against a server and check the results

Server options (snapshot, check, test):
  --stdio <command>         Spawn the server and speak MCP over stdio; the command is
                            split like a shell would, but without expansion
  --url <url>               Connect over Streamable HTTP
  --header <name=value>     HTTP header for --url (repeatable)
  --cwd <dir>               Working directory for --stdio
  --env <name[=value]>      Environment variable for --stdio; without a value it is
                            copied from the current environment (repeatable)
  --protocol <mode>         auto (default), legacy, or a revision to require, e.g. 2026-07-28
  --timeout <ms>            Timeout per request (default ${DEFAULT_TIMEOUT_MS})
  --server-stderr <mode>    pipe (default: shown on failure), inherit, or ignore

Output options (diff, check, test):
  --format <format>         text (default), json, or github (annotations and step summary)
  --fail-on <level>         breaking, unknown (default), or any  (diff, check)
  --color, --no-color       Force or disable colors (default: on for terminals)

Other options:
  -o, --output <file>       snapshot: output file, "-" for stdout (default ${DEFAULT_SNAPSHOT_FILE})
  --snapshot <file>         check: baseline snapshot (default ${DEFAULT_SNAPSHOT_FILE})
  -h, --help                Show this help
  -v, --version             Show the version

Exit codes:
  0  passed    1  contract failure    2  usage or input error    3  server error
`;

const SERVER_OPTIONS = {
  stdio: { type: 'string' },
  url: { type: 'string' },
  header: { type: 'string', multiple: true },
  cwd: { type: 'string' },
  env: { type: 'string', multiple: true },
  protocol: { type: 'string' },
  timeout: { type: 'string' },
  'server-stderr': { type: 'string' },
} as const;

const OUTPUT_OPTIONS = {
  format: { type: 'string' },
  color: { type: 'boolean' },
  'no-color': { type: 'boolean' },
} as const;

const COMMON_OPTIONS = { help: { type: 'boolean', short: 'h' } } as const;

type Format = 'text' | 'json' | 'github';

interface ServerFlags {
  readonly stdio?: string | undefined;
  readonly url?: string | undefined;
  readonly header?: string[] | undefined;
  readonly cwd?: string | undefined;
  readonly env?: string[] | undefined;
  readonly protocol?: string | undefined;
  readonly timeout?: string | undefined;
  readonly 'server-stderr'?: string | undefined;
}

interface OutputFlags {
  readonly format?: string | undefined;
  readonly color?: boolean | undefined;
  readonly 'no-color'?: boolean | undefined;
}

function parse<const T extends NonNullable<Parameters<typeof parseArgs>[0]>['options']>(
  args: readonly string[],
  options: T,
): ReturnType<typeof parseArgs<{ options: T; strict: true; allowPositionals: true }>> {
  try {
    return parseArgs({ args: [...args], options, strict: true, allowPositionals: true });
  } catch (error) {
    throw new UsageError(describeError(error), { cause: error });
  }
}

function expectPositionals(
  positionals: readonly string[],
  expected: readonly string[],
  command: string,
): void {
  if (positionals.length !== expected.length) {
    const usage = expected.map((name) => `<${name}>`).join(' ');
    throw new UsageError(
      `"mcp-contract ${command}" expects ${usage === '' ? 'no positional arguments' : usage}, got ${positionals.length === 0 ? 'none' : positionals.join(' ')}`,
    );
  }
}

function parseKeyValue(entry: string, flag: string): [string, string] {
  const index = entry.indexOf('=');
  if (index <= 0) {
    throw new UsageError(`${flag} expects name=value, got "${entry}"`);
  }
  return [entry.slice(0, index), entry.slice(index + 1)];
}

function parseHeaders(entries: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of entries) {
    const [name, value] = parseKeyValue(entry, '--header');
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new UsageError(`--header name "${name}" is not a valid HTTP header name`);
    }
    headers[name] = value;
  }
  return headers;
}

function parseEnv(entries: readonly string[], env: CliIo['env']): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.includes('=')) {
      const [name, value] = parseKeyValue(entry, '--env');
      result[name] = value;
    } else {
      const value = env[entry];
      if (value === undefined) {
        throw new UsageError(`--env ${entry}: variable is not set in the current environment`);
      }
      result[entry] = value;
    }
  }
  return result;
}

function parseProtocol(value: string | undefined): ProtocolMode {
  if (value === undefined || value === 'auto' || value === 'legacy') {
    return value ?? 'auto';
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { pin: value };
  }
  throw new UsageError(
    `--protocol must be auto, legacy or a revision like 2026-07-28, got "${value}"`,
  );
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new UsageError(
      `--timeout must be a positive integer number of milliseconds, got "${value}"`,
    );
  }
  return timeout;
}

function parseChoice<T extends string>(
  value: string | undefined,
  flag: string,
  choices: readonly T[],
  fallback: T,
): T {
  if (value === undefined) {
    return fallback;
  }
  if (!(choices as readonly string[]).includes(value)) {
    throw new UsageError(`${flag} must be one of ${choices.join(', ')}, got "${value}"`);
  }
  return value as T;
}

function targetFromFlags(flags: ServerFlags, io: CliIo): ServerTarget | undefined {
  if (flags.stdio !== undefined && flags.url !== undefined) {
    throw new UsageError('Use either --stdio or --url, not both.');
  }
  if (
    flags.stdio === undefined &&
    (flags.cwd !== undefined || flags.env !== undefined || flags['server-stderr'] !== undefined)
  ) {
    throw new UsageError('--cwd, --env and --server-stderr only apply to --stdio.');
  }
  if (flags.url === undefined && flags.header !== undefined) {
    throw new UsageError('--header only applies to --url.');
  }
  if (flags.stdio !== undefined) {
    const [command, ...args] = splitCommandLine(flags.stdio);
    const target: StdioTarget = {
      type: 'stdio',
      command,
      args,
      cwd: resolve(io.cwd, flags.cwd ?? '.'),
      env: parseEnv(flags.env ?? [], io.env),
      stderr: parseChoice(
        flags['server-stderr'],
        '--server-stderr',
        ['pipe', 'inherit', 'ignore'] as const,
        'pipe',
      ),
    };
    return target;
  }
  if (flags.url !== undefined) {
    return { type: 'http', url: flags.url, headers: parseHeaders(flags.header ?? []) };
  }
  return undefined;
}

function requireTarget(flags: ServerFlags, io: CliIo): ServerTarget {
  const target = targetFromFlags(flags, io);
  if (target === undefined) {
    throw new UsageError('Specify the server with --stdio "<command>" or --url <url>.');
  }
  return target;
}

function connectOptions(flags: ServerFlags, io: CliIo): ConnectOptions {
  return {
    protocol: parseProtocol(flags.protocol),
    timeoutMs: parseTimeout(flags.timeout),
    ...(io.signal === undefined ? {} : { signal: io.signal }),
  };
}

interface Output {
  readonly format: Format;
  readonly color: boolean;
}

function outputFrom(flags: OutputFlags, io: CliIo): Output {
  if (flags.color === true && flags['no-color'] === true) {
    throw new UsageError('Use either --color or --no-color, not both.');
  }
  const flag = flags.color === true ? true : flags['no-color'] === true ? false : undefined;
  return {
    format: parseChoice(flags.format, '--format', ['text', 'json', 'github'] as const, 'text'),
    color: shouldColor({ flag, env: io.env, isTTY: io.stdoutIsTTY }),
  };
}

async function appendStepSummary(io: CliIo, markdown: string): Promise<void> {
  const path = io.env.GITHUB_STEP_SUMMARY;
  if (path !== undefined && path !== '') {
    await appendFile(path, `${markdown}\n`, 'utf8');
  }
}

async function reportDiff(
  result: DiffResult,
  output: Output,
  failOn: FailOn,
  file: string,
  io: CliIo,
): Promise<number> {
  switch (output.format) {
    case 'text':
      io.stdout(formatDiffText(result, { failOn, color: output.color }));
      break;
    case 'json':
      io.stdout(formatDiffJson(result, { failOn }));
      break;
    case 'github':
      io.stdout(formatDiffAnnotations(result, { file }));
      io.stdout(formatDiffText(result, { failOn }));
      await appendStepSummary(io, formatDiffMarkdown(result, { failOn }));
      break;
  }
  return failingChanges(result, failOn).length > 0 ? ExitCode.ContractFailure : ExitCode.Ok;
}

function describeSnapshot(snapshot: Snapshot): string {
  const count = (n: number, word: string): string => `${n} ${n === 1 ? word : `${word}s`}`;
  return [
    count(snapshot.tools.length, 'tool'),
    count(snapshot.prompts.length, 'prompt'),
    count(snapshot.resources.length, 'resource'),
    count(snapshot.resourceTemplates.length, 'resource template'),
  ].join(', ');
}

async function snapshotCommand(args: readonly string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, {
    ...SERVER_OPTIONS,
    ...COMMON_OPTIONS,
    output: { type: 'string', short: 'o' },
  });
  if (values.help === true) {
    io.stdout(HELP);
    return ExitCode.Ok;
  }
  expectPositionals(positionals, [], 'snapshot');
  const target = requireTarget(values, io);
  const snapshot = await snapshotServer(target, connectOptions(values, io));
  const output = values.output ?? DEFAULT_SNAPSHOT_FILE;
  if (output === '-') {
    io.stdout(serializeSnapshot(snapshot));
  } else {
    await writeSnapshot(resolve(io.cwd, output), snapshot);
    io.stderr(
      `Wrote ${output} (${describeSnapshot(snapshot)}; protocol ${snapshot.protocol.version}).\n`,
    );
  }
  return ExitCode.Ok;
}

async function diffCommand(args: readonly string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, {
    ...OUTPUT_OPTIONS,
    ...COMMON_OPTIONS,
    'fail-on': { type: 'string' },
  });
  if (values.help === true) {
    io.stdout(HELP);
    return ExitCode.Ok;
  }
  expectPositionals(positionals, ['old.json', 'new.json'], 'diff');
  const output = outputFrom(values, io);
  const failOn = parseChoice(
    values['fail-on'],
    '--fail-on',
    ['breaking', 'unknown', 'any'] as const,
    DEFAULT_FAIL_ON,
  );
  const [oldPath, newPath] = positionals as [string, string];
  const [before, after] = await Promise.all([
    readSnapshot(resolve(io.cwd, oldPath)),
    readSnapshot(resolve(io.cwd, newPath)),
  ]);
  return reportDiff(diffSnapshots(before, after), output, failOn, newPath, io);
}

async function checkCommand(args: readonly string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, {
    ...SERVER_OPTIONS,
    ...OUTPUT_OPTIONS,
    ...COMMON_OPTIONS,
    'fail-on': { type: 'string' },
    snapshot: { type: 'string' },
  });
  if (values.help === true) {
    io.stdout(HELP);
    return ExitCode.Ok;
  }
  expectPositionals(positionals, [], 'check');
  const output = outputFrom(values, io);
  const failOn = parseChoice(
    values['fail-on'],
    '--fail-on',
    ['breaking', 'unknown', 'any'] as const,
    DEFAULT_FAIL_ON,
  );
  const target = requireTarget(values, io);
  const options = connectOptions(values, io);
  const file = values.snapshot ?? DEFAULT_SNAPSHOT_FILE;
  // Read the baseline first: a missing file should not cost a server start.
  const baseline = await readSnapshot(resolve(io.cwd, file));
  const current = await snapshotServer(target, options);
  const code = await reportDiff(diffSnapshots(baseline, current), output, failOn, file, io);
  if (code !== ExitCode.Ok && output.format === 'text') {
    io.stderr(
      `If these changes are intended, update the baseline with "mcp-contract snapshot ... -o ${file}" and commit it.\n`,
    );
  }
  return code;
}

async function testCommand(args: readonly string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, {
    ...SERVER_OPTIONS,
    ...OUTPUT_OPTIONS,
    ...COMMON_OPTIONS,
  });
  if (values.help === true) {
    io.stdout(HELP);
    return ExitCode.Ok;
  }
  expectPositionals(positionals, ['scenarios.yaml'], 'test');
  const output = outputFrom(values, io);
  const [file] = positionals as [string];
  const scenarioFile = await loadScenarios(resolve(io.cwd, file));
  const target = targetFromFlags(values, io) ?? scenarioFile.server;
  if (target === undefined) {
    throw new UsageError(`No server: pass --stdio or --url, or add a "server" section to ${file}.`);
  }
  const connection = await connectServer(target, connectOptions(values, io));
  let results;
  try {
    results = await runScenarios(connection, scenarioFile.scenarios);
  } finally {
    await connection.close();
  }
  switch (output.format) {
    case 'text':
      io.stdout(formatTestText(results, { color: output.color }));
      break;
    case 'json':
      io.stdout(formatTestJson(results));
      break;
    case 'github':
      io.stdout(formatTestAnnotations(results, { file }));
      io.stdout(formatTestText(results));
      await appendStepSummary(io, formatTestMarkdown(results));
      break;
  }
  return results.every((result) => result.passed) ? ExitCode.Ok : ExitCode.ContractFailure;
}

function reportError(error: unknown, io: CliIo): number {
  const interrupted = io.signal?.aborted === true;
  if (error instanceof McpContractError) {
    io.stderr(`mcp-contract: ${error.message}\n`);
    if (
      error instanceof ServerError &&
      error.serverStderr !== undefined &&
      error.serverStderr.trim() !== ''
    ) {
      const tail = error.serverStderr.trimEnd().split('\n').slice(-20);
      io.stderr(
        `server stderr (last ${tail.length} lines):\n${tail.map((line) => `  ${line}`).join('\n')}\n`,
      );
    }
    return interrupted ? INTERRUPTED_EXIT_CODE : error.exitCode;
  }
  io.stderr(`mcp-contract: unexpected error: ${describeError(error)}\n`);
  if (
    io.env.MCP_CONTRACT_DEBUG !== undefined &&
    error instanceof Error &&
    error.stack !== undefined
  ) {
    io.stderr(`${error.stack}\n`);
  }
  return interrupted ? INTERRUPTED_EXIT_CODE : ExitCode.ServerError;
}

/**
 * Runs the CLI with `argv` (without the node and script paths) and resolves to
 * the process exit code. Never throws.
 */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.stdout(HELP);
        return ExitCode.Ok;
      case 'version':
      case '--version':
      case '-v':
        io.stdout(`${VERSION}\n`);
        return ExitCode.Ok;
      case 'snapshot':
        return await snapshotCommand(rest, io);
      case 'diff':
        return await diffCommand(rest, io);
      case 'check':
        return await checkCommand(rest, io);
      case 'test':
        return await testCommand(rest, io);
      default:
        throw new UsageError(`Unknown command "${command}". Run "mcp-contract --help" for usage.`);
    }
  } catch (error) {
    return reportError(error, io);
  }
}
