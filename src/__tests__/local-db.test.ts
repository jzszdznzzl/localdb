import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

import { DbError } from '../errors.ts';
import { Id } from '../id.ts';
import { LocalDB } from '../local-db.ts';
import { openUsers, tempFile, unwrap, User } from './fixtures.ts';

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));

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

test('the file is readable JSON keyed by id, without repeating the id', async () => {
  const { db, users } = await openUsers();
  const user = unwrap(users.insert({ name: 'a', level: 1 }));
  await db.save();

  assert.deepEqual(await readJson(db.path), {
    version: 1,
    collections: {
      users: {
        [user.id.toString()]: {
          name: 'a',
          level: 1,
          tags: [],
          updatedAt: { __type: 'Date', value: user.updatedAt.toISOString() },
        },
      },
    },
  });
});

test('a missing file loads empty, and the first save creates it with its folder', async () => {
  const path = join(dirname(await tempFile()), 'nested', 'db.json');
  const { db } = await openUsers(path);

  assert.equal(db.hasUnsavedChanges, true);
  await db.save();
  assert.deepEqual(await readJson(path), { version: 1, collections: { users: {} } });
  assert.equal(db.hasUnsavedChanges, false);
});

test('saving leaves no temporary files behind', async () => {
  const { db, users } = await openUsers();
  unwrap(users.insert({ name: 'a', level: 1 }));
  await Promise.all([db.save(), db.save(), db.save()]);

  assert.deepEqual(await readdir(dirname(db.path)), ['db.json']);
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

  for (const contents of ['{ nope', '{"version":2,"collections":{}}', '[]']) {
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
  await writeFile(
    db.path,
    JSON.stringify({
      version: 1,
      collections: {
        users: { [id]: { name: '', level: 1, updatedAt: { __type: 'Date', value: '2026-01-01' } } },
      },
    }),
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

  const stored = await readJson(db.path);
  assert.equal(
    Object.keys(
      z
        .object({ collections: z.object({ users: z.record(z.string(), z.unknown()) }) })
        .parse(stored).collections.users,
    ).length,
    5,
  );
});

test('autosave failures go to onError and are retried', async () => {
  const errors: unknown[] = [];
  const path = join(await tempFile(), 'db.json');
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
