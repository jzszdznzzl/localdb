import { resolve } from 'node:path';

import { Collection } from './collection.ts';
import { DbError, failure } from './errors.ts';
import { err, ok } from './result.ts';
import { appendLine, formatHeader, formatOperation, readLog, writeSnapshot } from './storage.ts';
import type { CollectionHandle, CollectionHost } from './collection.ts';
import type { ObjectSchema } from './document.ts';
import type { DbFailure } from './errors.ts';
import type { Result } from './result.ts';
import type { StoredDocument } from './storage.ts';

export interface LocalDBOptions {
  /**
   * Saves automatically after changes. `true` waits 500 ms, so a burst of changes becomes one
   * write; pass `{ delay }` to choose the wait. Off by default.
   */
  autosave?: boolean | { delay: number };
  /** Receives autosave failures. Defaults to `console.error`; the next change retries the write. */
  onError?: (error: unknown) => void;
}

const DEFAULT_AUTOSAVE_DELAY = 500;
// Above this many pending changes a full rewrite is about as cheap as appending, and it keeps
// every line small enough to build as one string.
const MAX_APPEND_OPERATIONS = 10_000;
// The file is rewritten once it holds this many times more operations than live documents.
const COMPACT_RATIO = 2;
// Keeps small databases from being rewritten after every few changes.
const COMPACT_SLACK = 1_000;

const ignore = (): void => {};

const reportError = (error: unknown): void => {
  console.error('[localdb] autosave failed:', error);
};

/**
 * Named collections of documents, each validated by its zod schema, kept in memory and stored
 * in one append-only JSON Lines file.
 */
export class LocalDB {
  #path: string;
  #autosaveDelay: number | null;
  #onError: (error: unknown) => void;
  #handles = new Map<string, CollectionHandle>();
  // Collections in the file that this program has not declared are kept and written back as-is.
  #undeclared = new Map<string, Map<string, StoredDocument>>();
  // Ids changed since the last write, by collection. Only these are appended on save.
  #pending = new Map<string, Set<string>>();
  #pendingSize = 0;
  #fileOperations = 0;
  // The next write must rewrite the whole file: there is no file yet, its end is torn, an append
  // failed, or there are too many changes to append. Changed ids are not tracked meanwhile.
  #needsRewrite = false;
  #isLoaded = false;
  #isClosed = false;
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
    afterChange: (name, keys) => {
      this.#scheduleAutosave();

      if (this.#needsRewrite) {
        return;
      }

      let pending = this.#pending.get(name);

      if (!pending) {
        pending = new Set();
        this.#pending.set(name, pending);
      }

      const before = pending.size;

      if (typeof keys === 'string') {
        pending.add(keys);
      } else {
        for (const key of keys) {
          pending.add(key);
        }
      }

      this.#pendingSize += pending.size - before;

      if (this.#pendingSize > MAX_APPEND_OPERATIONS) {
        this.#needsRewrite = true;
        this.#takePending();
      }
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

  #enqueue(task: () => Promise<void>): Promise<void> {
    this.#assertReady();
    this.#clearTimer();

    const write = this.#writes.catch(ignore).then(task);
    this.#writes = write;

    return write;
  }

  #liveCount(): number {
    let count = 0;

    for (const handle of this.#handles.values()) {
      count += handle.size;
    }

    for (const documents of this.#undeclared.values()) {
      count += documents.size;
    }

