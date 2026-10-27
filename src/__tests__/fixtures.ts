import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { z } from 'zod';

import { LocalDB } from '../local-db.ts';
import type { LocalDBOptions } from '../local-db.ts';
import type { Result } from '../result.ts';

export const User = z.object({
  name: z.string().min(1),
  level: z.number().int(),
  tags: z.array(z.string()).default([]),
});

export type User = z.infer<typeof User>;

// A generic `E` is not a discriminant, so `result.error === null` alone does not narrow `result`.
function isOk<T, E>(result: Result<T, E>): result is { data: T; error: null } {
  return result.error === null;
}

export async function tempFile(name = 'db.jsonl'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'localdb-'));

  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return join(directory, name);
}

export async function openUsers(path?: string, options?: LocalDBOptions) {
  const db = new LocalDB(path ?? (await tempFile()), options);
  const users = db.collection('users', User);

  unwrap(await db.load());

  return { db, users };
}

export function unwrap<T, E>(result: Result<T, E>): T {
  if (isOk(result)) {
    return result.data;
  }

  throw new Error(`Expected success, got ${JSON.stringify(result.error)}`);
}
