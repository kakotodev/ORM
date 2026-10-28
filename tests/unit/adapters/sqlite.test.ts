import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteAdapter } from "../../../src/adapters/sqlite.js";
import { ConstraintViolation, type Adapter, type Queryable } from "../../../src/adapters/adapter.js";
import { sqliteDialect } from "../../../src/dialects/sqlite.js";
import { ConfigError, DatabaseError, TransactionError } from "../../../src/errors.js";
import { Mutex } from "../../../src/runtime/mutex.js";
import { loadSchema } from "../../../src/schema/index.js";
import { indexSchema } from "../../../src/schema/ir.js";
import { BLOG_SCHEMA } from "../../helpers/schemas.js";

const TS = "2026-01-01T00:00:00.000Z";
const insertUser = (email: string) => ({
  text: 'INSERT INTO "User" ("email","role","createdAt") VALUES (?,?,?)',
  params: [email, "USER", TS],
});

describe("Mutex", () => {
  it("serializes tasks in call order and survives failures", async () => {
    const m = new Mutex();
    const log: string[] = [];
    const slow = m.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
      log.push("a");
    });
    const bad = m.run(() => Promise.reject(new Error("x")));
    const last = m.run(() => {
      log.push("c");
      return Promise.resolve();
    });
    await expect(bad).rejects.toThrow("x");
    await Promise.all([slow, last]);
    expect(log).toEqual(["a", "c"]);
  });
});

describe("sqlite adapter", () => {
  let a: Adapter;
  beforeEach(async () => {
    a = createSqliteAdapter({ url: "file::memory:" });
    const idx = indexSchema(loadSchema(BLOG_SCHEMA));
    await a.executeScript(sqliteDialect.createTables(idx));
  });
  afterEach(async () => {
    await a.close();
  });

  it("runs parameterized queries", async () => {
    await a.execute(insertUser("x@y.z"));
    expect(
      await a.query({ text: 'SELECT "email" FROM "User" WHERE "email" = ?', params: ["x@y.z"] }),
    ).toEqual([{ email: "x@y.z" }]);
  });

  it("reports changes", async () => {
    await a.execute(insertUser("a"));
    await a.execute(insertUser("b"));
    expect(await a.execute({ text: 'UPDATE "User" SET "role" = ?', params: ["ADMIN"] })).toEqual({
      changes: 2,
    });
  });

  it("enforces foreign keys", async () => {
    await expect(
      a.execute({
        text: 'INSERT INTO "Post" ("title","authorId","published","views","updatedAt") VALUES (?,?,?,?,?)',
        params: ["t", 999, 0, 0n, TS],
      }),
    ).rejects.toMatchObject({ kind: "foreignKey" });
  });

  it("reports unique violations with table and columns, carrying the query", async () => {
    const ins = insertUser("dup");
    await a.execute(ins);
    const err: unknown = await a.execute(ins).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConstraintViolation);
    expect(err).toMatchObject({ kind: "unique", table: "User", columns: ["email"] });
    expect((err as ConstraintViolation).query).toEqual(ins);
    expect(Object.keys(err as object)).not.toContain("query");
  });

  it("reports primary key violations as unique", async () => {
    await a.execute(insertUser("p"));
    await expect(
      a.execute({
        text: 'INSERT INTO "User" ("id","email","role","createdAt") VALUES (1,?,?,?)',
        params: ["other", "USER", TS],
      }),
    ).rejects.toMatchObject({ kind: "unique", table: "User", columns: ["id"] });
  });

  it("maps other driver errors to DatabaseError with debug info", async () => {
    const q = { text: "SELEC nope", params: [1] };
    const err: unknown = await a.query(q).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatabaseError);
    const e = err as DatabaseError;
    expect(e.message).toBe("Database operation failed");
    expect(e.debug?.sql).toBe(q.text);
    expect(e.debug?.params).toEqual([1]);
    expect(e.debug?.cause).toBeInstanceOf(Error);
    expect(JSON.stringify(e)).not.toContain("SELEC");
  });

  it("rolls back on error and isolates concurrent queries", async () => {
    const outside: Promise<unknown>[] = [];
    await expect(
      a.transaction(async (tx) => {
        await tx.execute(insertUser("tx@x"));
        outside.push(
          a.query({ text: 'SELECT COUNT(*) AS "n" FROM "User" WHERE "email" = ?', params: ["tx@x"] }),
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await outside[0]).toEqual([{ n: 0n }]);
  });

  it("commits and returns the callback result", async () => {
    const r = await a.transaction(async (tx) => {
      await tx.execute(insertUser("c@x"));
      return 42;
    });
    expect(r).toBe(42);
    expect(await a.query({ text: 'SELECT COUNT(*) AS "n" FROM "User"', params: [] })).toEqual([
      { n: 1n },
    ]);
  });

  it("rejects tx use after the transaction ended", async () => {
    let leaked: Queryable | undefined;
    await a.transaction((tx) => {
      leaked = tx;
      return Promise.resolve();
    });
    await expect(leaked?.query({ text: "SELECT 1", params: [] })).rejects.toBeInstanceOf(
      TransactionError,
    );
    await expect(leaked?.execute({ text: "SELECT 1", params: [] })).rejects.toBeInstanceOf(
      TransactionError,
    );
  });

  it("round-trips a BigInt above 2^53", async () => {
    await a.execute(insertUser("big"));
    await a.execute({
      text: 'INSERT INTO "Post" ("title","authorId","published","views","updatedAt") VALUES (?,?,?,?,?)',
      params: ["t", 1, 0, 2n ** 60n, TS],
    });
    expect((await a.query({ text: 'SELECT "views" FROM "Post"', params: [] }))[0]).toEqual({
      views: 2n ** 60n,
    });
  });

  it("round-trips Uint8Array and null", async () => {
    await a.execute(insertUser("bytes"));
    await a.execute({
      text: 'INSERT INTO "Post" ("title","authorId","published","views","updatedAt","cover","rating") VALUES (?,?,?,?,?,?,?)',
      params: ["t", 1, 0, 0n, TS, new Uint8Array([1, 2, 3]), null],
    });
    const [row] = await a.query({ text: 'SELECT "cover","rating" FROM "Post"', params: [] });
    expect(row).toEqual({ cover: new Uint8Array([1, 2, 3]), rating: null });
  });

  it("rolls back a failing script atomically", async () => {
    const err: unknown = await a
      .executeScript(["CREATE TABLE ok (x INTEGER)", "CREATE TABLE bad ("])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatabaseError);
    await expect(a.query({ text: "SELECT * FROM ok", params: [] })).rejects.toBeInstanceOf(
      DatabaseError,
    );
  });

  it("fails cleanly after close", async () => {
    await a.close();
    await expect(a.query({ text: "SELECT 1", params: [] })).rejects.toBeInstanceOf(DatabaseError);
    await expect(a.execute(insertUser("z"))).rejects.toBeInstanceOf(DatabaseError);
    await expect(a.transaction(() => Promise.resolve(1))).rejects.toBeInstanceOf(DatabaseError);
    await expect(a.executeScript(["SELECT 1"])).rejects.toBeInstanceOf(DatabaseError);
    await expect(a.close()).resolves.toBeUndefined();
  });
});

