import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DbError } from '../errors.ts';
import { Id } from '../id.ts';
import { LocalDB } from '../local-db.ts';
import { openUsers, unwrap, User } from './fixtures.ts';

test('insert validates, applies defaults and adds id and updatedAt', async () => {
  const { users } = await openUsers();
  const user = unwrap(users.insert({ name: 'Jxsx', level: 50 }));

  assert.ok(user.id instanceof Id);
  assert.ok(user.updatedAt instanceof Date);
  assert.deepEqual(user.tags, []);
  assert.equal(users.get(user.id), user);
  assert.equal(users.get(user.id.toString().toLowerCase()), user);
});

test('an invalid insert returns an error with zod issues and stores nothing', async () => {
  const { users } = await openUsers();
  const result = users.insert({ name: '', level: 1.5 });

  assert.equal(result.error?.code, DbError.InvalidDocument);
  assert.equal(result.error?.issues.length, 2);
  assert.equal(users.size, 0);
});

test('insert ignores id and updatedAt passed by the caller', async () => {
  const { users } = await openUsers();
  const fake = new Id();
  const user = unwrap(
    users.insert({ name: 'a', level: 1, ...{ id: fake, updatedAt: new Date(0) } }),
  );

  assert.equal(user.id.equals(fake), false);
  assert.notEqual(user.updatedAt.getTime(), 0);
});

test('insertMany is all-or-nothing', async () => {
  const { users } = await openUsers();
  const failed = users.insertMany([
    { name: 'a', level: 1 },
    { name: '', level: 2 },
  ]);

  assert.equal(failed.error?.code, DbError.InvalidDocument);
  assert.equal(users.size, 0);
  assert.equal(
    unwrap(
      users.insertMany([
        { name: 'a', level: 1 },
        { name: 'b', level: 2 },
      ]),
    ).length,
    2,
  );
});

test('documents are deeply frozen', async () => {
  const { users } = await openUsers();
  const user = unwrap(users.insert({ name: 'a', level: 1, tags: ['x'] }));

  assert.equal(Reflect.set(user, 'level', 2), false);
  assert.ok(Object.isFrozen(user.tags));
  assert.equal(users.get(user.id)?.level, 1);
});

test('find, findOne and count take plain predicates', async () => {
  const { users } = await openUsers();
  unwrap(
    users.insertMany([
      { name: 'a', level: 10 },
      { name: 'b', level: 20 },
      { name: 'c', level: 30 },
    ]),
  );

  assert.deepEqual(
    users.find((user) => user.level >= 20).map((user) => user.name),
    ['b', 'c'],
  );
  assert.equal(users.findOne((user) => user.name === 'c')?.level, 30);
  assert.equal(
    users.findOne((user) => user.name === 'z'),
    null,
  );
  assert.equal(users.count(), 3);
  assert.equal(
    users.count((user) => user.level < 25),
    2,
  );
  assert.deepEqual(
    [...users].map((user) => user.name),
    ['a', 'b', 'c'],
  );
});

test('update merges a patch or applies a function, keeping the id', async () => {
  const { users } = await openUsers();
  const user = unwrap(users.insert({ name: 'a', level: 1 }));

  const patched = unwrap(users.update(user.id, { level: 2 }));
  assert.equal(patched.level, 2);
  assert.equal(patched.name, 'a');
  assert.ok(patched.id.equals(user.id));

  const changed = unwrap(
    users.update(user.id, (current) => ({ ...current, level: current.level * 10 })),
  );
  assert.equal(changed.level, 20);
  assert.equal(users.get(user.id), changed);
});

test('update reports a missing id or an invalid result without changing anything', async () => {
  const { users } = await openUsers();
  const user = unwrap(users.insert({ name: 'a', level: 1 }));

  assert.equal(users.update(new Id(), { level: 2 }).error?.code, DbError.NotFound);
  assert.equal(users.update(user.id, { level: 0.5 }).error?.code, DbError.InvalidDocument);
  assert.equal(users.get(user.id), user);
});

test('updateMany is all-or-nothing', async () => {
  const { users } = await openUsers();
  unwrap(
    users.insertMany([
      { name: 'a', level: 1 },
      { name: 'b', level: 2 },
    ]),
  );

  const failed = users.updateMany(
    () => true,
    (user) => ({ ...user, name: user.name === 'b' ? '' : user.name }),
  );
  assert.equal(failed.error?.code, DbError.InvalidDocument);
  assert.deepEqual(
    users.find().map((user) => user.name),
    ['a', 'b'],
  );

  assert.equal(unwrap(users.updateMany((user) => user.level > 1, { level: 5 })).length, 1);
  assert.equal(users.findOne((user) => user.name === 'b')?.level, 5);
});

test('remove and removeMany', async () => {
  const { users } = await openUsers();
  const [first] = unwrap(
    users.insertMany([
      { name: 'a', level: 1 },
      { name: 'b', level: 2 },
      { name: 'c', level: 3 },
    ]),
  );

  assert.ok(first);
  assert.equal(users.remove(first.id), true);
  assert.equal(users.remove(first.id), false);
  assert.equal(users.has(first.id), false);
  assert.equal(
    users.removeMany((user) => user.level >= 2),
    2,
  );
  assert.equal(users.size, 0);
});

test('a collection cannot be used before load()', () => {
  const users = new LocalDB('unused.json').collection('users', User);

  assert.throws(() => users.find(), /not loaded/);
});
