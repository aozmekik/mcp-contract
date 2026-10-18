import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { InvalidFileError, OutputFileError, describeError, errorCode } from '../core/errors.ts';
import { parseSnapshot, serializeSnapshot } from './format.ts';
import type { Snapshot } from './model.ts';

/** File name used when no snapshot path is given. */
export const DEFAULT_SNAPSHOT_FILE = 'mcp-contract.snapshot.json';

/**
 * Reads and validates a snapshot file.
 *
 * @throws {InvalidFileError} if the file is missing, unreadable or invalid.
 */
export async function readSnapshot(path: string): Promise<Snapshot> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = errorCode(error);
    throw new InvalidFileError(
      path,
      code === 'ENOENT' ? 'file not found' : `cannot read file (${code ?? describeError(error)})`,
      { cause: error },
    );
  }
  return parseSnapshot(text, path);
}

/**
 * Writes a snapshot atomically (temporary file in the same directory, then
 * rename), so an interrupted run never leaves a truncated snapshot behind.
 *
 * @returns The serialised text that was written.
 * @throws {OutputFileError} if the file cannot be written.
 */
export async function writeSnapshot(path: string, snapshot: Snapshot): Promise<string> {
  const text = serializeSnapshot(snapshot);
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    const code = errorCode(error);
    throw new OutputFileError(
      path,
      code === 'ENOENT'
        ? 'cannot write file (its directory does not exist)'
        : `cannot write file (${code ?? describeError(error)})`,
      { cause: error },
    );
  }
  return text;
}
