import { z } from 'zod';

import { Id } from './id.ts';
import { err, ok } from './result.ts';
import type { Result } from './result.ts';

const Tag = Object.freeze({
  Object: 'Object',
  Undefined: 'Undefined',
  NaN: 'NaN',
  Infinity: 'Infinity',
  NegativeInfinity: '-Infinity',
  BigInt: 'BigInt',
  Date: 'Date',
  RegExp: 'RegExp',
  URL: 'URL',
  Map: 'Map',
  Set: 'Set',
  Buffer: 'Buffer',
  Uint8Array: 'Uint8Array',
  Id: 'Id',
} as const);

const TAG_KEY = '__type';
const BIGINT_PATTERN = /^-?\d+$/;

// Strict objects, so a hand-edited or corrupted tag is reported instead of half-read.
const TaggedValue = z.discriminatedUnion(TAG_KEY, [
  z.strictObject({ [TAG_KEY]: z.literal(Tag.Object), value: z.record(z.string(), z.unknown()) }),
  z.strictObject({ [TAG_KEY]: z.literal(Tag.Undefined) }),
  z.strictObject({ [TAG_KEY]: z.literal(Tag.NaN) }),
  z.strictObject({ [TAG_KEY]: z.literal(Tag.Infinity) }),
  z.strictObject({ [TAG_KEY]: z.literal(Tag.NegativeInfinity) }),
  z.strictObject({ [TAG_KEY]: z.literal(Tag.BigInt), value: z.string().regex(BIGINT_PATTERN) }),
  // Dates and ids are checked while building them, which saves parsing each one twice.
  // Dates are written as epoch milliseconds, which is several times cheaper than an ISO string in
  // both directions. ISO strings are still read, so hand-written dates keep working.
  z.strictObject({ [TAG_KEY]: z.literal(Tag.Date), value: z.union([z.number(), z.string()]) }),
  z.strictObject({ [TAG_KEY]: z.literal(Tag.RegExp), source: z.string(), flags: z.string() }),
  z.strictObject({
    [TAG_KEY]: z.literal(Tag.URL),
    value: z.string().refine((value) => URL.canParse(value), 'Invalid URL'),
  }),
  z.strictObject({
    [TAG_KEY]: z.literal(Tag.Map),
    value: z.array(z.tuple([z.unknown(), z.unknown()])),
  }),
  z.strictObject({ [TAG_KEY]: z.literal(Tag.Set), value: z.array(z.unknown()) }),
  z.strictObject({ [TAG_KEY]: z.literal(Tag.Buffer), value: z.base64() }),
  z.strictObject({ [TAG_KEY]: z.literal(Tag.Uint8Array), value: z.base64() }),
  z.strictObject({ [TAG_KEY]: z.literal(Tag.Id), value: z.string() }),
]);

type TaggedValue = z.infer<typeof TaggedValue>;

// Each tag is validated with its own schema: going through the whole union for every Date was
// the largest cost of loading a file.
const TAG_SCHEMAS: ReadonlyMap<unknown, z.ZodType<TaggedValue>> = new Map(
  TaggedValue.options.map((option) => [option.shape[TAG_KEY].value, option]),
);

const describe = (value: unknown): string => {
  if (typeof value === 'object' && value !== null) {
    return value.constructor?.name ?? 'object';
  }

  return typeof value;
};

// True when JSON.stringify would write `value` exactly, so encode can return it without copying.
function isJsonSafe(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isJsonSafe(entry)) {
        return false;
      }
    }

    return true;
  }

  if (isPlainObject(value)) {
    if (Object.hasOwn(value, TAG_KEY)) {
      return false;
    }

    for (const key in value) {
      const entry = value[key];

      // An undefined property is dropped, which needs a copy.
      if (entry === undefined || !isJsonSafe(entry)) {
        return false;
      }
    }

    return true;
  }

  return false;
}

// Decoding works in place: parsed JSON belongs to the caller, so copying it would only add cost.
function decodeArray(values: unknown[]): Result<unknown[], string> {
  for (let index = 0; index < values.length; index++) {
    const value = values[index];

    if (typeof value === 'object' && value !== null) {
      const decoded = decode(value);

      if (decoded.error !== null) {
        return decoded;
      }

      values[index] = decoded.data;
    }
  }

  return ok(values);
}

function decodeEntries(record: Record<string, unknown>): Result<Record<string, unknown>, string> {
  for (const key in record) {
    const value = record[key];

    if (typeof value === 'object' && value !== null) {
      const decoded = decode(value);

      if (decoded.error !== null) {
        return err(`${key}: ${decoded.error}`);
      }

      record[key] = decoded.data;
    }
  }

  return ok(record);
}