describe("sqlite adapter urls", () => {
  it("refuses unsupported URLs without echoing them", () => {
    const url = "postgres://u:secret@h/db";
    expect(() => createSqliteAdapter({ url })).toThrow(ConfigError);
    try {
      createSqliteAdapter({ url });
    } catch (e) {
      expect((e as Error).message).toBe("Unsupported SQLite URL");
      expect((e as Error).message).not.toContain("secret");
    }
  });

  it.each(["", "file:", "file::", "file::other:", "memory", "file:a\0b"])("rejects %j", (url) => {
    expect(() => createSqliteAdapter({ url })).toThrow(ConfigError);
  });

  it("opens a file database and persists data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mini-orm-"));
    const file = join(dir, "t.db");
    try {
      const w = createSqliteAdapter({ url: `file:${file}` });
      await w.executeScript(["CREATE TABLE t (x INTEGER)"]);
      await w.transaction(async (tx) => {
        await tx.execute({ text: "INSERT INTO t VALUES (?)", params: [7] });
      });
      await w.close();
      const r = createSqliteAdapter({ url: `file:${file}` });
      expect(await r.query({ text: "SELECT x FROM t", params: [] })).toEqual([{ x: 7n }]);
      await r.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an unopenable path as ConfigError without the path", () => {
    try {
      createSqliteAdapter({ url: "file:no-such-dir-xyz/sub/db.sqlite" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).not.toContain("no-such-dir");
    }
  });
});
