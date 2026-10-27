import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { JSONFilePreset } from 'lowdb/node';
import { z } from 'zod';

import { LocalDB } from '../src/index.ts';

interface UserInput {
  name: string;
  level: number;
  tags: string[];
  joinedAt: Date;
}

/** The same operations, implemented the way each package is meant to be used. */
interface BenchStore {
  insert(user: UserInput): string;
  has(id: string): boolean;
  countLevel(level: number): number;
  setLevel(id: string, level: number): void;
  setLevelWhere(from: number, to: number): void;
  remove(id: string): void;
  save(): Promise<void>;
  compact: (() => Promise<void>) | null;
}

interface Contender {
  name: string;
  fileName: string;
  open(path: string): Promise<BenchStore>;
  /** Opens the file in a fresh instance and returns how many users it holds. */
  reload(path: string): Promise<number>;
}

interface StageResult {
  timings: Map<string, { count: number; ms: number }>;
  fileSize: number;
  heapPerDocument: number;
  fullSaveBlock: number;
  smallSaveBlock: number;
}

// lowdb keeps plain JSON, so dates are stored and read back as ISO strings.
interface LowUser {
  name: string;
  level: number;
  tags: string[];
  joinedAt: string;
  updatedAt: string;
}

interface LowData {
  users: Record<string, LowUser>;
}

const User = z.object({
  name: z.string().min(1),
  level: z.number().int(),
  tags: z.array(z.string()),
  joinedAt: z.date(),
});

const DEFAULT_SIZES = [10_000, 100_000, 1_000_000];
const SCANS = 10;
const SMALL_SAVES = 5;
const MB = 1024 * 1024;
const NAME_WIDTH = 30;
const CELL_WIDTH = 14;

const localdb: Contender = {
  name: 'localdb',
  fileName: 'bench.jsonl',
  open: async (path) => {
    const db = new LocalDB(path);
    const users = db.collection('users', User);
    const loaded = await db.load();

    if (loaded.error !== null) {
      throw new Error(loaded.error.message);
    }

    return {
      insert: (user) => {
        const result = users.insert(user);

        if (result.error !== null) {
          throw new Error(result.error.message);
        }

        return result.data.id.toString();
      },
      has: (id) => users.get(id) !== null,
      countLevel: (level) => users.find((user) => user.level === level).length,
      setLevel: (id, level) => {
        users.update(id, { level });
      },
      setLevelWhere: (from, to) => {
        users.updateMany((user) => user.level === from, { level: to });
      },
      remove: (id) => {
        users.remove(id);
      },
      save: () => db.save(),
      compact: () => db.compact(),
    };
  },
  reload: async (path) => {
    const db = new LocalDB(path);
    const users = db.collection('users', User);
    await db.load();

    return users.size;
  },
};

const lowdb: Contender = {
  name: 'lowdb',
  fileName: 'bench.json',
  open: async (path) => {
    const db = await JSONFilePreset<LowData>(path, { users: {} });

    return {
      insert: (user) => {
        const id = randomUUID();
        db.data.users[id] = {
          ...user,
          joinedAt: user.joinedAt.toISOString(),
          updatedAt: new Date().toISOString(),
        };

        return id;
      },
      has: (id) => Object.hasOwn(db.data.users, id),
      countLevel: (level) =>
        Object.values(db.data.users).filter((user) => user.level === level).length,
      setLevel: (id, level) => {
        const user = db.data.users[id];

        if (user) {
          user.level = level;
          user.updatedAt = new Date().toISOString();
        }
      },
      setLevelWhere: (from, to) => {
        const now = new Date().toISOString();

        for (const user of Object.values(db.data.users)) {
          if (user.level === from) {
            user.level = to;
            user.updatedAt = now;
          }
        }
      },
      remove: (id) => {
        delete db.data.users[id];
      },
      save: () => db.write(),
      compact: null,
    };
  },
  reload: async (path) => {
    const db = await JSONFilePreset<LowData>(path, { users: {} });

    return Object.keys(db.data.users).length;
  },
};

const contenders: readonly Contender[] = [localdb, lowdb];

const formatNumber = (value: number): string => Math.round(value).toLocaleString('en-US');

const collectGarbage = (): void => {
  // Only available with --expose-gc; without it the memory numbers include garbage.
  globalThis.gc?.();
};

// Measures the longest time the event loop could not run a timer while `fn` was running.
async function longestBlock(fn: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let longest = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 1);

  try {
    await fn();
  } finally {
    clearInterval(timer);
  }

  return Math.max(longest, performance.now() - last);
}

async function timed(
  result: StageResult,
  operation: string,
  count: number,
  fn: () => unknown,
): Promise<void> {
  const start = performance.now();
  await fn();
  result.timings.set(operation, { count, ms: performance.now() - start });
}

