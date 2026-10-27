# Changelog

## 2.0.0

A rewrite, published under a new name: `@jzszdznzzl/localdb` replaces `@imjxsx/localdb`.

### Added

- `LocalDB` class: `new LocalDB(path, options)`, with `collection()`, `load()`, `save()`, `compact()`, `transaction()` and `close()`.
- A zod schema per collection, checked on insert, on update and when the file is loaded.
- `Id` class: sortable 26-character ids in Crockford base32 that hold their creation time.
- `Result` return values with `DbError` codes for expected failures.
- Deeply frozen documents, with `id` and `updatedAt` managed by the store.
- Autosave that groups bursts of changes into one write, with an `onError` hook.
- Synchronous transactions that undo their changes when they throw.

### Changed

- **Breaking:** data is stored as an append-only JSON Lines file instead of BSON. A save appends only what changed, and the file is compacted automatically.
- **Breaking:** queries are plain functions (`find((user) => user.level > 20)`) instead of filter objects.
- **Breaking:** collection names are used as given, without lowercasing or pluralizing.
- **Breaking:** requires Node.js 24 or later, or Bun, and zod 4 as a peer dependency.

### Fixed

- Errors while loading or saving are no longer silently ignored.
- A crash during a save no longer corrupts the file.
