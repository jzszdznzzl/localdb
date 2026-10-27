import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decode, encode } from '../codec.ts';
import { Id } from '../id.ts';

const roundTrip = (value: unknown): unknown => {
  const decoded = decode(JSON.parse(JSON.stringify(encode(value))));

  assert.equal(decoded.error, null);

  return decoded.data;
};

test('JSON values pass through untouched', () => {
  const value = { text: 'hi', count: 3, isOn: true, nothing: null, list: [1, 'two', [3]] };

  assert.deepEqual(encode(value), value);
  assert.deepEqual(roundTrip(value), value);
});

test('types JSON cannot hold survive a round trip', () => {
  const id = new Id();
  const value = {
    id,
    date: new Date('2026-01-02T03:04:05.678Z'),
    big: 12345678901234567890n,
    negativeBig: -5n,
    nan: Number.NaN,
    infinity: Number.POSITIVE_INFINITY,
    negativeInfinity: Number.NEGATIVE_INFINITY,
    regex: /a+b/gi,
    url: new URL('https://example.com/path?q=1'),
    map: new Map<unknown, unknown>([
      ['a', 1],
      [2, new Date(0)],
    ]),
    set: new Set([1, 'x', 2n]),
    buffer: Buffer.from('hello'),
    bytes: new Uint8Array([1, 2, 255]),
    holes: [1, undefined, 3],
  };

  const decoded = roundTrip(value);

  assert.deepEqual(decoded, value);
  assert.ok(Buffer.isBuffer(Reflect.get(Object(decoded), 'buffer')));
  assert.ok(!Buffer.isBuffer(Reflect.get(Object(decoded), 'bytes')));
});

test('undefined object properties are dropped', () => {
  assert.deepEqual(encode({ kept: 1, dropped: undefined }), { kept: 1 });
});

test('a user object that owns the tag key reads back as the same object', () => {
  const value = { __type: 'Date', value: 'not a tag', nested: { __type: 'Map' } };

  assert.deepEqual(roundTrip(value), value);
});

test('values that cannot be stored throw a TypeError', () => {
  class Point {
    x = 1;
  }

  for (const value of [
    () => 1,
    Symbol('s'),
    new Point(),
    new Date(Number.NaN),
    new Int16Array(2),
  ]) {
    assert.throws(() => encode({ value }), TypeError);
  }
});

test('malformed tags are reported, not thrown', () => {
  for (const value of [
    { __type: 'Nope' },
    { __type: 'Date', value: 'yesterday' },
    { __type: 'BigInt', value: '1.5' },
    { __type: 'Id', value: 'abc' },
    { __type: 'Set', value: [], extra: true },
    { __type: 'RegExp', source: 'a', flags: 'zz' },
    { list: [{ __type: 'URL', value: 'not a url' }] },
  ]) {
    assert.notEqual(decode(value).error, null, JSON.stringify(value));
  }
});
