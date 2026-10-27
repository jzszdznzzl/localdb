import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

import { Collection } from './collection.ts';
import { DbError, failure } from './errors.ts';
import { err, ok } from './result.ts';
import type { CollectionHandle, CollectionHost } from './collection.ts';
import type { ObjectSchema } from './document.ts';
import type { DbFailure } from './errors.ts';
import type { Result } from './result.ts';

export interface LocalDBOptions {
  /**
   * Saves automatically after changes. `true` waits 500 ms, so a burst of changes becomes one
   * write; pass `{ delay }` to choose the wait. Off by default.
   */
  autosave?: boolean | { delay: number };
  /** Receives autosave failures. Defaults to `console.error`; the next change retries the write. */
  onError?: (error: unknown) => void;
}

const FILE_VERSION = 1;
const DEFAULT_AUTOSAVE_DELAY = 500;
const NOT_FOUND_CODE = 'ENOENT';
const JSON_INDENT = 2;

const StoredFile = z.strictObject({
  version: z.literal(FILE_VERSION),
  collections: z.record(z.string(), z.record(z.string(), z.unknown())),
});

const ignore = (): void => {};

const reportError = (error: unknown): void => {
  console.error('[localdb] autosave failed:', error);
};

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === NOT_FOUND_CODE;
}

