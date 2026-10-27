import { decode, encode, isPlainObject } from './codec.ts';
import { createDocument } from './document.ts';
import { DbError, failure } from './errors.ts';
import { Id } from './id.ts';
import { err, ok } from './result.ts';
import type { Change, Document, Input, ObjectSchema } from './document.ts';
import type { DbFailure } from './errors.ts';
import type { Result } from './result.ts';
import type { StoredDocument } from './storage.ts';

/** The non-generic side of a collection that `LocalDB` drives: loading, saving and rollback. */
export interface CollectionHandle {
  readonly size: number;
  /** Validates stored data and returns a function that swaps it in, so a load is all-or-nothing. */
  prepare(stored: ReadonlyMap<string, StoredDocument>): Result<() => void, DbFailure>;
  /** The stored form of one document, or null if it no longer exists. */
  read(key: string): StoredDocument | null;
  /** The stored form of every document, encoded lazily from a copy taken when this is called. */
  entries(): Iterable<[string, StoredDocument]>;
  /** Copies the current documents and returns a function that restores that copy. */
  snapshot(): () => void;
}

export interface CollectionHost {
  attach(name: string, handle: CollectionHandle): void;
  assertReady(): void;
  /** Called before any change, so an open transaction can take its snapshot first. */
  beforeChange(name: string): void;
  /** Called after a change with the ids it touched, so only those are written. */
  afterChange(name: string, keys: readonly string[]): void;
}

export type Predicate<S extends ObjectSchema> = (document: Document<S>) => boolean;

const keyOf = (id: Id | string): string =>
  typeof id === 'string' ? id.toUpperCase() : id.toString();

function toStored(document: object): StoredDocument {
  // The id is the operation's key and updatedAt its `at`, so neither is repeated in the fields.
  const fields: Record<string, unknown> = {};
  let at = 0;

  for (const [key, value] of Object.entries(document)) {
    if (key === 'updatedAt' && value instanceof Date) {
      at = value.getTime();
    } else if (key !== 'id') {
      fields[key] = value;
    }
  }

  const encoded = encode(fields);

  if (!isPlainObject(encoded)) {
    throw new Error('A document must encode to an object');
  }

  return { at, doc: encoded };
}

/** A named set of documents validated by one zod schema. Create it with `db.collection()`. */
export class Collection<S extends ObjectSchema> {
  #name: string;
  #schema: S;
  #host: CollectionHost;
  #documents = new Map<string, Document<S>>();

  constructor(name: string, schema: S, host: CollectionHost) {
    this.#name = name;
    this.#schema = schema;
    this.#host = host;

    const documents = (): Map<string, Document<S>> => this.#documents;

    host.attach(name, {
      get size() {
        return documents().size;
      },
      prepare: (stored) => this.#prepare(stored),
      read: (key) => {
        const document = this.#documents.get(key);

        return document ? toStored(document) : null;
      },
      entries: () => {
        const copy = Array.from(this.#documents);

        return (function* encodeAll(): Generator<[string, StoredDocument]> {
          for (const [key, document] of copy) {
            yield [key, toStored(document)];
          }
        })();
      },
      snapshot: () => {
        const copy = new Map(this.#documents);

        return () => {
          this.#documents = copy;
        };
      },
    });
  }

  #prepare(stored: ReadonlyMap<string, StoredDocument>): Result<() => void, DbFailure> {
    const documents = new Map<string, Document<S>>();

    for (const [key, value] of stored) {
      const label = `${this.#name}/${key}`;
      const id = Id.parse(key);

      if (id.error !== null) {
        return err(failure(DbError.InvalidDocument, `${label}: ${id.error}`));
      }

      const decoded = decode(value.doc);

      if (decoded.error !== null) {
        return err(failure(DbError.InvalidDocument, `${label}: ${decoded.error}`));
      }

      const document = createDocument(
        this.#schema,
        decoded.data,
        { id: id.data, updatedAt: new Date(value.at) },
        label,
      );

      if (document.error !== null) {
        return document;
      }

      documents.set(id.data.toString(), document.data);
    }

    return ok(() => {
      this.#documents = documents;
    });
  }

  #build(value: unknown, id: Id): Result<Document<S>, DbFailure> {
    return createDocument(
      this.#schema,
      value,
      { id, updatedAt: new Date() },
      `${this.#name}/${id.toString()}`,
    );
  }

