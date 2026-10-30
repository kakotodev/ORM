import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import type { Adapter } from "../../src/adapters/adapter.js";
import { createSqliteAdapter } from "../../src/adapters/sqlite.js";
import {
  ConfigError,
  DatabaseError,
  ForeignKeyError,
  MigrationError,
  NotFoundError,
  OrmError,
  TransactionError,
  UniqueConstraintError,
  ValidationError,
} from "../../src/errors.js";
import { migrate } from "../../src/migrations/runner.js";
import { createRuntimeClient } from "../../src/runtime/client.js";
import { loadSchema } from "../../src/schema/index.js";
import { createTestClient, type TestClient } from "../helpers/db.js";
import { BLOG_SCHEMA, RESTRICT_SCHEMA } from "../helpers/schemas.js";

const SECRET = "top-secret-value";
const schema = loadSchema(BLOG_SCHEMA);

async function rejection(p: Promise<unknown>): Promise<OrmError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof OrmError) return err;
    throw err;
  }
  throw new Error("expected a rejection");
}

function synchronous(fn: () => unknown): OrmError {
  try {
    fn();
  } catch (err) {
    if (err instanceof OrmError) return err;
    throw err;
  }
  throw new Error("expected a throw");
}

/** An adapter whose every query fails with a driver-like error full of sensitive data. */
function leakyAdapter(): { adapter: Adapter; close: () => Promise<void> } {
  const inner = createSqliteAdapter({ url: "file::memory:" });
  const adapter: Adapter = {
    ...inner,
    query: () =>
      Promise.reject(
        new DatabaseError({ sql: `SELECT ${SECRET}`, params: [SECRET], cause: new Error(`no such table: ${SECRET}`) }),
      ),
  };
  return { adapter, close: () => inner.close() };
}

interface Scenario {
  name: string;
  expected: new (...args: never[]) => OrmError;
  /** Whether debug mode is expected to attach SQL to the error. */
  sql: boolean;
  /** Migration errors keep their cause in non-enumerable `debug`; the CLI only prints it with --debug. */
  keepsDebug?: boolean;
  run: (debug: boolean) => Promise<OrmError>;
}

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "mini-orm-leak-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const SCENARIOS: Scenario[] = [
  {
    name: "validation error on a secret value",
    expected: ValidationError,
    sql: false,
    run: async (debug) => {
      const db = await createTestClient(undefined, { debug });
      return rejection(db.user.findMany({ where: { id: SECRET } }));
    },
  },
  {
    name: "validation error on a secret enum value and a secret nested value",
    expected: ValidationError,
    sql: false,
    run: async (debug) => {
      const db = await createTestClient(undefined, { debug });
      return rejection(db.user.create({ data: { email: SECRET, role: SECRET } }));
    },
  },
  {
    name: "unique constraint on a secret value",
    expected: UniqueConstraintError,
    sql: true,
    run: async (debug) => {
      const db = await createTestClient(undefined, { debug });
      await db.user.create({ data: { email: SECRET } });
      return rejection(db.user.create({ data: { email: SECRET } }));
    },
  },
  {
    name: "foreign key violation with a secret value",
    expected: ForeignKeyError,
    sql: true,
    run: async (debug) => {
      const db = await createTestClient(undefined, { debug });
      return rejection(db.post.create({ data: { title: SECRET, authorId: 999 } }));
    },
  },
  {
    name: "foreign key violation on a delete blocked by onDelete: Restrict",
    expected: ForeignKeyError,
    sql: true,
    run: async (debug) => {
      const db = await createTestClient(RESTRICT_SCHEMA, { debug });
      const u = (await db.user.create({ data: { email: SECRET } })) as { id: number };
      await db.post.create({ data: { title: SECRET, authorId: u.id } });
      return rejection(db.user.deleteMany({ where: { email: SECRET } }));
    },
  },
  {
    name: "not found on a secret value",
    expected: NotFoundError,
    sql: false,
    run: async (debug) => {
      const db = await createTestClient(undefined, { debug });
      return rejection(db.user.update({ where: { email: SECRET }, data: { name: SECRET } }));
    },
  },
  {
    name: "driver failure carrying SQL and values",
    expected: DatabaseError,
    sql: true,
    run: async (debug) => {
      const { adapter, close } = leakyAdapter();
      const db = createRuntimeClient(schema, { adapter, debug }) as TestClient;
      const err = await rejection(db.user.findMany());
      await close();
      return err;
    },
  },
  {
    name: "use of a transaction client after it ended",
    expected: TransactionError,
    sql: false,
    run: async (debug) => {
      const db = await createTestClient(undefined, { debug });
      let saved: TestClient | undefined;
      await db.$transaction((tx) => {
        saved = tx as TestClient;
        return Promise.resolve();
      });
      return rejection(saved?.user.create({ data: { email: SECRET } }) ?? Promise.resolve());
    },
  },
  {
    name: "missing database URL",
    expected: ConfigError,
    sql: false,
    run: (debug) => Promise.resolve(synchronous(() => createRuntimeClient(schema, { env: { UNRELATED: SECRET }, debug }))),
  },
  {
    name: "invalid database URL containing a secret",
    expected: ConfigError,
    sql: false,
    run: (debug) =>
      Promise.resolve(synchronous(() => createRuntimeClient(schema, { url: `postgres://user:${SECRET}@host/db`, debug }))),
  },
  {
    name: "database file that cannot be opened (secret path)",
    expected: ConfigError,
    sql: false,
    run: (debug) =>
      Promise.resolve(
        synchronous(() => createRuntimeClient(schema, { url: `file:${join(tmp, SECRET, "missing", "db.sqlite")}`, debug })),
      ),
  },
  {
    name: "migration filesystem failure (secret path)",
    expected: MigrationError,
    sql: false,
    keepsDebug: true,
    run: async () => {
      const notADir = join(tmp, `${SECRET}-file`);
      writeFileSync(notADir, "x");
      const adapter = createSqliteAdapter({ url: "file::memory:" });
      try {
        return await rejection(migrate({ schema, adapter, dir: notADir }));
      } finally {
        await adapter.close();
      }
    },
  },
];

