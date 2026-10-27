# @jzszdznzzl/localdb

A typed document store in a single JSON Lines file, for Node.js and Bun.

Each collection is described by a [zod](https://zod.dev) schema, so every document is validated when it is written and again when the file is loaded. Queries are plain TypeScript functions, saves only write what changed, and the file stays readable.

Good for bots, CLIs, small servers and desktop tools: anything that needs to keep data between runs without running a database server.

```bash
pnpm add @jzszdznzzl/localdb zod
```

zod 4 is a peer dependency, so your schemas and localdb share one copy of it.

Requires Node.js 24 or later, or Bun. The package is ESM only.

## Example

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

## Results instead of exceptions

Operations that can fail as part of normal use return a `Result` instead of throwing:

```ts
type Result<T, E> = { data: T; error: null } | { data: null; error: E };
```

The error is a `DbFailure`: `{ code, message, issues }`, where `code` is one of `DbError.NotFound`, `DbError.InvalidDocument` or `DbError.InvalidFile`, and `issues` holds the zod issues when validation failed.

Programming mistakes still throw: using a collection before `load()`, declaring the same collection twice, or storing a value that cannot be saved, such as a function.

## Documents

A stored document is the schema's output plus two fields that localdb owns:

- `id`: an `Id`, created on insert and never changed.
- `updatedAt`: a `Date`, set on every insert and update.

Documents are deeply frozen. To change one, call `update`, which validates the new version and stores it in place of the old one. Values passed as `id` or `updatedAt` are ignored.

## `Id`

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

## Storage

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
- **Large files:** the file is read line by line and written in chunks, so it is never held in memory as one string.
- **Extra types:** `Date`, `Map`, `Set`, `BigInt`, `Buffer`, `Uint8Array`, `URL`, `RegExp`, `Id`, `NaN`, `Infinity` and `undefined` in arrays are saved with a `__type` tag and come back as the same types. A user object that has its own `__type` key is wrapped, so it is never mistaken for a tag.
- **Undeclared collections:** collections in the file that the program does not declare are kept and written back unchanged.
- **Transforms:** loading validates stored documents with the same schema, so a schema's transforms must accept their own output.

## Migrating from 1.x (`@imjxsx/localdb`)

Version 2 is a rewrite with a different API and file format:

- **Format:** files are JSON Lines instead of BSON.
- **Schemas:** every collection takes a zod schema.
- **Queries:** filters are functions instead of objects.
- **Ids:** documents have an `id` (`Id`) instead of `__uuid`, and `createdAt` is replaced by `id.timestamp`.
- **Names:** collection names are used as given, without lowercasing or adding an `s`.

## License

[MIT](./LICENSE)