function decodeTagged(record: Record<string, unknown>): Result<unknown, string> {
  const schema = TAG_SCHEMAS.get(record[TAG_KEY]);

  if (!schema) {
    return err(`unknown ${TAG_KEY}: ${JSON.stringify(record[TAG_KEY])}`);
  }

  const parsed = schema.safeParse(record);

  if (!parsed.success) {
    return err(`invalid ${TAG_KEY} value: ${z.prettifyError(parsed.error)}`);
  }

  const tagged = parsed.data;

  switch (tagged[TAG_KEY]) {
    case Tag.Object: {
      return decodeEntries(tagged.value);
    }
    case Tag.Undefined: {
      return ok(undefined);
    }
    case Tag.NaN: {
      return ok(Number.NaN);
    }
    case Tag.Infinity: {
      return ok(Number.POSITIVE_INFINITY);
    }
    case Tag.NegativeInfinity: {
      return ok(Number.NEGATIVE_INFINITY);
    }
    case Tag.BigInt: {
      return ok(BigInt(tagged.value));
    }
    case Tag.Date: {
      const date = new Date(tagged.value);

      return Number.isNaN(date.getTime()) ? err(`invalid date: ${tagged.value}`) : ok(date);
    }
    case Tag.RegExp: {
      try {
        return ok(new RegExp(tagged.source, tagged.flags));
      } catch {
        return err(`invalid regular expression /${tagged.source}/${tagged.flags}`);
      }
    }
    case Tag.URL: {
      return ok(new URL(tagged.value));
    }
    case Tag.Map: {
      const entries = decodeArray(tagged.value.flat());

      if (entries.error !== null) {
        return entries;
      }

      const map = new Map<unknown, unknown>();

      for (let index = 0; index < entries.data.length; index += 2) {
        map.set(entries.data[index], entries.data[index + 1]);
      }

      return ok(map);
    }
    case Tag.Set: {
      const values = decodeArray(tagged.value);

      return values.error === null ? ok(new Set(values.data)) : values;
    }
    case Tag.Buffer: {
      return ok(Buffer.from(tagged.value, 'base64'));
    }
    case Tag.Uint8Array: {
      return ok(new Uint8Array(Buffer.from(tagged.value, 'base64')));
    }
    case Tag.Id: {
      return Id.parse(tagged.value);
    }
    default: {
      // The schema accepted a tag this switch does not handle, so the two lists drifted apart.
      throw new Error(`Unhandled ${TAG_KEY}: ${JSON.stringify(tagged)}`);
    }
  }
}

/** True for `{}` literals and `Object.create(null)`, but not for class instances. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/**
 * Turns a value into JSON-safe data, tagging the types JSON cannot represent with `__type`.
 * Values that cannot be stored (functions, symbols, class instances) throw a `TypeError`.
 */
export function encode(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (value === undefined) {
    return { [TAG_KEY]: Tag.Undefined };
  }

  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      return { [TAG_KEY]: Tag.NaN };
    }

    if (value === Number.POSITIVE_INFINITY) {
      return { [TAG_KEY]: Tag.Infinity };
    }

    if (value === Number.NEGATIVE_INFINITY) {
      return { [TAG_KEY]: Tag.NegativeInfinity };
    }

    return value;
  }

  if (typeof value === 'bigint') {
    return { [TAG_KEY]: Tag.BigInt, value: value.toString() };
  }

  if (value instanceof Id) {
    return { [TAG_KEY]: Tag.Id, value: value.toString() };
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError('Cannot store an invalid Date');
    }

    return { [TAG_KEY]: Tag.Date, value: value.getTime() };
  }

  if (value instanceof RegExp) {
    return { [TAG_KEY]: Tag.RegExp, source: value.source, flags: value.flags };
  }

  if (value instanceof URL) {
    return { [TAG_KEY]: Tag.URL, value: value.href };
  }

  // Buffer extends Uint8Array, so it is checked first to come back as a Buffer.
  if (Buffer.isBuffer(value)) {
    return { [TAG_KEY]: Tag.Buffer, value: value.toString('base64') };
  }

  if (value instanceof Uint8Array && value.constructor === Uint8Array) {
    return { [TAG_KEY]: Tag.Uint8Array, value: Buffer.from(value).toString('base64') };
  }

  if (value instanceof Map) {
    return {
      [TAG_KEY]: Tag.Map,
      value: Array.from(value, ([key, entry]) => [encode(key), encode(entry)]),
    };
  }

  if (value instanceof Set) {
    return { [TAG_KEY]: Tag.Set, value: Array.from(value, (entry) => encode(entry)) };
  }

  if (Array.isArray(value)) {
    return isJsonSafe(value) ? value : Array.from(value, (entry) => encode(entry));
  }

  if (isPlainObject(value)) {
    return isJsonSafe(value) ? value : encodeFields(value);
  }

  throw new TypeError(`Cannot store a value of type ${describe(value)}`);
}

/**
 * Encodes the own properties of a plain object, leaving out the keys in `skip`. Unlike `encode`,
 * it always returns a new object, so callers can drop keys without copying the object first.
 */
export function encodeFields(
  value: Record<string, unknown>,
  skip: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const key in value) {
    const entry = value[key];

    // JSON objects have no undefined, and an absent key reads back the same way.
    if (entry !== undefined && !skip.has(key)) {
      output[key] = encode(entry);
    }
  }

  // A user object that happens to own the tag key is wrapped, so it is not read back as a tag.
  return Object.hasOwn(value, TAG_KEY) && !skip.has(TAG_KEY)
    ? { [TAG_KEY]: Tag.Object, value: output }
    : output;
}

/**
 * Reverses `encode`. Arrays and objects inside `value` are reused and changed in place, so pass
 * data the caller owns, such as the output of `JSON.parse`. Malformed tags are reported as an
 * error instead of throwing.
 */
export function decode(value: unknown): Result<unknown, string> {
  if (Array.isArray(value)) {
    return decodeArray(value);
  }

  if (isPlainObject(value)) {
    return Object.hasOwn(value, TAG_KEY) ? decodeTagged(value) : decodeEntries(value);
  }

  return ok(value);
}
