import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
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
// Snapshot lines are written, and the file read, in chunks of about this size.
const CHUNK_SIZE = 1 << 20;
const NEWLINE = '\n';

const Header = z.strictObject({ version: z.literal(FILE_VERSION) });

// Plain objects instead of strict ones, and `doc` as a loose object instead of a record: this
// runs once per line, and the document itself is validated by its collection schema anyway.
const SetOperation = z.object({
  col: z.string(),
  id: z.string(),
  at: z.number(),
  doc: z.looseObject({}),
});

const RemoveOperation = z.object({
  col: z.string(),
  id: z.string(),
  del: z.literal(true),
});

const Operation = z.union([SetOperation, RemoveOperation]);

// A line holds one operation, or an array of them that were saved together and apply together.
const Batch = z.array(Operation).min(1);

const BLANK_LINE = /^\s*$/;

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === NOT_FOUND_CODE;
}

function applyLine(
  contents: LogContents,
  text: string,
  lineNumber: number,
  isLast: boolean,
): Result<void, string> {
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    if (BLANK_LINE.test(text)) {
      return ok(undefined);
    }

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

  const parsed = Array.isArray(json) ? Batch.safeParse(json) : Operation.safeParse(json);

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
      // The parsed operation already has `at` and `doc`, so it is kept instead of a new object.
      documents.set(operation.id, operation);
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
  // The wrapper is written by hand: it is cheaper than letting JSON.stringify build it per line.
  const prefix = `{"col":${JSON.stringify(collection)},"id":${JSON.stringify(id)}`;

  return stored
    ? `${prefix},"at":${stored.at},"doc":${JSON.stringify(stored.doc)}}`
    : `${prefix},"del":true}`;
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

  // Splitting large chunks by hand is much faster than readline, which does extra work per line.
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: CHUNK_SIZE });
  const contents: LogContents = { collections: new Map(), operations: 0, isTorn: false };
  let rest = '';
  let lineNumber = 0;

  for await (const chunk of stream) {
    const text = `${rest}${String(chunk)}`;
    let start = 0;
    let end = text.indexOf(NEWLINE, start);

    while (end !== -1) {
      lineNumber++;
      const applied = applyLine(contents, text.slice(start, end), lineNumber, false);

      if (applied.error !== null) {
        stream.destroy();
        return applied;
      }

      start = end + 1;
      end = text.indexOf(NEWLINE, start);
    }

    rest = text.slice(start);
  }

  if (lineNumber === 0 && rest === '') {
    return ok(null);
  }

  if (rest === '') {
    return ok(contents);
  }

  // Every write ends its line with a newline, so only a final piece without one can be torn.
  lineNumber++;
  const applied = applyLine(contents, rest, lineNumber, true);

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
