import { z } from 'zod';

import { isPlainObject } from './codec.ts';
import { DbError, failure } from './errors.ts';
import { err, ok } from './result.ts';
import type { DbFailure } from './errors.ts';
import type { Id } from './id.ts';
import type { Result } from './result.ts';

type Immutable =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | Date
  | Id
  | RegExp
  | URL
  | Uint8Array;

/** A schema whose parsed value is an object, so it can carry an `id` and `updatedAt`. */
export type ObjectSchema = z.ZodType<object>;

/** Deeply read-only view of a value, matching what `deepFreeze` does at runtime. */
export type Frozen<T> = T extends Immutable
  ? T
  : T extends Map<infer K, infer V>
    ? ReadonlyMap<K, Frozen<V>>
    : T extends Set<infer V>
      ? ReadonlySet<Frozen<V>>
      : { readonly [K in keyof T]: Frozen<T[K]> };

/** Fields that every stored document carries, on top of the ones its schema defines. */
export type DocumentMeta = {
  id: Id;
  updatedAt: Date;
};

export type Document<S extends ObjectSchema> = Frozen<z.output<S> & DocumentMeta>;

/** What `insert` accepts: the schema's input. Read-only values are accepted too. */
export type Input<S extends ObjectSchema> = Frozen<z.input<S>>;

/** A partial patch merged into the document, or a function that returns its next version. */
export type Change<S extends ObjectSchema> =
  Partial<Input<S>> | ((document: Document<S>) => Input<S>);

const META_KEYS: ReadonlySet<string> = new Set([
  'id',
  'updatedAt',
] satisfies (keyof DocumentMeta)[]);

/** Copies an object without `id` and `updatedAt`, which are owned by the store, not the schema. */
export function stripMeta(value: unknown): unknown {
  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(Object.entries(value).filter(([key]) => !META_KEYS.has(key)));
}

export function deepFreeze<T>(value: T): Frozen<T>;
export function deepFreeze(value: unknown): unknown {
  // Only arrays and plain objects are frozen: typed arrays refuse Object.freeze, and freezing a
  // Map, Set or Date would not stop their methods from changing them.
  if (Array.isArray(value) || isPlainObject(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }

    Object.freeze(value);
  }

  return value;
}

/** Validates `value` with the collection schema and builds the frozen document stored for it. */
export function createDocument<S extends ObjectSchema>(
  schema: S,
  value: unknown,
  meta: DocumentMeta,
  label: string,
): Result<Document<S>, DbFailure> {
  const parsed = schema.safeParse(stripMeta(value));

  if (!parsed.success) {
    return err(
      failure(
        DbError.InvalidDocument,
        `${label}: ${z.prettifyError(parsed.error)}`,
        parsed.error.issues,
      ),
    );
  }

  return ok(deepFreeze(Object.assign({}, parsed.data, meta)));
}