describe.each(SCENARIOS)("$name", (scenario) => {
  it("exposes nothing sensitive by default", async () => {
    const err = await scenario.run(false);
    expect(err).toBeInstanceOf(scenario.expected);
    const views = [err.message, JSON.stringify(err), inspect(err)];
    for (const view of views) {
      expect(view).not.toMatch(/secret/i);
      expect(view).not.toMatch(/SELECT|INSERT|UPDATE |DELETE FROM/);
      expect(view).not.toContain(tmp);
    }
    if (scenario.keepsDebug === true) {
      expect(Object.keys(err)).not.toContain("debug"); // non-enumerable
      expect(Object.getOwnPropertyDescriptor(err, "debug")?.enumerable).toBe(false);
    } else {
      expect(err.debug).toBeUndefined();
    }
  });

  if (scenario.sql) {
    it("exposes SQL only in err.debug when debug is on", async () => {
      const err = await scenario.run(true);
      expect(err).toBeInstanceOf(scenario.expected);
      expect(err.debug?.sql).toMatch(/SELECT|INSERT|DELETE FROM/);
      // Still never in the message, JSON or default inspection.
      for (const view of [err.message, JSON.stringify(err), inspect(err)]) {
        expect(view).not.toMatch(/SELECT|INSERT|DELETE FROM/);
        expect(view).not.toContain(SECRET);
      }
    });
  }
});

describe("debug mode keeps secrets out of the message too", () => {
  it("never lets a value into err.message even with debug: true", async () => {
    const db = await createTestClient(undefined, { debug: true });
    await db.user.create({ data: { email: SECRET } });
    const err = await rejection(db.user.create({ data: { email: SECRET } }));
    expect(err.message).not.toMatch(/secret/i);
    expect(err.debug?.params).toContain(SECRET);
  });
});

describe("connection URLs", () => {
  it("never appear in errors raised while opening a database", () => {
    const err = synchronous(() => createRuntimeClient(schema, { url: `file:${join(tmp, SECRET, "x", "db")}` }));
    expect(inspect(err)).not.toContain(SECRET);
    expect(err.debug).toBeUndefined();
  });

  it("are not echoed when the URL comes from the environment", () => {
    const env = { DATABASE_URL: `mysql://admin:${SECRET}@db.internal/prod` };
    const err = synchronous(() => createRuntimeClient(schema, { env }));
    for (const view of [err.message, JSON.stringify(err), inspect(err)]) expect(view).not.toMatch(/secret|admin|internal/i);
  });
});