    return count;
  }

  #takePending(): Map<string, Set<string>> {
    const taken = this.#pending;
    this.#pending = new Map();
    this.#pendingSize = 0;

    return taken;
  }

  // A failed write puts its changes back, merged with any made while it was running.
  #restorePending(taken: Map<string, Set<string>>): void {
    for (const [name, keys] of taken) {
      const pending = this.#pending.get(name);

      this.#pending.set(name, pending ? new Set([...keys, ...pending]) : keys);
    }

    this.#pendingSize = 0;

    for (const keys of this.#pending.values()) {
      this.#pendingSize += keys.size;
    }
  }

  async #write(): Promise<void> {
    if (!this.#needsRewrite && this.#pendingSize === 0) {
      return;
    }

    const shouldCompact =
      this.#needsRewrite ||
      this.#fileOperations + this.#pendingSize > this.#liveCount() * COMPACT_RATIO + COMPACT_SLACK;

    await (shouldCompact ? this.#compact() : this.#append());
  }

  async #append(): Promise<void> {
    const taken = this.#takePending();
    const operations: string[] = [];

    for (const [name, keys] of taken) {
      const handle = this.#handles.get(name);

      for (const key of keys) {
        operations.push(formatOperation(name, key, handle?.read(key) ?? null));
      }
    }

    if (operations.length === 0) {
      return;
    }

    // Several operations go on one line, so a save is applied in full or not at all.
    const line = operations.length === 1 ? operations.join('') : `[${operations.join(',')}]`;

    try {
      await appendLine(this.#path, line);
      this.#fileOperations += operations.length;
    } catch (error) {
      this.#restorePending(taken);
      // The append may have left half a line, so the next write rewrites the whole file.
      this.#needsRewrite = true;
      throw error;
    }
  }

  async #compact(): Promise<void> {
    const taken = this.#takePending();
    // Changes made while the snapshot is written are tracked again, so the next save appends them.
    this.#needsRewrite = false;
    const sources: [string, Iterable<[string, StoredDocument]>][] = [
      ...Array.from(
        this.#undeclared,
        ([name, documents]): [string, Iterable<[string, StoredDocument]>] => [
          name,
          Array.from(documents),
        ],
      ),
      ...Array.from(
        this.#handles,
        ([name, handle]): [string, Iterable<[string, StoredDocument]>] => [name, handle.entries()],
      ),
    ];
    const counter = { operations: 0 };

    function* lines(): Generator<string> {
      yield formatHeader();

      for (const [name, documents] of sources) {
        for (const [key, stored] of documents) {
          counter.operations++;
          yield formatOperation(name, key, stored);
        }
      }
    }

    try {
      await writeSnapshot(this.#path, lines());
    } catch (error) {
      this.#restorePending(taken);
      this.#needsRewrite = true;
      throw error;
    }

    this.#fileOperations = counter.operations;
  }

  get path(): string {
    return this.#path;
  }

  get isLoaded(): boolean {
    return this.#isLoaded;
  }

  get hasUnsavedChanges(): boolean {
    return this.#needsRewrite || this.#pendingSize > 0;
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
      // Preparing decodes documents in place, and if this schema rejects them they stay undeclared
      // and are written back later, so it must work on a copy.
      const prepared = this.#handles.get(name)?.prepare(structuredClone(stored));

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

    const log = await readLog(this.#path);

    if (log.error !== null) {
      return err(failure(DbError.InvalidFile, `${this.#path}: ${log.error}`));
    }

    const collections = log.data?.collections ?? new Map<string, Map<string, StoredDocument>>();
    const commits: (() => void)[] = [];

    for (const [name, handle] of this.#handles) {
      const prepared = handle.prepare(collections.get(name) ?? new Map());

      if (prepared.error !== null) {
        return prepared;
      }

      commits.push(prepared.data);
    }

    for (const commit of commits) {
      commit();
    }

    this.#undeclared = new Map(
      Array.from(collections).filter(([name]) => !this.#handles.has(name)),
    );
    this.#clearTimer();
    this.#takePending();
    // A missing file is created by a rewrite, and a torn last line would be followed by the next
    // append, so the file is rewritten instead.
    this.#needsRewrite = log.data === null || log.data.isTorn;
    this.#fileOperations = log.data?.operations ?? 0;
    this.#isLoaded = true;

    return ok(undefined);
  }

  /**
   * Writes pending changes to disk by appending them to the file, or by rewriting it when it
   * has grown too large. Calls run one after another, never at the same time.
   */
  save(): Promise<void> {
    return this.#enqueue(() => this.#write());
  }

  /** Rewrites the file with only the current documents, dropping old versions and removals. */
  compact(): Promise<void> {
    return this.#enqueue(() => this.#compact());
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
