/* eslint-disable security/detect-non-literal-fs-filename -- test paths live in a temporary directory */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteAdapter } from "../../src/adapters/sqlite.js";
import type { Adapter } from "../../src/adapters/adapter.js";
import { MigrationError } from "../../src/errors.js";
import { readMigrations, writeMigration } from "../../src/migrations/files.js";
import { migrate, resetDatabase } from "../../src/migrations/runner.js";
import { loadSchema } from "../../src/schema/index.js";
import { BLOG_SCHEMA } from "../helpers/schemas.js";

const base = loadSchema(BLOG_SCHEMA);
const withTag = loadSchema(BLOG_SCHEMA.replace("model Post {", "model Tag {\n id Int @id\n label String\n}\nmodel Post {"));
const changed = loadSchema(BLOG_SCHEMA.replace("name      String?", "name      String?\n  bio String?"));

let root: string;
let dir: string;
let adapter: Adapter;
let counter = 0;
let clock = 0;
const now = (): Date => new Date(clock);

async function tables(): Promise<string[]> {
  const rows = await adapter.query({
    text: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    params: [],
  });
  return rows.map((r) => String(r["name"]));
}

function sqlPath(name: string | null): string {
  return join(dir, `${name ?? ""}.sql`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mini-orm-mig-"));
  dir = join(root, "migrations");
  counter += 10;
  clock = Date.UTC(2026, 9, 28, 12, 0, 0) + counter * 60_000;
  adapter = createSqliteAdapter({ url: `file:${join(root, "db.sqlite")}` });
});

afterEach(async () => {
  await adapter.close();
  rmSync(root, { recursive: true, force: true });
});

