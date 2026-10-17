/**
 * Error hierarchy. Every error mcp-contract raises on purpose extends
 * {@link McpContractError} and carries the process exit code the CLI uses for it,
 * so the CLI never has to guess from message text.
 */

/** Process exit codes used by the CLI. */
export const ExitCode = {
  /** Everything passed. */
  Ok: 0,
  /** The contract check failed: disallowed changes or failing scenarios. */
  ContractFailure: 1,
  /** Bad command-line usage or an invalid input file. */
  UsageError: 2,
  /** The server could not be started, reached, or spoke the protocol incorrectly. */
  ServerError: 3,
} as const;

/** One of the values of {@link ExitCode}. */
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** Base class for all errors raised intentionally by mcp-contract. */
export class McpContractError extends Error {
  /** Exit code the CLI reports for this error. */
  readonly exitCode: ExitCode;

  /** Creates an error with a message, exit code and optional cause. */
  constructor(message: string, exitCode: ExitCode, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

/** Invalid command-line usage, options or input files (exit code 2). */
export class UsageError extends McpContractError {
  /** Creates a usage error. */
  constructor(message: string, options?: ErrorOptions) {
    super(message, ExitCode.UsageError, options);
  }
}

/** A snapshot or scenario file that cannot be read or does not match its schema (exit code 2). */
export class InvalidFileError extends McpContractError {
  /** Path of the offending file. */
  readonly file: string;

  /** Creates an error describing why `file` is invalid. */
  constructor(file: string, reason: string, options?: ErrorOptions) {
    super(`${file}: ${reason}`, ExitCode.UsageError, options);
    this.file = file;
  }
}

/** The server failed to start, connect, answer in time or follow the protocol (exit code 3). */
export class ServerError extends McpContractError {
  /** Tail of the server's stderr, when it was captured. */
  readonly serverStderr: string | undefined;

  /** Creates a server error, optionally attaching captured stderr output. */
  constructor(message: string, options?: ErrorOptions & { serverStderr?: string | undefined }) {
    super(message, ExitCode.ServerError, options);
    this.serverStderr = options?.serverStderr;
  }
}

/** Returns a readable message for any thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