async function runStage(contender: Contender, size: number): Promise<StageResult> {
  const directory = await mkdtemp(join(tmpdir(), `bench-${contender.name}-`));
  const path = join(directory, contender.fileName);
  const result: StageResult = {
    timings: new Map(),
    fileSize: 0,
    heapPerDocument: 0,
    fullSaveBlock: 0,
    smallSaveBlock: 0,
  };

  try {
    collectGarbage();
    const heapBefore = process.memoryUsage().heapUsed;
    const store = await contender.open(path);
    const ids: string[] = [];

    await timed(result, 'insert', size, () => {
      for (let index = 0; index < size; index++) {
        ids.push(
          store.insert({
            name: `user-${index}`,
            level: index % 100,
            tags: index % 2 === 0 ? ['even'] : ['odd', 'vip'],
            joinedAt: new Date(1_700_000_000_000 + index),
          }),
        );
      }
    });

    collectGarbage();
    result.heapPerDocument = (process.memoryUsage().heapUsed - heapBefore) / size;

    await timed(result, 'get by id (random)', size, () => {
      for (let index = 0; index < size; index++) {
        const id = ids[Math.floor(Math.random() * ids.length)];

        if (id === undefined || !store.has(id)) {
          throw new Error('A document went missing');
        }
      }
    });

    await timed(result, `find, full scan x${SCANS}`, size * SCANS, () => {
      for (let scan = 0; scan < SCANS; scan++) {
        store.countLevel(scan);
      }
    });

    const tenth = Math.ceil(size / 10);

    await timed(result, 'update by id (10%)', tenth, () => {
      for (const id of ids.slice(0, tenth)) {
        store.setLevel(id, 1000);
      }
    });

    await timed(result, 'updateMany (1% match)', size, () => {
      store.setLevelWhere(50, 51);
    });

    result.fullSaveBlock = await longestBlock(() =>
      timed(result, 'save (whole database)', size, () => store.save()),
    );
    result.fileSize = (await stat(path)).size;

    let reloaded = 0;

    await timed(result, 'load', size, async () => {
      reloaded = await contender.reload(path);
    });

    if (reloaded !== size) {
      throw new Error(
        `${contender.name}: expected ${size} documents after load, found ${reloaded}`,
      );
    }

    await timed(result, 'remove by id (10%)', tenth, () => {
      for (const id of ids.slice(0, tenth)) {
        store.remove(id);
      }
    });

    const { compact } = store;

    if (compact) {
      await timed(result, 'compact', size, () => compact());
    }

    result.smallSaveBlock = await longestBlock(() =>
      timed(result, `save after 1 change x${SMALL_SAVES}`, SMALL_SAVES, async () => {
        for (const id of ids.slice(tenth, tenth + SMALL_SAVES)) {
          store.setLevel(id, 7);
          await store.save();
        }
      }),
    );

    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function cell(text: string): string {
  return text.padStart(CELL_WIDTH);
}

function compare(ours: number | undefined, theirs: number | undefined): string {
  if (ours === undefined || theirs === undefined || ours <= 0 || theirs <= 0) {
    return '';
  }

  const ratio = theirs / ours;

  return ratio >= 1 ? `${ratio.toFixed(1)}x faster` : `${(1 / ratio).toFixed(1)}x slower`;
}

function printComparison(size: number, results: ReadonlyMap<string, StageResult>): void {
  const ours = results.get(localdb.name);
  const theirs = results.get(lowdb.name);
  const operations = new Set([...(ours?.timings.keys() ?? []), ...(theirs?.timings.keys() ?? [])]);
  const lines = [
    `\n=== ${formatNumber(size)} documents ===`,
    `${'operation'.padEnd(NAME_WIDTH)}${cell(localdb.name)}${cell(lowdb.name)}   localdb vs lowdb`,
  ];

  for (const operation of operations) {
    const oursMs = ours?.timings.get(operation)?.ms;
    const theirsMs = theirs?.timings.get(operation)?.ms;

    lines.push(
      `${operation.padEnd(NAME_WIDTH)}${cell(oursMs === undefined ? '-' : `${oursMs.toFixed(1)} ms`)}${cell(theirsMs === undefined ? '-' : `${theirsMs.toFixed(1)} ms`)}   ${compare(oursMs, theirsMs)}`,
    );
  }

  const row = (label: string, read: (result: StageResult) => string): string =>
    `${label.padEnd(NAME_WIDTH)}${cell(ours ? read(ours) : '-')}${cell(theirs ? read(theirs) : '-')}`;

  lines.push(
    row('file size', (result) => `${(result.fileSize / MB).toFixed(1)} MB`),
    row('heap per document', (result) => `${formatNumber(result.heapPerDocument)} B`),
    row('longest block, full save', (result) => `${result.fullSaveBlock.toFixed(0)} ms`),
    row('longest block, small saves', (result) => `${result.smallSaveBlock.toFixed(0)} ms`),
  );

  console.log(lines.join('\n'));
}

const args = process.argv.slice(2);
const sizes = args.map(Number).filter((value) => Number.isInteger(value) && value > 0);
// `--only=localdb` runs a single contender, for quick before/after checks while optimizing.
const only = args.find((arg) => arg.startsWith('--only='))?.slice('--only='.length);
const selected = contenders.filter((contender) => only === undefined || contender.name === only);

console.log(`node ${process.version}, ${process.platform}/${process.arch}`);
console.log(
  'localdb validates every write with zod, freezes documents and keeps Date values; lowdb does none of these.',
);

for (const size of sizes.length > 0 ? sizes : DEFAULT_SIZES) {
  const results = new Map<string, StageResult>();

  for (const contender of selected) {
    results.set(contender.name, await runStage(contender, size));
  }

  printComparison(size, results);
}