describe("migrate", () => {
  it("creates and applies the init migration, then is up to date", async () => {
    const r1 = await migrate({ schema: base, adapter, dir, now });
    expect(r1.created).toMatch(/^\d{14}_init$/);
    expect(r1.applied).toEqual([r1.created]);
    expect(await tables()).toEqual(expect.arrayContaining(["User", "Post", "_mini_orm_migrations"]));
    const r2 = await migrate({ schema: base, adapter, dir, now });
    expect(r2).toEqual({ applied: [], created: null, upToDate: true });
  });

  it("writes LF sql and an indented snapshot", async () => {
    const r = await migrate({ schema: base, adapter, dir, now });
    const sql = readFileSync(sqlPath(r.created), "utf8");
    expect(sql).not.toContain("\r");
    expect(sql).toContain("\n-- statement-breakpoint\n");
    expect(readFileSync(join(dir, `${r.created ?? ""}.snapshot.json`), "utf8")).toMatch(/^\{\n {2}"provider"/);
  });

  it("adds a migration for new models only", async () => {
    await migrate({ schema: base, adapter, dir, now });
    const r = await migrate({ schema: withTag, adapter, dir, now });
    expect(r.created).not.toBeNull();
    expect(await tables()).toContain("Tag");
    expect(readMigrations(dir)).toHaveLength(2);
  });

  it("gives colliding migrations distinct, ordered names", async () => {
    const fixed = (): Date => new Date(Date.UTC(2026, 0, 1));
    const a = await migrate({ schema: base, adapter, dir, now: fixed });
    const b = await migrate({ schema: withTag, adapter, dir, now: fixed });
    expect(a.created).toBe("20260101000000_init");
    expect(b.created).toBe("20260101000001_update");
  });

  it("applies pending files from disk (e.g. after a git pull)", async () => {
    await migrate({ schema: base, adapter, dir, now });
    const other = createSqliteAdapter({ url: "file::memory:" });
    try {
      const r = await migrate({ schema: base, adapter: other, dir, now });
      expect(r.created).toBeNull();
      expect(r.applied).toHaveLength(1);
      expect(r.upToDate).toBe(false);
    } finally {
      await other.close();
    }
  });

  it("refuses unsupported changes with a hint", async () => {
    await migrate({ schema: base, adapter, dir, now });
    await expect(migrate({ schema: changed, adapter, dir, now })).rejects.toThrow(/migrate reset --force/);
    await expect(migrate({ schema: changed, adapter, dir, now })).rejects.toThrow(MigrationError);
  });

  it("detects a modified applied migration", async () => {
    const r = await migrate({ schema: base, adapter, dir, now });
    const file = sqlPath(r.created);
    writeFileSync(file, readFileSync(file, "utf8") + "\n-- tampered\n");
    await expect(migrate({ schema: base, adapter, dir, now })).rejects.toThrow(/was modified after being applied/);
  });

  it("tolerates CRLF conversion of an applied migration", async () => {
    const r = await migrate({ schema: base, adapter, dir, now });
    const file = sqlPath(r.created);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("\n", "\r\n"));
    expect((await migrate({ schema: base, adapter, dir, now })).upToDate).toBe(true);
  });

  it("detects a missing applied migration and half-written pairs", async () => {
    const r = await migrate({ schema: base, adapter, dir, now });
    rmSync(join(dir, `${r.created ?? ""}.snapshot.json`));
    await expect(migrate({ schema: base, adapter, dir, now })).rejects.toThrow(MigrationError);
    rmSync(sqlPath(r.created));
    await expect(migrate({ schema: base, adapter, dir, now })).rejects.toThrow(/is missing/);
  });

  it("rejects a malformed snapshot without echoing its content", async () => {
    const r = await migrate({ schema: base, adapter, dir, now });
    writeFileSync(join(dir, `${r.created ?? ""}.snapshot.json`), '{"models": [1], "secret": "hunter2"}');
    const err = await migrate({ schema: base, adapter, dir, now }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationError);
    expect((err as Error).message).not.toContain("hunter2");
  });

  it("does not split statements on semicolons inside literals", async () => {
    const schema = loadSchema(BLOG_SCHEMA.replace("name      String?", 'name      String? @default("a;b")'));
    const r = await migrate({ schema, adapter, dir, now });
    expect(r.created).not.toBeNull();
    await adapter.execute({ text: 'INSERT INTO "User" ("email", "createdAt") VALUES (?, ?)', params: ["x@y.z", 0] });
    const rows = await adapter.query({ text: 'SELECT "name" FROM "User"', params: [] });
    expect(rows[0]?.["name"]).toBe("a;b");
  });

  it("rolls back a failing migration and does not record it", async () => {
    await migrate({ schema: base, adapter, dir, now });
    const sql = ['CREATE TABLE "Extra" ("x" INTEGER)', "-- statement-breakpoint", 'CREATE TABLE "Broken" ('].join("\n");
    writeMigration(dir, "29990101000000_broken", sql, base);
    const err = await migrate({ schema: base, adapter, dir, now }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationError);
    expect((err as Error).message).not.toContain("CREATE");
    expect(await tables()).not.toContain("Extra");
    const rows = await adapter.query({ text: 'SELECT COUNT(*) AS "n" FROM "_mini_orm_migrations"', params: [] });
    expect(Number(rows[0]?.["n"])).toBe(1);
  });
});

describe("resetDatabase", () => {
  it("requires force and refuses production", async () => {
    await expect(resetDatabase({ schema: base, adapter, dir, force: false })).rejects.toThrow(/--force/);
    await expect(resetDatabase({ schema: base, adapter, dir, force: true, env: { NODE_ENV: "production" } })).rejects.toThrow(
      MigrationError,
    );
  });

  it("rebuilds from the current schema and keeps foreign files", async () => {
    await migrate({ schema: base, adapter, dir, now });
    await migrate({ schema: withTag, adapter, dir, now });
    writeFileSync(join(dir, "README.md"), "keep me");
    await expect(migrate({ schema: changed, adapter, dir, now })).rejects.toThrow(MigrationError);
    const r = await resetDatabase({ schema: changed, adapter, dir, force: true, env: {}, now });
    expect(r.created).toMatch(/^\d{14}_init$/);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith(".sql"))).toHaveLength(1);
    expect(await tables()).not.toContain("Tag");
    const cols = await adapter.query({ text: 'PRAGMA table_info("User")', params: [] });
    expect(cols.map((c) => c["name"])).toContain("bio");
    expect((await migrate({ schema: changed, adapter, dir, now })).upToDate).toBe(true);
  });
});
