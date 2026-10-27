import { z } from 'zod';

import { decode, encode } from './codec.ts';
import { createDocument } from './document.ts';
import { DbError, failure } from './errors.ts';
import { Id } from './id.ts';
import { err, ok } from './result.ts';
import type { Change, Document, Input, ObjectSchema } from './document.ts';
import type { DbFailure } from './errors.ts';
import type { Result } from './result.ts';

/** The non-generic side of a collection that `LocalDB` drives: loading, saving and rollback. */
export interface CollectionHandle {
  /** Validates stored data and returns a function that swaps it in, so a load is all-or-nothing. */
  prepare(stored: Record<string, unknown>): Result<() => void, DbFailure>;
  serialize(): Record<string, unknown>;
  /** Copies the current documents and returns a function that restores that copy. */
  snapshot(): () => void;
}

export interface CollectionHost {
  attach(name: string, handle: CollectionHandle): void;
  assertReady(): void;
  /** Called before any change, so an open transaction can take its snapshot first. */
  beforeChange(name: string): void;
  afterChange(): void;
}

export type Predicate<S extends ObjectSchema> = (document: Document<S>) => boolean;

const StoredMeta = z.looseObject({ updatedAt: z.date() });

const keyOf = (id: Id | string): string =>
  typeof id === 'string' ? id.toUpperCase() : id.toString();

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

    host.attach(name, {
      prepare: (stored) => this.#prepare(stored),
      serialize: () => this.#serialize(),
      snapshot: () => {
        const copy = new Map(this.#documents);

        return () => {
          this.#documents = copy;
        };
      },
    });
  }

  #prepare(stored: Record<string, unknown>): Result<() => void, DbFailure> {
    const documents = new Map<string, Document<S>>();

    for (const [key, value] of Object.entries(stored)) {
      const label = `${this.#name}/${key}`;
      const id = Id.parse(key);

      if (id.error !== null) {
        return err(failure(DbError.InvalidDocument, `${label}: ${id.error}`));
      }

      const decoded = decode(value);

      if (decoded.error !== null) {
        return err(failure(DbError.InvalidDocument, `${label}: ${decoded.error}`));
      }

      const meta = StoredMeta.safeParse(decoded.data);

      if (!meta.success) {
        return err(
          failure(
            DbError.InvalidDocument,
            `${label}: ${z.prettifyError(meta.error)}`,
            meta.error.issues,
          ),
        );
      }

      const document = createDocument(
        this.#schema,
        decoded.data,
        { id: id.data, updatedAt: meta.data.updatedAt },
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

  #serialize(): Record<string, unknown> {
    const output: Record<string, unknown> = {};

    for (const [key, document] of this.#documents) {
      // The id is already the key, so it is not repeated inside the document.
      const { id: _id, ...fields } = document;
      output[key] = encode(fields);
    }

    return output;
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

    for (const document of documents) {
      this.#documents.set(document.id.toString(), document);
    }

    this.#host.afterChange();
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
    this.#host.afterChange();

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

    this.#host.afterChange();

    return keys.length;
  }

  [Symbol.iterator](): IterableIterator<Document<S>> {
    this.#host.assertReady();

    return this.#documents.values();
  }
}
