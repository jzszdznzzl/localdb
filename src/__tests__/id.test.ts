import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { test } from 'node:test';

import { Id } from '../id.ts';

test('a new id is 26 characters of Crockford base32', () => {
  const id = new Id();

  assert.match(id.toString(), /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  assert.equal(Id.isValid(id.toString()), true);
});

test('the timestamp is the creation time', () => {
  const before = Date.now();
  const id = new Id();
  const after = Date.now();

  assert.ok(id.timestamp.getTime() >= before && id.timestamp.getTime() <= after);
});

test('ids sort in creation order, even within one millisecond', () => {
  const ids = Array.from({ length: 2000 }, () => new Id().toString());

  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids).size, ids.length);
});

test('parse accepts any case and rejects malformed strings', () => {
  const id = new Id();
  const parsed = Id.parse(id.toString().toLowerCase());

  assert.equal(parsed.error, null);
  assert.equal(parsed.data?.equals(id), true);

  for (const bad of [
    '',
    'abc',
    `${id.toString()}0`,
    '8ZZZZZZZZZZZZZZZZZZZZZZZZZ',
    'O'.repeat(26),
  ]) {
    assert.notEqual(Id.parse(bad).error, null, bad);
  }
});

test('the constructor throws on a malformed string', () => {
  assert.throws(() => new Id('nope'), TypeError);
});

test('equals, JSON and inspect use the string form', () => {
  const id = new Id();

  assert.equal(id.equals(id.toString()), true);
  assert.equal(id.equals(new Id(id.toString())), true);
  assert.equal(id.equals(new Id()), false);
  assert.equal(JSON.stringify({ id }), `{"id":"${id.toString()}"}`);
  assert.equal(inspect(id), `Id(${id.toString()})`);
});
