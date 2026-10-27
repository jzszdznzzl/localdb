import assert from 'node:assert/strict';
import { appendFile, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

import { DbError } from '../errors.ts';
import { Id } from '../id.ts';
import { LocalDB } from '../local-db.ts';
import { openUsers, tempFile, unwrap, User } from './fixtures.ts';

const readLines = async (path: string): Promise<unknown[]> =>
  (await readFile(path, 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));

const header = { version: 2 };

test('documents survive a save and a fresh load, with their types', async () => {
  const path = await tempFile();
  const Post = z.object({ authorId: z.instanceof(Id), at: z.date(), views: z.bigint() });
  const first = await openUsers(path);
  const posts = first.db.collection('posts', Post);
  const user = unwrap(first.users.insert({ name: 'Jxsx', level: 50, tags: ['admin'] }));
  unwrap(posts.insert({ authorId: user.id, at: new Date(1000), views: 10n }));
  await first.db.save();

  const second = await openUsers(path);
  const reloadedPosts = second.db.collection('posts', Post);
  const reloaded = second.users.get(user.id);
  const [post] = reloadedPosts.find();

  assert.deepEqual(reloaded, user);
  assert.ok(post?.authorId.equals(user.id));
  assert.deepEqual(post?.at, new Date(1000));
  assert.equal(post?.views, 10n);
});

test('the file is a header followed by one JSON line per operation', async () => {
  const { db, users } = await openUsers();
  const user = unwrap(users.insert({ name: 'a', level: 1 }));
  await db.save();

  assert.deepEqual(await readLines(db.path), [
    header,
    {
      col: 'users',
      id: user.id.toString(),
      at: user.updatedAt.getTime(),
      doc: { name: 'a', level: 1, tags: [] },
    },
  ]);
});

test('a missing file loads empty, and the first save creates it with its folder', async () => {
  const path = join(dirname(await tempFile()), 'nested', 'db.jsonl');
  const { db } = await openUsers(path);

  assert.equal(db.hasUnsavedChanges, true);
  await db.save();
  assert.deepEqual(await readLines(path), [header]);
  assert.equal(db.hasUnsavedChanges, false);
});

test('a save appends only what changed since the last one', async () => {
  const { db, users } = await openUsers();
  const [first, second] = unwrap(
    users.insertMany([
      { name: 'a', level: 1 },
      { name: 'b', level: 2 },
    ]),
  );
  assert.ok(first && second);
  await db.save();
  const sizeAfterInsert = (await stat(db.path)).size;

  unwrap(users.update(first.id, { level: 5 }));
  unwrap(users.update(first.id, { level: 6 }));
  await db.save();
  users.remove(second.id);
  await db.save();
  await db.save();

  const lines = await readLines(db.path);
  assert.equal(lines.length, 5);
  assert.deepEqual(lines.at(-2), {
    col: 'users',
    id: first.id.toString(),
    at: users.get(first.id)?.updatedAt.getTime(),
    doc: { name: 'a', level: 6, tags: [] },
  });
  assert.deepEqual(lines.at(-1), { col: 'users', id: second.id.toString(), del: true });
  assert.ok((await stat(db.path)).size > sizeAfterInsert);

  const reloaded = await openUsers(db.path);
  assert.deepEqual(reloaded.users.find(), users.find());
});

test('changes saved together share one line, so they load together or not at all', async () => {
  const { db, users } = await openUsers();
  await db.save();

  db.transaction(() => {
    unwrap(users.insert({ name: 'a', level: 1 }));
    unwrap(users.insert({ name: 'b', level: 2 }));
  });
  await db.save();

  const lines = await readLines(db.path);
  assert.equal(lines.length, 2);
  assert.ok(Array.isArray(lines[1]));
  assert.equal(Array.isArray(lines[1]) ? lines[1].length : 0, 2);
});

test('a line cut short by a crash is ignored, and the next save rewrites the file', async () => {
  const { db, users } = await openUsers();
  const user = unwrap(users.insert({ name: 'a', level: 1 }));
  await db.save();
  await appendFile(db.path, '{"col":"users","id":"01');

  const reloaded = await openUsers(db.path);
  assert.deepEqual(reloaded.users.find(), [user]);
  assert.equal(reloaded.db.hasUnsavedChanges, true);

  await reloaded.db.save();
  assert.equal((await readLines(db.path)).length, 2);
});

test('compact() keeps only the current version of each document', async () => {
  const { db, users } = await openUsers();
  const user = unwrap(users.insert({ name: 'a', level: 1 }));
  await db.save();

  for (let level = 2; level <= 5; level++) {
    unwrap(users.update(user.id, { level }));
    await db.save();
  }

  unwrap(users.insert({ name: 'b', level: 1 }));
  users.remove(unwrap(users.insert({ name: 'gone', level: 1 })).id);
  await db.save();
  assert.equal((await readLines(db.path)).length, 7);

  await db.compact();
  assert.equal((await readLines(db.path)).length, 3);
  assert.deepEqual((await openUsers(db.path)).users.find(), users.find());
});

test('the file is rewritten on its own once old versions pile up', async () => {
  const { db, users } = await openUsers();
  const user = unwrap(users.insert({ name: 'a', level: 1 }));
  await db.save();

  for (let level = 0; level < 1100; level++) {
    unwrap(users.update(user.id, { level }));
    await db.save();
  }

  assert.ok((await readLines(db.path)).length < 1100);
  assert.equal((await openUsers(db.path)).users.get(user.id)?.level, 1099);
});

test('a large batch of changes is saved as a rewrite instead of one huge line', async () => {
  const { db, users } = await openUsers();
  await db.save();
  unwrap(users.insertMany(Array.from({ length: 10_001 }, (_, level) => ({ name: 'a', level }))));
  await db.save();

  const lines = await readLines(db.path);
  assert.equal(lines.length, 10_002);
  assert.ok(lines.every((line) => !Array.isArray(line)));
});

test('saving leaves no temporary files behind', async () => {
  const { db, users } = await openUsers();
  unwrap(users.insert({ name: 'a', level: 1 }));
  await Promise.all([db.save(), db.save(), db.save()]);

  assert.deepEqual(await readdir(dirname(db.path)), ['db.jsonl']);
});

test('collections this program does not declare are kept on save', async () => {
  const path = await tempFile();
  const first = await openUsers(path);
  const Note = z.object({ text: z.string() });
  unwrap(first.db.collection('notes', Note).insert({ text: 'keep me' }));
  await first.db.save();

  const second = await openUsers(path);
  unwrap(second.users.insert({ name: 'a', level: 1 }));
  await second.db.save();

  assert.deepEqual(second.db.collections, ['users', 'notes']);
  const third = new LocalDB(path);
  const notes = third.collection('notes', Note);
  unwrap(await third.load());
  assert.equal(notes.findOne(() => true)?.text, 'keep me');
});

test('declaring a collection after load validates what is stored', async () => {
  const path = await tempFile();
  const first = await openUsers(path);
  unwrap(first.users.insert({ name: 'a', level: 1 }));
  await first.db.save();

  const db = new LocalDB(path);
  unwrap(await db.load());
  assert.equal(db.collection('users', User).size, 1);

  const strict = new LocalDB(path);
  unwrap(await strict.load());
  assert.throws(() => strict.collection('users', z.object({ email: z.email() })), /email/);
});

test('a broken file is reported and leaves memory untouched', async () => {
  const { db, users } = await openUsers();
  unwrap(users.insert({ name: 'a', level: 1 }));
  const id = new Id().toString();

  for (const contents of [
    '{ nope',
    '{"version":1,"collections":{}}',
    '[]',
    `{"version":2}\n{ nope\n{"col":"users","id":"${id}","del":true}\n`,
    `{"version":2}\n{"col":"users","id":"${id}","doc":{}}\n`,
  ]) {
    await writeFile(db.path, contents);
    const result = await db.load();

    assert.equal(result.error?.code, DbError.InvalidFile, contents);
    assert.equal(users.size, 1);
  }
});

test('an invalid stored document fails the whole load', async () => {
  const { db, users } = await openUsers();
  unwrap(users.insert({ name: 'a', level: 1 }));
  await db.save();
  const id = new Id().toString();
  await appendFile(
    db.path,
    `${JSON.stringify({ col: 'users', id, at: 0, doc: { name: '', level: 1 } })}\n`,
  );

  const result = await db.load();

  assert.equal(result.error?.code, DbError.InvalidDocument);
  assert.match(result.error?.message ?? '', new RegExp(`users/${id}`));
  assert.equal(users.size, 1);
});

test('a collection cannot be declared twice', async () => {
  const { db } = await openUsers();

  assert.throws(() => db.collection('users', User), /already declared/);
});

test('save() before load() throws instead of overwriting the file', () => {
  assert.throws(() => new LocalDB('unused.json').save(), /not loaded/);
});

test('autosave writes once after a burst of changes', async () => {
  const { db, users } = await openUsers(undefined, { autosave: { delay: 20 } });

  for (let level = 0; level < 5; level++) {
    unwrap(users.insert({ name: 'a', level }));
  }

  assert.equal(db.hasUnsavedChanges, true);
  await sleep(80);
  assert.equal(db.hasUnsavedChanges, false);

  assert.equal((await readLines(db.path)).length, 6);
});

test('autosave failures go to onError and are retried', async () => {
  const errors: unknown[] = [];
  const path = join(await tempFile(), 'db.jsonl');
  const { users, db } = await openUsers(path, {
    autosave: { delay: 5 },
    onError: (error) => errors.push(error),
  });
  // The parent of `path` becomes a file, so every write fails.
  await writeFile(dirname(path), '');

  unwrap(users.insert({ name: 'a', level: 1 }));
  await sleep(40);

  assert.equal(errors.length, 1);
  assert.equal(db.hasUnsavedChanges, true);
});

test('a transaction that throws undoes all of its changes', async () => {
  const { db, users } = await openUsers();
  const kept = unwrap(users.insert({ name: 'kept', level: 1 }));

  assert.throws(
    () =>
      db.transaction(() => {
        unwrap(users.insert({ name: 'new', level: 2 }));
        unwrap(users.update(kept.id, { level: 99 }));
        users.remove(kept.id);
        throw new Error('boom');
      }),
    /boom/,
  );

  assert.deepEqual(users.find(), [kept]);
  assert.equal(db.transaction(() => unwrap(users.insert({ name: 'b', level: 3 }))).name, 'b');
  assert.equal(users.size, 2);
});

test('an async transaction is rejected and rolled back', async () => {
  const { db, users } = await openUsers();

  assert.throws(
    () =>
      db.transaction(async () => {
        unwrap(users.insert({ name: 'a', level: 1 }));
      }),
    TypeError,
  );
  assert.equal(users.size, 0);
});

test('close() writes pending changes and ends the instance', async () => {
  const path = await tempFile();
  const { db, users } = await openUsers(path, { autosave: { delay: 10_000 } });
  unwrap(users.insert({ name: 'a', level: 1 }));
  await db.close();

  assert.throws(() => users.find(), /closed/);
  assert.equal((await openUsers(path)).users.size, 1);
});
