import { getRandomValues } from 'node:crypto';

import { err, ok } from './result.ts';
import type { Result } from './result.ts';

// Crockford's base32 leaves out I, L, O and U, so an id read aloud or copied by hand stays unambiguous.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const BASE = 32;
const TIME_LENGTH = 10;
// The 80 random bits are kept as two 40-bit halves, so they fit in plain numbers without BigInt.
const HALF_BYTES = 5;
const HALF_LENGTH = 8;
const HALF_LIMIT = 2 ** 40;
const BYTE = 256;
// Asking the OS for random bytes once per id is slow, so they are drawn from a refilled pool.
const POOL_SIZE = 4096;

const ID_LENGTH = 26;
const ALPHABET_CODES = Array.from(ALPHABET, (char) => char.charCodeAt(0));

const pool = new Uint8Array(POOL_SIZE);
let poolOffset = POOL_SIZE;
// Character codes of the next id. Building the string from them in one call gives V8 a flat
// string; concatenating pieces gives a rope that must be flattened, and garbage-collected, the
// first time the id is used as a Map key.
const codes: number[] = Array.from({ length: ID_LENGTH }, () => 0);

function writeBase32(value: number, offset: number, length: number): void {
  let rest = value;

  for (let index = offset + length - 1; index >= offset; index--) {
    codes[index] = ALPHABET_CODES[rest % BASE] ?? 0;
    rest = Math.floor(rest / BASE);
  }
}

function randomHalf(): number {
  if (poolOffset + HALF_BYTES > POOL_SIZE) {
    getRandomValues(pool);
    poolOffset = 0;
  }

  let value = 0;

  for (let index = 0; index < HALF_BYTES; index++) {
    value = value * BYTE + (pool[poolOffset + index] ?? 0);
  }

  poolOffset += HALF_BYTES;

  return value;
}

/**
 * A 128-bit document id: 48 bits of creation time in milliseconds followed by 80 random bits,
 * written as 26 characters of Crockford base32. Ids sort by creation time, and ids made in
 * the same millisecond by this process still sort in creation order.
 */
export class Id {
  #value: string;

  static #lastTime = -1;
  static #high = 0;
  static #low = 0;

  static #generate = (): string => {
    // A clock that moves backwards must not break the ordering, so time never goes below the last id.
    const time = Math.max(Date.now(), Id.#lastTime);

    if (time === Id.#lastTime) {
      Id.#low += 1;

      if (Id.#low === HALF_LIMIT) {
        Id.#low = 0;
        Id.#high += 1;

        if (Id.#high === HALF_LIMIT) {
          throw new Error('Too many ids in one millisecond: the random part overflowed');
        }
      }
    } else {
      Id.#lastTime = time;
      // The time part stays in `codes` until the clock moves on.
      writeBase32(time, 0, TIME_LENGTH);
      Id.#high = randomHalf();
      Id.#low = randomHalf();
    }

    writeBase32(Id.#high, TIME_LENGTH, HALF_LENGTH);
    writeBase32(Id.#low, TIME_LENGTH + HALF_LENGTH, HALF_LENGTH);

    return String.fromCharCode(...codes);
  };

  /**
   * Creates a new id, or wraps an existing one. A malformed string throws a `TypeError`;
   * use `Id.parse` for strings that come from outside the program.
   */
  constructor(value?: string) {
    if (value === undefined) {
      this.#value = Id.#generate();
      return;
    }

    const normalized = value.toUpperCase();

    if (!ID_PATTERN.test(normalized)) {
      throw new TypeError(`Invalid id: ${JSON.stringify(value)}`);
    }

    this.#value = normalized;
  }

  get timestamp(): Date {
    let time = 0;

    for (const char of this.#value.slice(0, TIME_LENGTH)) {
      time = time * BASE + ALPHABET.indexOf(char);
    }

    return new Date(time);
  }

  equals(other: Id | string): boolean {
    return this.#value === (typeof other === 'string' ? other.toUpperCase() : other.toString());
  }

  toString(): string {
    return this.#value;
  }

  toJSON(): string {
    return this.#value;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Id(${this.#value})`;
  }

  static isValid(value: string): boolean {
    return ID_PATTERN.test(value.toUpperCase());
  }

  static parse(value: string): Result<Id, string> {
    // The constructor validates, so parsing checks the string once instead of twice.
    try {
      return ok(new Id(value));
    } catch {
      return err(`Invalid id: ${JSON.stringify(value)}`);
    }
  }
}
