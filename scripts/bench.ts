import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';

import { LocalDB } from '../src/index.ts';
import type { Id } from '../src/index.ts';

interface Row {
  operation: string;
  count: number;
  ms: number;
}

const User = z.object({
  name: z.string().min(1),
  level: z.number().int(),
  tags: z.array(z.string()),
  joinedAt: z.date(),
});

const DEFAULT_SIZES = [10_000, 100_000, 1_000_000];
const SCANS = 10;
const MB = 1024 * 1024;

const formatNumber = (value: number): string => Math.round(value).toLocaleString('en-US');

const collectGarbage = (): void => {
  // Only available with --expose-gc; without it the memory numbers include garbage.
  globalThis.gc?.();
};

function time<T>(rows: Row[], operation: string, count: number, fn: () => T): T {
  const start = performance.now();
  const result = fn();
  rows.push({ operation, count, ms: performance.now() - start });

  return result;
}

async function timeAsync<T>(
  rows: Row[],
  operation: string,
  count: number,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  const result = await fn();
  rows.push({ operation, count, ms: performance.now() - start });

  return result;
}

function printRows(rows: readonly Row[]): void {
  const lines = rows.map((row) => {
    const perSecond = row.ms > 0 ? (row.count / row.ms) * 1000 : Number.POSITIVE_INFINITY;

    return [
      row.operation.padEnd(28),
      formatNumber(row.count).padStart(11),
      `${row.ms.toFixed(1)} ms`.padStart(12),
      `${formatNumber(perSecond)} ops/s`.padStart(18),
    ].join(' ');
  });

  console.log(lines.join('\n'));
}

async function runStage(size: number): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'localdb-bench-'));
  const path = join(directory, 'bench.json');
  const rows: Row[] = [];

  try {
    collectGarbage();
    const heapBefore = process.memoryUsage().heapUsed;

    const db = new LocalDB(path);
    const users = db.collection('users', User);
    await db.load();

    const ids: Id[] = time(rows, 'insert', size, () => {
      const created: Id[] = [];

      for (let index = 0; index < size; index++) {
        const result = users.insert({
          name: `user-${index}`,
          level: index % 100,
          tags: index % 2 === 0 ? ['even'] : ['odd', 'vip'],
          joinedAt: new Date(1_700_000_000_000 + index),
        });

        if (result.error !== null) {
          throw new Error(result.error.message);
        }

        created.push(result.data.id);
      }

      return created;
    });

    collectGarbage();
    const heapAfter = process.memoryUsage().heapUsed;

    time(rows, 'get by id (random)', size, () => {
      let found = 0;

      for (let index = 0; index < size; index++) {
        const id = ids[Math.floor(Math.random() * ids.length)];

        if (id && users.get(id)) {
          found++;
        }
      }

      return found;
    });

    time(rows, `find, full scan x${SCANS}`, size * SCANS, () => {
      let matches = 0;

      for (let scan = 0; scan < SCANS; scan++) {
        matches += users.find((user) => user.level === scan).length;
      }

      return matches;
    });

    const updates = Math.ceil(size / 10);

    time(rows, 'update by id (patch)', updates, () => {
      for (let index = 0; index < updates; index++) {
        const id = ids[index];

        if (id) {
          users.update(id, { level: 1000 });
        }
      }
    });

    time(rows, 'updateMany (1% match)', size, () =>
      users.updateMany((user) => user.level === 50, { level: 51 }),
    );

    await timeAsync(rows, 'save (full file)', size, () => db.save());
    const fileSize = (await stat(path)).size;

    const reopened = new LocalDB(path);
    const reloadedUsers = reopened.collection('users', User);
    await timeAsync(rows, 'load (parse + validate)', size, () => reopened.load());

    if (reloadedUsers.size !== size) {
      throw new Error(`Expected ${size} documents after load, found ${reloadedUsers.size}`);
    }

    const removals = Math.ceil(size / 10);

    time(rows, 'remove by id', removals, () => {
      for (let index = 0; index < removals; index++) {
        const id = ids[index];

        if (id) {
          users.remove(id);
        }
      }
    });

    const saves = 5;
    await timeAsync(rows, `save after 1 change x${saves}`, saves, async () => {
      for (let index = 0; index < saves; index++) {
        const id = ids[removals + index];

        if (id) {
          users.update(id, { level: index });
        }

        await db.save();
      }
    });

    console.log(`\n=== ${formatNumber(size)} documents ===`);
    printRows(rows);
    console.log(
      [
        `file size: ${(fileSize / MB).toFixed(1)} MB`,
        `heap for documents: ${((heapAfter - heapBefore) / MB).toFixed(1)} MB (~${formatNumber((heapAfter - heapBefore) / size)} bytes each)`,
        `rss: ${(process.memoryUsage().rss / MB).toFixed(0)} MB`,
      ].join('\n'),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const sizes = process.argv
  .slice(2)
  .map(Number)
  .filter((value) => Number.isInteger(value) && value > 0);

console.log(`node ${process.version}, ${process.platform}/${process.arch}`);

for (const size of sizes.length > 0 ? sizes : DEFAULT_SIZES) {
  await runStage(size);
}