// Writing next to the file and renaming over it means a crash mid-write leaves the old file intact.
async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  const temporary = `${path}.${randomUUID()}.tmp`;

  try {
    const file = await open(temporary, 'w');

    try {
      await file.writeFile(contents, 'utf8');
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

/** A JSON file holding named collections of documents, each validated by its zod schema. */
export class LocalDB {
  #path: string;
  #autosaveDelay: number | null;
  #onError: (error: unknown) => void;
  #handles = new Map<string, CollectionHandle>();
  // Collections in the file that this program has not declared are kept and written back as-is.
  #undeclared = new Map<string, Record<string, unknown>>();
  #isLoaded = false;
  #isClosed = false;
  #isDirty = false;
  #timer: NodeJS.Timeout | null = null;
  #writes: Promise<void> = Promise.resolve();
  #transaction: Map<string, () => void> | null = null;

  #host: CollectionHost = {
    attach: (name, handle) => {
      this.#handles.set(name, handle);
    },
    assertReady: () => {
      this.#assertReady();
    },
    beforeChange: (name) => {
      const handle = this.#handles.get(name);

      if (this.#transaction && handle && !this.#transaction.has(name)) {
        this.#transaction.set(name, handle.snapshot());
      }
    },
    afterChange: () => {
      this.#isDirty = true;
      this.#scheduleAutosave();
    },
  };

  constructor(path: string, options: LocalDBOptions = {}) {
    this.#path = resolve(path);
    this.#onError = options.onError ?? reportError;

    if (options.autosave === true) {
      this.#autosaveDelay = DEFAULT_AUTOSAVE_DELAY;
    } else if (options.autosave) {
      this.#autosaveDelay = options.autosave.delay;
    } else {
      this.#autosaveDelay = null;
    }
  }

  #assertReady(): void {
    if (this.#isClosed) {
      throw new Error(`LocalDB ${this.#path} is closed`);
    }

    if (!this.#isLoaded) {
      throw new Error(`LocalDB ${this.#path} is not loaded: call and await load() first`);
    }
  }

  #scheduleAutosave(): void {
    if (this.#autosaveDelay === null || this.#timer !== null) {
      return;
    }

    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.save().catch(this.#onError);
    }, this.#autosaveDelay);
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  async #write(): Promise<void> {
    if (!this.#isDirty) {
      return;
    }

    const collections: Record<string, Record<string, unknown>> = Object.fromEntries(
      this.#undeclared,
    );

    for (const [name, handle] of this.#handles) {
      collections[name] = handle.serialize();
    }

    const contents = `${JSON.stringify({ version: FILE_VERSION, collections }, null, JSON_INDENT)}\n`;
    // Cleared before the write, so changes made while it runs mark the store dirty again.
    this.#isDirty = false;

    try {
      await writeAtomic(this.#path, contents);
    } catch (error) {
      this.#isDirty = true;
      throw error;
    }
  }

  get path(): string {
    return this.#path;
  }

  get isLoaded(): boolean {
    return this.#isLoaded;
  }

  get hasUnsavedChanges(): boolean {
    return this.#isDirty;
  }

  /** Names of the declared collections and of any other collections found in the file. */
  get collections(): string[] {
    return [...new Set([...this.#handles.keys(), ...this.#undeclared.keys()])];
  }

  /**
   * Declares a collection. Declare it once and share the returned object. Declaring after
   * `load()` validates the stored documents right away and throws if any is invalid.
   */
  collection<S extends ObjectSchema>(name: string, schema: S): Collection<S> {
    if (this.#isClosed) {
      throw new Error(`LocalDB ${this.#path} is closed`);
    }

    if (name === '') {
      throw new TypeError('A collection name cannot be empty');
    }

    if (this.#handles.has(name)) {
      throw new Error(`Collection "${name}" is already declared`);
    }

    const collection = new Collection(name, schema, this.#host);
    const stored = this.#undeclared.get(name);

    if (stored) {
      const prepared = this.#handles.get(name)?.prepare(stored);

      if (prepared?.error) {
        this.#handles.delete(name);
        throw new Error(prepared.error.message);
      }

      prepared?.data();
      this.#undeclared.delete(name);
    }

    return collection;
  }

  /**
   * Reads the file, replacing anything in memory. A missing file is an empty database. Nothing
   * changes unless every declared collection is valid.
   */
  async load(): Promise<Result<void, DbFailure>> {
    if (this.#isClosed) {
      throw new Error(`LocalDB ${this.#path} is closed`);
    }

    await this.#writes.catch(ignore);

    let text: string | null;

    try {
      text = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }

      text = null;
    }

    let collections: Record<string, Record<string, unknown>> = {};

    if (text !== null) {
      let json: unknown;

      try {
        json = JSON.parse(text);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        return err(failure(DbError.InvalidFile, `${this.#path}: invalid JSON: ${reason}`));
      }

      const parsed = StoredFile.safeParse(json);

      if (!parsed.success) {
        return err(
          failure(
            DbError.InvalidFile,
            `${this.#path}: ${z.prettifyError(parsed.error)}`,
            parsed.error.issues,
          ),
        );
      }

      collections = parsed.data.collections;
    }

    const commits: (() => void)[] = [];

    for (const [name, handle] of this.#handles) {
      const prepared = handle.prepare(collections[name] ?? {});

      if (prepared.error !== null) {
        return prepared;
      }

      commits.push(prepared.data);
    }

    for (const commit of commits) {
      commit();
    }

    this.#undeclared = new Map(
      Object.entries(collections).filter(([name]) => !this.#handles.has(name)),
    );
    this.#clearTimer();
    this.#isLoaded = true;
    // A missing file counts as unsaved, so the first save() creates it.
    this.#isDirty = text === null;

    return ok(undefined);
  }

  /** Writes pending changes to disk. Calls run one after another, never at the same time. */
  save(): Promise<void> {
    this.#assertReady();
    this.#clearTimer();

    const write = this.#writes.catch(ignore).then(() => this.#write());
    this.#writes = write;

    return write;
  }

  /**
   * Runs `fn` and undoes every change it made if it throws. `fn` must be synchronous, so no
   * other code can see or change the data halfway through. Nested calls join the outer one.
   */
  transaction<T>(fn: () => T): T {
    this.#assertReady();

    if (this.#transaction) {
      return fn();
    }

    const snapshots = new Map<string, () => void>();
    this.#transaction = snapshots;

    try {
      const result = fn();

      if (result instanceof Promise) {
        // The TypeError below replaces whatever the promise settles with, so it must not go unhandled.
        result.catch(ignore);
        throw new TypeError('transaction() needs a synchronous function, not an async one');
      }

      return result;
    } catch (error) {
      for (const restore of snapshots.values()) {
        restore();
      }

      throw error;
    } finally {
      this.#transaction = null;
    }
  }

  /** Stops autosave and writes any pending changes. The instance cannot be used afterwards. */
  async close(): Promise<void> {
    if (this.#isClosed) {
      return;
    }

    this.#clearTimer();

    if (this.#isLoaded) {
      await this.save();
    }

    this.#isClosed = true;
  }
}
