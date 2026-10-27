import { getRandomValues } from 'node:crypto';

import { err, ok } from './result.ts';
import type { Result } from './result.ts';

// Crockford's base32 leaves out I, L, O and U, so an id read aloud or copied by hand stays unambiguous.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const RANDOM_BYTES = 10;
const MAX_RANDOM = (1n << 80n) - 1n;

function encodeBase32(value: bigint, length: number): string {
  let rest = value;
  let output = '';

  for (let index = 0; index < length; index++) {
    output = `${ALPHABET.charAt(Number(rest & 31n))}${output}`;
    rest >>= 5n;
  }

  return output;
}

function randomBits(): bigint {
  const bytes = getRandomValues(new Uint8Array(RANDOM_BYTES));
  let value = 0n;

  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

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
  static #lastRandom = 0n;

  static #generate = (): string => {
    // A clock that moves backwards must not break the ordering, so time never goes below the last id.
    const time = Math.max(Date.now(), Id.#lastTime);

    if (time === Id.#lastTime) {
      if (Id.#lastRandom === MAX_RANDOM) {
        throw new Error('Too many ids in one millisecond: the random part overflowed');
      }

      Id.#lastRandom += 1n;
    } else {
      Id.#lastTime = time;
      Id.#lastRandom = randomBits();
    }

    return `${encodeBase32(BigInt(time), TIME_LENGTH)}${encodeBase32(Id.#lastRandom, RANDOM_LENGTH)}`;
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
      time = time * 32 + ALPHABET.indexOf(char);
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
    if (!Id.isValid(value)) {
      return err(`Invalid id: ${JSON.stringify(value)}`);
    }

    return ok(new Id(value));
  }
}
