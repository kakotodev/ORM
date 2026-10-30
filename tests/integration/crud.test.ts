import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteAdapter } from "../../src/adapters/sqlite.js";
import { sqliteDialect } from "../../src/dialects/sqlite.js";
import { NotFoundError, UniqueConstraintError } from "../../src/errors.js";
import { createRuntimeClient } from "../../src/runtime/client.js";
import { loadSchema } from "../../src/schema/index.js";
import { indexSchema } from "../../src/schema/ir.js";
import type { TestClient } from "../helpers/db.js";
import { BLOG_SCHEMA } from "../helpers/schemas.js";

const schema = loadSchema(BLOG_SCHEMA);
let dir: string;
let url: string;
const clients: TestClient[] = [];

function open(): TestClient {
  const client = createRuntimeClient(schema, { env: { DATABASE_URL: url } }) as TestClient;
  clients.push(client);
  return client;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mini-orm-"));
  url = `file:${join(dir, "crud.db")}`;
  const ddl = createSqliteAdapter({ url });
  await ddl.executeScript(sqliteDialect.createTables(indexSchema(schema)));
  await ddl.close();
});

afterAll(async () => {
  // Close every handle before removing the directory (Windows keeps open files locked).
  for (const client of clients) await client.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("CRUD on a SQLite file", () => {
  let db: TestClient;
  beforeAll(() => {
    db = open();
  });
  beforeEach(async () => {
    await db.post.deleteMany({ where: {} });
    await db.user.deleteMany({ where: {} });
  });

  it("creates, includes, updates and deletes", async () => {
    const u = (await db.user.create({ data: { email: "a@b.c", name: "A" } })) as { id: number };
    const p = (await db.post.create({ data: { title: "P1", author: { connect: { id: u.id } } } })) as { id: number };
    expect(await db.user.findUnique({ where: { id: u.id }, include: { posts: true } })).toMatchObject({
      email: "a@b.c",
      posts: [{ title: "P1", authorId: u.id, published: false, views: 0n }],
    });
    expect(await db.post.update({ where: { id: p.id }, data: { published: true }, include: { author: { select: { name: true } } } })).toMatchObject({
      published: true,
      author: { name: "A" },
    });
    await expect(db.user.create({ data: { email: "a@b.c" } })).rejects.toBeInstanceOf(UniqueConstraintError);
    expect(await db.post.delete({ where: { id: p.id }, select: { title: true } })).toEqual({ title: "P1" });
    await expect(db.post.delete({ where: { id: p.id } })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("upserts", async () => {
    expect(await db.user.upsert({ where: { email: "u" }, create: { email: "u", name: "c" }, update: { name: "u" } })).toMatchObject({ name: "c" });
    expect(await db.user.upsert({ where: { email: "u" }, create: { email: "u", name: "c" }, update: { name: "u" } })).toMatchObject({ name: "u" });
    expect(await db.user.count()).toBe(1);
  });

  it("runs bulk operations and cascades deletes", async () => {
    expect(await db.user.createMany({ data: [{ email: "1" }, { email: "2" }, { email: "3" }] })).toEqual({ count: 3 });
    const first = (await db.user.findFirst({ where: { email: "1" } })) as { id: number };
    await db.post.createMany({ data: [{ title: "a", authorId: first.id }, { title: "b", authorId: first.id }] });
    expect(await db.user.updateMany({ where: { email: { not: "1" } }, data: { role: "ADMIN" } })).toEqual({ count: 2 });
    expect(await db.user.count({ where: { role: "ADMIN" } })).toBe(2);
    expect(await db.user.deleteMany({ where: { email: "1" } })).toEqual({ count: 1 });
    expect(await db.post.count()).toBe(0);
    expect(await db.user.deleteMany({ where: {} })).toEqual({ count: 2 });
  });

  it("commits or rolls back $transaction on the file", async () => {
    await expect(
      db.$transaction(async (raw) => {
        await (raw as TestClient).user.create({ data: { email: "rolled" } });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    await db.$transaction(async (raw) => {
      await (raw as TestClient).user.create({ data: { email: "kept" } });
    });
    expect(await db.user.findMany({ select: { email: true } })).toEqual([{ email: "kept" }]);
  });

  it("lets a second client see the first client's committed writes", async () => {
    const other = open();
    await db.user.create({ data: { email: "shared" } });
    expect(await other.user.findUnique({ where: { email: "shared" }, select: { email: true } })).toEqual({ email: "shared" });
    await other.user.update({ where: { email: "shared" }, data: { name: "from other" } });
    expect(await db.user.findUnique({ where: { email: "shared" }, select: { name: true } })).toEqual({ name: "from other" });
  });
});