  #next(document: Document<S>, change: Change<S>): Result<Document<S>, DbFailure> {
    const value = typeof change === 'function' ? change(document) : { ...document, ...change };

    return this.#build(value, document.id);
  }

  #commit(documents: readonly Document<S>[]): void {
    if (documents.length === 0) {
      return;
    }

    this.#host.beforeChange(this.#name);

    const keys: string[] = [];

    for (const document of documents) {
      const key = document.id.toString();
      this.#documents.set(key, document);
      keys.push(key);
    }

    this.#host.afterChange(this.#name, keys);
  }

  get name(): string {
    return this.#name;
  }

  get size(): number {
    this.#host.assertReady();

    return this.#documents.size;
  }

  /** Validates and stores a new document, returning it with its generated `id`. */
  insert(value: Input<S>): Result<Document<S>, DbFailure> {
    this.#host.assertReady();

    const document = this.#build(value, new Id());

    if (document.error === null) {
      this.#commit([document.data]);
    }

    return document;
  }

  /** Inserts every value, or none of them if any fails validation. */
  insertMany(values: readonly Input<S>[]): Result<Document<S>[], DbFailure> {
    this.#host.assertReady();

    const documents: Document<S>[] = [];

    for (const value of values) {
      const document = this.#build(value, new Id());

      if (document.error !== null) {
        return document;
      }

      documents.push(document.data);
    }

    this.#commit(documents);

    return ok(documents);
  }

  get(id: Id | string): Document<S> | null {
    this.#host.assertReady();

    return this.#documents.get(keyOf(id)) ?? null;
  }

  has(id: Id | string): boolean {
    this.#host.assertReady();

    return this.#documents.has(keyOf(id));
  }

  find(predicate?: Predicate<S>): Document<S>[] {
    this.#host.assertReady();

    const documents = Array.from(this.#documents.values());

    return predicate ? documents.filter(predicate) : documents;
  }

  findOne(predicate: Predicate<S>): Document<S> | null {
    this.#host.assertReady();

    for (const document of this.#documents.values()) {
      if (predicate(document)) {
        return document;
      }
    }

    return null;
  }

  count(predicate?: Predicate<S>): number {
    return predicate ? this.find(predicate).length : this.size;
  }

  /** Replaces a document with a validated new version. Its `id` never changes. */
  update(id: Id | string, change: Change<S>): Result<Document<S>, DbFailure> {
    this.#host.assertReady();

    const current = this.#documents.get(keyOf(id));

    if (!current) {
      return err(failure(DbError.NotFound, `${this.#name}/${keyOf(id)}: not found`));
    }

    const document = this.#next(current, change);

    if (document.error === null) {
      this.#commit([document.data]);
    }

    return document;
  }

  /** Updates every matching document, or none of them if any new version fails validation. */
  updateMany(predicate: Predicate<S>, change: Change<S>): Result<Document<S>[], DbFailure> {
    const documents: Document<S>[] = [];

    for (const current of this.find(predicate)) {
      const document = this.#next(current, change);

      if (document.error !== null) {
        return document;
      }

      documents.push(document.data);
    }

    this.#commit(documents);

    return ok(documents);
  }

  remove(id: Id | string): boolean {
    this.#host.assertReady();

    const key = keyOf(id);

    if (!this.#documents.has(key)) {
      return false;
    }

    this.#host.beforeChange(this.#name);
    this.#documents.delete(key);
    this.#host.afterChange(this.#name, [key]);

    return true;
  }

  /** Removes every matching document and returns how many were removed. */
  removeMany(predicate: Predicate<S>): number {
    const keys = this.find(predicate).map((document) => document.id.toString());

    if (keys.length === 0) {
      return 0;
    }

    this.#host.beforeChange(this.#name);

    for (const key of keys) {
      this.#documents.delete(key);
    }

    this.#host.afterChange(this.#name, keys);

    return keys.length;
  }

  [Symbol.iterator](): IterableIterator<Document<S>> {
    this.#host.assertReady();

    return this.#documents.values();
  }
}
