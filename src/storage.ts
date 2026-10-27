import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';

import { err, ok } from './result.ts';
import type { Result } from './result.ts';

/** A document as it sits in the file: its encoded fields and its `updatedAt` in epoch ms. */
export interface StoredDocument {
  at: number;
  doc: Record<string, unknown>;
}

export interface LogContents {
  collections: Map<string, Map<string, StoredDocument>>;
  /** Operations read from the file, live or overwritten, to decide when to compact. */
  operations: number;
  /** The last line was cut short, most likely by a crash during an append. */
  isTorn: boolean;
}

const FILE_VERSION = 2;
const NOT_FOUND_CODE = 'ENOENT';
// Snapshot lines are written in chunks of about this many characters, yielding in between.
const CHUNK_SIZE = 1 << 20;

const Header = z.strictObject({ version: z.literal(FILE_VERSION) });

const SetOperation = z.strictObject({
  col: z.string().min(1),
  id: z.string().min(1),
  at: z.number().int(),
  doc: z.record(z.string(), z.unknown()),
});

const RemoveOperation = z.strictObject({
  col: z.string().min(1),
  id: z.string().min(1),
  del: z.literal(true),
});

const Operation = z.union([SetOperation, RemoveOperation]);

// A line holds one operation, or an array of them that were saved together and apply together.
const Line = z.union([Operation, z.array(Operation).min(1)]);

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === NOT_FOUND_CODE;
}

function applyLine(
  contents: LogContents,
  text: string,
  lineNumber: number,
  isLast: boolean,
): Result<void, string> {
  if (text.trim() === '') {
    return ok(undefined);
  }

  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    // Appends are the only writes that are not atomic, and they only ever touch the end.
    if (isLast && lineNumber > 1) {
      contents.isTorn = true;
      return ok(undefined);
    }

    return err(`line ${lineNumber}: invalid JSON`);
  }

  if (lineNumber === 1) {
    const header = Header.safeParse(json);

    return header.success ? ok(undefined) : err(`line 1: ${z.prettifyError(header.error)}`);
  }

  const parsed = Line.safeParse(json);

  if (!parsed.success) {
    return err(`line ${lineNumber}: ${z.prettifyError(parsed.error)}`);
  }

  for (const operation of Array.isArray(parsed.data) ? parsed.data : [parsed.data]) {
    let documents = contents.collections.get(operation.col);

    if (!documents) {
      documents = new Map();
      contents.collections.set(operation.col, documents);
    }

    if ('del' in operation) {
      documents.delete(operation.id);
    } else {
      documents.set(operation.id, { at: operation.at, doc: operation.doc });
    }

    contents.operations++;
  }

  return ok(undefined);
}

export function formatHeader(): string {
  return JSON.stringify({ version: FILE_VERSION });
}

/** One line for a document's current version, or for its removal when `stored` is null. */
export function formatOperation(
  collection: string,
  id: string,
  stored: StoredDocument | null,
): string {
  return JSON.stringify(
    stored
      ? { col: collection, id, at: stored.at, doc: stored.doc }
      : { col: collection, id, del: true },
  );
}

/**
 * Reads the log line by line, so the file is never held as one string. Returns null when the
 * file does not exist or is empty.
 */
export async function readLog(path: string): Promise<Result<LogContents | null, string>> {
  try {
    await stat(path);
  } catch (error) {
    if (isNotFound(error)) {
      return ok(null);
    }

    throw error;
  }

  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const contents: LogContents = { collections: new Map(), operations: 0, isTorn: false };
  // Each line is applied once the next one arrives, so the last line is known to be the last.
  let previous: string | null = null;
  let lineNumber = 0;

  for await (const line of lines) {
    if (previous !== null) {
      const applied = applyLine(contents, previous, lineNumber, false);

      if (applied.error !== null) {
        return applied;
      }
    }

    previous = line;
    lineNumber++;
  }

  if (previous === null) {
    return ok(null);
  }

  const applied = applyLine(contents, previous, lineNumber, true);

  return applied.error === null ? ok(contents) : applied;
}

/** Appends one line and waits until it is on disk. */
export async function appendLine(path: string, line: string): Promise<void> {
  const file = await open(path, 'a');

  try {
    await file.writeFile(`${line}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
}

/**
 * Writes `lines` to a temporary file in chunks and renames it over `path`. A crash at any point
 * leaves either the old file or the new one, never a mix.
 */
export async function writeSnapshot(path: string, lines: Iterable<string>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  const temporary = `${path}.${randomUUID()}.tmp`;

  try {
    const file = await open(temporary, 'w');

    try {
      let chunk = '';

      for (const line of lines) {
        chunk += `${line}\n`;

        if (chunk.length >= CHUNK_SIZE) {
          await file.writeFile(chunk, 'utf8');
          chunk = '';
        }
      }

      if (chunk !== '') {
        await file.writeFile(chunk, 'utf8');
      }

      await file.sync();
    } finally {
      await file.close();
    }

    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
