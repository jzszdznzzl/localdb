<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/jzszdznzzl/localdb/main/assets/logo-dark.svg">
  <img alt="localdb" src="https://raw.githubusercontent.com/jzszdznzzl/localdb/main/assets/logo-light.svg" width="360">
</picture>

**Typed JSON documents, validated with zod and saved in one file.**
<br>
An embedded document store for Node.js and Bun: no server, no native modules, no SQL.

[![npm](https://img.shields.io/npm/v/@jzszdznzzl/localdb?color=4f46e5&label=npm)](https://www.npmjs.com/package/@jzszdznzzl/localdb)
[![license](https://img.shields.io/badge/license-MIT-0891b2)](./LICENSE)
![node](https://img.shields.io/badge/node-%E2%89%A524-339933?logo=nodedotjs&logoColor=white)
![bun](https://img.shields.io/badge/bun-supported-000000?logo=bun&logoColor=white)
![types](https://img.shields.io/badge/types-included-3178c6?logo=typescript&logoColor=white)
![zod](https://img.shields.io/badge/zod-4-3e67b1?logo=zod&logoColor=white)
![esm](https://img.shields.io/badge/module-ESM%20only-f7df1e)

**English** · [Español](./README.es.md)

</div>

---

## Why localdb?

Bots, CLIs, small servers and desktop tools need to keep data between runs, but running MongoDB or Redis for that is overkill. The usual answer is a JSON file, and that is where the problems start:

- **Every save rewrites the whole file.** Change one field in a database of 100,000 documents and the whole file is written again, freezing the process while it happens.
- **Nothing checks the data.** A typo, a hand edit or an old shape of a document goes straight into your program, typed as if it were valid.
- **Types are lost.** A `Date` comes back as a string, a `Map` as `{}`, and a `BigInt` cannot be saved at all.
- **A crash mid-write can corrupt the file.**

localdb keeps the simplicity of a JSON file and fixes those four problems:

|                                    | Plain JSON file         | SQLite          | MongoDB / Redis       | **localdb**                      |
| ---------------------------------- | ----------------------- | --------------- | --------------------- | -------------------------------- |
| Runs inside your process           | ✅                      | ✅              | ❌ separate server    | ✅                               |
| Saving one change                  | rewrites the whole file | writes one row  | writes one document   | **appends one line**             |
| Data is validated                  | ❌                      | SQL constraints | optional              | **zod, on every write and load** |
| `Date`, `Map`, `BigInt` round-trip | ❌                      | by hand         | partly                | ✅                               |
| Queries                            | plain JS                | SQL             | query language        | **plain TypeScript functions**   |
| Readable file                      | ✅                      | ❌ binary       | managed by the server | ✅ JSON Lines                    |

## Features

- 🛡️ **Validated.** Each collection has a zod schema. Documents are checked on insert, on update and when the file is loaded.
- ⚡ **Fast saves.** A save appends only what changed. Saving one change takes about 2 ms, even with a million documents.
- 🧊 **Safe by default.** Documents are deeply frozen, writes are atomic, a crash never corrupts the file, and expected failures are returned as values instead of thrown.
- 🔍 **Plain queries.** `users.find((user) => user.level > 20)`. No query language to learn, and fully typed.
- 🆔 **Sortable ids.** `Id` holds its creation time and sorts in creation order, like MongoDB's `ObjectId`.
- 🧩 **Rich types.** `Date`, `Map`, `Set`, `BigInt`, `Buffer`, `URL`, `RegExp` and `Id` come back as themselves.
- 🔁 **Transactions.** Several changes apply together, or none of them do.
- 📄 **Readable file.** One JSON object per line, easy to inspect, diff and back up.

## Install

```bash
pnpm add @jzszdznzzl/localdb zod
```

- **zod 4** is a peer dependency, so your schemas and localdb share one copy of it.
- Requires **Node.js 24** or later, or **Bun**. The package is ESM only.

## Quick start

```ts
import { z } from 'zod';

import { LocalDB } from '@jzszdznzzl/localdb';

const User = z.object({
  name: z.string().min(1),
  level: z.number().int(),
  tags: z.array(z.string()).default([]),
});

const db = new LocalDB('data/app.jsonl', { autosave: true });
const users = db.collection('users', User);

const loaded = await db.load();

if (loaded.error) {
  throw new Error(loaded.error.message);
}

const created = users.insert({ name: 'Jxsx', level: 50 });

if (created.error) {
  console.error(created.error.message);
} else {
  users.update(created.data.id, (user) => ({ ...user, level: user.level + 1 }));
}

const veterans = users.find((user) => user.level >= 30);

await db.close();
```

## Benchmarks

localdb compared with [lowdb](https://github.com/typicode/lowdb) 7, a popular JSON file database, doing the same operations on Node.js 24, Linux x64:

| 1,000,000 documents         | localdb    | lowdb       |                |
| --------------------------- | ---------- | ----------- | -------------- |
| Save after one change       | **2.5 ms** | 2.9 s       | ~1,200× faster |
| Find (full scan)            | **18 ms**  | 1.3 s       | ~75× faster    |
| Update many (1% match)      | **47 ms**  | 1.6 s       | ~33× faster    |
| Insert                      | **2.5 s**  | 4.6 s       | 1.8× faster    |
| Longest freeze while saving | **159 ms** | 2.1 s       |                |
| Get by id                   | 0.73 µs    | **0.33 µs** | 2.2× slower    |
| Load                        | 6.1 s      | **2.7 s**   | 2.3× slower    |
| File size                   | **170 MB** | 229 MB      |                |

| 100,000 documents     | localdb    | lowdb      |             |
| --------------------- | ---------- | ---------- | ----------- |
| Save after one change | **2.2 ms** | 174 ms     | ~78× faster |
| Find (full scan)      | **1.6 ms** | 91 ms      | ~57× faster |
| Insert                | **249 ms** | 458 ms     | 1.8× faster |
| Load                  | 517 ms     | **172 ms** | 3× slower   |

lowdb does less work per operation: it does not validate, freeze documents or keep `Date` values. Run the benchmark yourself with `pnpm bench`, or `pnpm bench 100000 --only=localdb` for a quick run.

## When not to use it

localdb keeps every document in memory (about 500 bytes each) and expects a single process to write the file. Reach for SQLite, MongoDB or Redis when:

- the data does not fit comfortably in memory, or grows past a few million documents;
- several processes or machines write the same data;
- you need indexes on fields, joins or complex queries.

## Guide

### Results instead of exceptions

Operations that can fail as part of normal use return a `Result` instead of throwing:

```ts
type Result<T, E> = { data: T; error: null } | { data: null; error: E };
```

The error is a `DbFailure`: `{ code, message, issues }`, where `code` is one of `DbError.NotFound`, `DbError.InvalidDocument` or `DbError.InvalidFile`, and `issues` holds the zod issues when validation failed.

Programming mistakes still throw: using a collection before `load()`, declaring the same collection twice, or storing a value that cannot be saved, such as a function.

### Documents

A stored document is the schema's output plus two fields that localdb owns:

- `id`: an `Id`, created on insert and never changed.
- `updatedAt`: a `Date`, set on every insert and update.

Documents are deeply frozen. To change one, call `update`, which validates the new version and stores it in place of the old one. Values passed as `id` or `updatedAt` are ignored.

### `Id`

`Id` is localdb's equivalent of MongoDB's `ObjectId`: 26 characters of Crockford base32, such as `01JBCX9Q4ZK3T7M2V8N5RWEYHD`. It holds 48 bits of creation time in milliseconds and 80 random bits.

- **Sortable:** ids sort by creation time, and ids made in the same millisecond by one process still sort in order.
- **Readable:** the alphabet leaves out `I`, `L`, `O` and `U`, and parsing ignores case.

```ts
import { Id } from '@jzszdznzzl/localdb';

const id = new Id();
id.timestamp; // Date the id was created
id.equals('01jbcx9q4zk3t7m2v8n5rweyhd'); // compares the string form

const parsed = Id.parse(input); // Result<Id, string>, for strings from outside the program
new Id('not an id'); // throws a TypeError
```

Ids can be stored inside documents to reference other documents. They come back as `Id` instances:

```ts
const Post = z.object({ authorId: z.instanceof(Id), text: z.string() });
```

### Transactions

`db.transaction(fn)` runs a synchronous function and undoes every change it made if it throws. Everything it changed is saved on one line, so a crash keeps all of it or none of it:

```ts
db.transaction(() => {
  wallets.update(from.id, { coins: from.coins - 10 });
  wallets.update(to.id, { coins: to.coins + 10 });
});
```

## API

### `new LocalDB(path, options?)`

| Option     | Default         | Description                                                          |
| ---------- | --------------- | -------------------------------------------------------------------- |
| `autosave` | `false`         | `true` saves 500 ms after a change; `{ delay }` sets the wait in ms. |
| `onError`  | `console.error` | Receives autosave failures. The next change retries the write.       |

| Member                     | Description                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `collection(name, schema)` | Declares a collection. Declare each one once and share it.                                              |
| `load()`                   | Reads the file. A missing file is an empty database. All-or-nothing.                                    |
| `save()`                   | Appends pending changes, or rewrites the file when it has grown too large. Calls run one after another. |
| `compact()`                | Rewrites the file with only the current documents.                                                      |
| `transaction(fn)`          | Runs a synchronous `fn` and undoes its changes if it throws.                                            |
| `close()`                  | Stops autosave, writes pending changes and ends the instance.                                           |
| `path`                     | Absolute path of the file.                                                                              |
| `collections`              | Names of declared collections and of other collections found in the file.                               |
| `hasUnsavedChanges`        | Whether memory differs from the file.                                                                   |

### Collection

| Method                          | Returns                                      |
| ------------------------------- | -------------------------------------------- |
| `insert(value)`                 | `Result<Document, DbFailure>`                |
| `insertMany(values)`            | `Result<Document[], DbFailure>`, all or none |
| `get(id)` / `has(id)`           | `Document \| null` / `boolean`               |
| `find(predicate?)`              | `Document[]`                                 |
| `findOne(predicate)`            | `Document \| null`                           |
| `count(predicate?)` / `size`    | `number`                                     |
| `update(id, change)`            | `Result<Document, DbFailure>`                |
| `updateMany(predicate, change)` | `Result<Document[], DbFailure>`, all or none |
| `remove(id)`                    | `boolean`                                    |
| `removeMany(predicate)`         | `number`                                     |

`change` is either a partial patch (`{ level: 2 }`) or a function that receives the current document and returns the next version. Collections are also iterable: `for (const user of users)`.

## How it stores data

The file is [JSON Lines](https://jsonlines.org): a header, then one operation per line. A save appends only the documents that changed since the last save, so its cost depends on the changes, not on the size of the database:

```jsonl
{"version":2}
{"col":"users","id":"01JBCX9Q4ZK3T7M2V8N5RWEYHD","at":1793112869668,"doc":{"name":"Jxsx","level":50,"tags":[]}}
{"col":"users","id":"01JBCX9Q4ZK3T7M2V8N5RWEYHD","at":1793112870012,"doc":{"name":"Jxsx","level":51,"tags":[]}}
[{"col":"users","id":"01JBCXA0B4…","at":1793112871000,"doc":{…}},{"col":"users","id":"01JBCX9Q4Z…","del":true}]
```

- **Operations:** `doc` holds the document's fields, `at` its `updatedAt` in milliseconds, and `del` marks a removal. Loading replays the lines in order, so the last line for an id wins.
- **One line per save:** when a save writes several operations, they share one line, so a crash either keeps all of them or none. That includes everything a transaction changed.
- **Crashes:** a last line cut short by a crash is ignored on load, and the next save rewrites the file.
- **Compaction:** once the file holds more than twice as many operations as there are live documents (plus 1,000), or a save has over 10,000 changes, the save rewrites the file with only the current documents instead of appending. `compact()` does the same on demand. The rewrite goes to a temporary file that is renamed over the old one, in chunks, so it does not block the process.
- **Large files:** the file is read and written in chunks, so it is never held in memory as one string.
- **Extra types:** `Date`, `Map`, `Set`, `BigInt`, `Buffer`, `Uint8Array`, `URL`, `RegExp`, `Id`, `NaN`, `Infinity` and `undefined` in arrays are saved with a `__type` tag and come back as the same types. Dates are written as epoch milliseconds (`{"__type":"Date","value":1793112869668}`), which is much faster than ISO strings; ISO strings are still accepted when reading. A user object that has its own `__type` key is wrapped, so it is never mistaken for a tag.
- **Undeclared collections:** collections in the file that the program does not declare are kept and written back unchanged.
- **Transforms:** loading validates stored documents with the same schema, so a schema's transforms must accept their own output.

## Migrating from 1.x (`@imjxsx/localdb`)

Version 2 is a rewrite with a different API and file format:

- **Format:** files are JSON Lines instead of BSON.
- **Schemas:** every collection takes a zod schema.
- **Queries:** filters are functions instead of objects.
- **Ids:** documents have an `id` (`Id`) instead of `__uuid`, and `createdAt` is replaced by `id.timestamp`.
- **Names:** collection names are used as given, without lowercasing or adding an `s`.

## Contributing

Setup, scripts and workflow are in [CONTRIBUTING.md](./CONTRIBUTING.md). The coding rules, for humans and AI assistants alike, are in [AGENTS.md](./AGENTS.md).

## License

[MIT](./LICENSE) © José Daniel Cristaldo Vera
