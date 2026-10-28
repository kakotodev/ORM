import type { Adapter } from "../../../src/adapters/adapter.js";
import { createSqliteAdapter } from "../../../src/adapters/sqlite.js";
import {
  ConfigError,
  DatabaseError,
  ForeignKeyError,
  LimitExceededError,
  NotFoundError,
  TransactionError,
  UniqueConstraintError,
  ValidationError,
} from "../../../src/errors.js";
import { createRuntimeClient } from "../../../src/runtime/client.js";
import { loadSchema } from "../../../src/schema/index.js";
import { createTestClient, type TestClient } from "../../helpers/db.js";
import { BLOG_SCHEMA } from "../../helpers/schemas.js";

async function seed(db: TestClient): Promise<{ id: number }> {
  const u = (await db.user.create({ data: { email: "a@b.c", name: "A" } })) as { id: number };
  await db.post.create({ data: { title: "P1", author: { connect: { id: u.id } } } });
  await db.post.create({ data: { title: "P2", authorId: u.id } });
  return u;
}

async function errorOf(p: Promise<unknown>): Promise<{ debug?: { sql?: string; params?: unknown[] } } & Error> {
  return p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e as Error,
  );
}

describe("runtime client", () => {
  it("creates and reads back with includes", async () => {
    const db = await createTestClient();
    const u = (await db.user.create({ data: { email: "a@b.c", name: "A" } })) as { id: number };
    await db.post.create({ data: { title: "P1", author: { connect: { id: u.id } } } });
    expect(await db.user.findUnique({ where: { id: u.id }, include: { posts: { select: { title: true } } } })).toMatchObject({
      email: "a@b.c",
      role: "USER",
      posts: [{ title: "P1" }],
    });
    expect(await db.post.findFirst({ select: { title: true }, where: { author: { is: { email: "a@b.c" } } } })).toEqual({
      title: "P1",
    });
  });

  it("returns plain objects with decoded schema fields only", async () => {
    const db = await createTestClient();
    const u = (await db.user.create({ data: { email: "a@b.c" } })) as Record<string, unknown>;
    expect(Object.getPrototypeOf(u)).toBe(Object.prototype);
    expect(Object.keys(u).sort()).toEqual(["createdAt", "email", "id", "name", "role"]);
    expect(u.createdAt).toBeInstanceOf(Date);
    const p = (await db.post.create({ data: { title: "t", authorId: u.id, meta: { a: [1] }, views: 5n } })) as Record<string, unknown>;
    expect(p).toMatchObject({ published: false, views: 5n, meta: { a: [1] }, rating: null, cover: null });
  });

  it("strips join columns that were not selected and loads nested includes", async () => {
    const db = await createTestClient();
    const u = await seed(db);
    expect(
      await db.user.findUnique({
        where: { id: u.id },
        select: { email: true },
      }),
    ).toEqual({ email: "a@b.c" });
    expect(await db.post.findMany({ orderBy: { id: "asc" }, include: { author: { select: { email: true } } } })).toMatchObject([
      { title: "P1", author: { email: "a@b.c" } },
      { title: "P2", author: { email: "a@b.c" } },
    ]);
    const posts = (await db.post.findMany({ include: { author: { select: { email: true } } } })) as { author: object }[];
    expect(posts[0]?.author).toEqual({ email: "a@b.c" });
    const users = (await db.user.findMany({
      include: { posts: { where: { title: { startsWith: "P" } }, orderBy: { title: "desc" }, select: { title: true } } },
    })) as { posts: unknown[] }[];
    expect(users[0]?.posts).toEqual([{ title: "P2" }, { title: "P1" }]);
    const nested = (await db.post.findFirst({
      where: { title: "P1" },
      include: { author: { include: { posts: { orderBy: { id: "asc" }, select: { title: true } } } } },
    })) as { author: { email: string; posts: unknown[] } };
    expect(nested.author.email).toBe("a@b.c");
    expect(nested.author.posts).toEqual([{ title: "P1" }, { title: "P2" }]);
  });

  it("loads includes in batches larger than the IN-list limit", async () => {
    const db = await createTestClient(undefined, { limits: { maxInListSize: 3 } });
    for (let i = 0; i < 7; i++) {
      const u = (await db.user.create({ data: { email: `u${String(i)}` } })) as { id: number };
      await db.post.create({ data: { title: `p${String(i)}`, authorId: u.id } });
    }
    const users = (await db.user.findMany({ orderBy: { id: "asc" }, include: { posts: true } })) as { email: string; posts: { title: string }[] }[];
    expect(users.map((u) => [u.email, u.posts.map((p) => p.title)])).toEqual(
      Array.from({ length: 7 }, (_, i) => [`u${String(i)}`, [`p${String(i)}`]]),
    );
  });

  it("gives empty lists and null for missing relations", async () => {
    const db = await createTestClient();
    await db.user.create({ data: { email: "lonely" } });
    expect(await db.user.findFirst({ include: { posts: true } })).toMatchObject({ email: "lonely", posts: [] });
  });

  it("maps unique violations to UniqueConstraintError with field names", async () => {
    const db = await createTestClient();
    await db.user.create({ data: { email: "dup" } });
    await expect(db.user.create({ data: { email: "dup" } })).rejects.toMatchObject({
      code: "UNIQUE_CONSTRAINT",
      model: "User",
      fields: ["email"],
    });
    await expect(db.user.create({ data: { email: "dup" } })).rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it("maps foreign key violations to ForeignKeyError", async () => {
    const db = await createTestClient();
    await expect(db.post.create({ data: { title: "t", authorId: 999 } })).rejects.toBeInstanceOf(ForeignKeyError);
  });

  it("throws NotFoundError on update/delete of a missing row and on bad connect", async () => {
    const db = await createTestClient();
    await expect(db.user.update({ where: { id: 42 }, data: { name: "x" } })).rejects.toBeInstanceOf(NotFoundError);
    await expect(db.user.delete({ where: { id: 42 } })).rejects.toBeInstanceOf(NotFoundError);
    await expect(db.post.create({ data: { title: "t", author: { connect: { id: 42 } } } })).rejects.toMatchObject({ model: "User" });
    expect(await db.post.count()).toBe(0);
  });

  it("updates, upserts and deletes", async () => {
    const db = await createTestClient();
    const u = await seed(db);
    expect(await db.user.update({ where: { email: "a@b.c" }, data: { name: "B" }, select: { name: true } })).toEqual({ name: "B" });
    expect(await db.user.upsert({ where: { email: "new" }, create: { email: "new" }, update: { name: "no" } })).toMatchObject({
      email: "new",
      name: null,
    });
    expect(await db.user.upsert({ where: { email: "new" }, create: { email: "new" }, update: { name: "yes" } })).toMatchObject({
      email: "new",
      name: "yes",
    });
    const other = (await db.user.findUnique({ where: { email: "new" } })) as { id: number };
    const moved = await db.post.update({ where: { id: 1 }, data: { author: { connect: { id: other.id } } }, include: { author: true } });
    expect(moved).toMatchObject({ authorId: other.id, author: { email: "new" } });
    const deleted = await db.user.delete({ where: { id: u.id }, include: { posts: { select: { title: true } } } });
    expect(deleted).toMatchObject({ email: "a@b.c", posts: [{ title: "P2" }] });
    expect(await db.user.findUnique({ where: { id: u.id } })).toBeNull();
  });

  it("returns counts for bulk operations and applies the count window", async () => {
    const db = await createTestClient();
    expect(await db.user.createMany({ data: [{ email: "1" }, { email: "2" }, { email: "3" }] })).toEqual({ count: 3 });
    expect(await db.user.updateMany({ where: { email: { in: ["1", "2"] } }, data: { name: "n" } })).toEqual({ count: 2 });
    expect(await db.user.count({ where: { name: "n" } })).toBe(2);
    expect(await db.user.count({ skip: 1, take: 5 })).toBe(2);
    expect(await db.user.count({ take: 1 })).toBe(1);
    expect(await db.user.deleteMany({ where: {} })).toEqual({ count: 3 });
    expect(await db.user.findMany()).toEqual([]);
  });

  it("is case-sensitive and literal in text filters", async () => {
    const db = await createTestClient();
    for (const email of ["abc", "ABC", "a*c", "[x]", "100%_"]) await db.user.create({ data: { email } });
    expect(await db.user.count({ where: { email: { contains: "ABC" } } })).toBe(1);
    expect(await db.user.count({ where: { email: { contains: "*" } } })).toBe(1);
    expect(await db.user.count({ where: { email: { startsWith: "[" } } })).toBe(1);
    expect(await db.user.count({ where: { email: { endsWith: "%_" } } })).toBe(1);
  });

  it("rolls back $transaction and keeps outside queries isolated", async () => {
    const db = await createTestClient();
    await expect(
      db.$transaction(async (tx) => {
        await (tx as TestClient).user.create({ data: { email: "t" } });
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
    expect(await db.user.count()).toBe(0);
  });

  it("runs multi-step operations on the transaction's connection inside $transaction", async () => {
    const db = await createTestClient();
    const result = await db.$transaction(async (raw) => {
      const tx = raw as TestClient;
      expect(Object.hasOwn(tx, "$transaction")).toBe(false);
      expect(Object.hasOwn(tx, "$disconnect")).toBe(false);
      const u = (await tx.user.create({ data: { email: "t" } })) as { id: number };
      await tx.post.create({ data: { title: "p", author: { connect: { id: u.id } } } });
      await tx.user.upsert({ where: { email: "t" }, create: { email: "t" }, update: { name: "up" } });
      return tx.user.findUnique({ where: { id: u.id }, include: { posts: { select: { title: true } } } });
    });
    expect(result).toMatchObject({ name: "up", posts: [{ title: "p" }] });
    expect(await db.post.count()).toBe(1);
  });

  it("rejects use of a transaction client after the transaction ended", async () => {
    const db = await createTestClient();
    let saved: TestClient | undefined;
    await db.$transaction((tx) => {
      saved = tx as TestClient;
      return Promise.resolve();
    });
    await expect(saved?.user.count()).rejects.toBeInstanceOf(TransactionError);
  });

  it("hides SQL unless debug is enabled", async () => {
    const quiet = await createTestClient();
    await quiet.user.create({ data: { email: "d" } });
    const err = await errorOf(quiet.user.create({ data: { email: "d" } }));
    expect(err.debug).toBeUndefined();
    expect(JSON.stringify(err)).not.toContain("INSERT");
    const loud = await createTestClient(undefined, { debug: true });
    await loud.user.create({ data: { email: "d" } });
    const err2 = await errorOf(loud.user.create({ data: { email: "d" } }));
    expect(err2.debug?.sql).toContain("INSERT");
    expect(err2.debug?.params).toContain("d");
    expect(err2.message).not.toContain("INSERT");
  });

  it("strips adapter debug data from database errors unless debug is enabled", async () => {
    const inner = createSqliteAdapter({ url: "file::memory:" });
    const failing: Adapter = {
      ...inner,
      query: () => Promise.reject(new DatabaseError({ sql: "SELECT secret", params: ["p"], cause: new Error("driver") })),
    };
    const schema = loadSchema(BLOG_SCHEMA);
    const quiet = createRuntimeClient(schema, { adapter: failing }) as TestClient;
    const err = await errorOf(quiet.user.findMany());
    expect(err).toBeInstanceOf(DatabaseError);
    expect(err.debug).toBeUndefined();
    const loud = createRuntimeClient(schema, { adapter: failing, debug: true }) as TestClient;
    expect((await errorOf(loud.user.findMany())).debug?.sql).toBe("SELECT secret");
    await inner.close();
  });

  it("raises LimitExceededError when findMany exceeds maxRows", async () => {
    const db = await createTestClient(undefined, { limits: { maxRows: 2 } });
    await db.user.createMany({ data: [{ email: "1" }, { email: "2" }, { email: "3" }] });
    await expect(db.user.findMany()).rejects.toBeInstanceOf(LimitExceededError);
    expect(await db.user.findMany({ take: 2 })).toHaveLength(2);
  });

  it("cascades deletes as declared in the schema", async () => {
    const db = await createTestClient();
    const u = await seed(db);
    expect(await db.post.count()).toBe(2);
    await db.user.delete({ where: { id: u.id } });
    expect(await db.post.count()).toBe(0);
  });

  it("exposes frozen, prototype-free delegates whose methods work detached", async () => {
    const db = await createTestClient();
    expect(Object.isFrozen(db)).toBe(true);
    expect(Object.getPrototypeOf(db)).toBeNull();
    expect(Object.isFrozen(db.user)).toBe(true);
    const { create, count } = db.user;
    await create({ data: { email: "x" } });
    expect(await count()).toBe(1);
    await expect(count("nope")).rejects.toBeInstanceOf(ValidationError);
  });

  it("reports a missing URL without leaking env values", () => {
    expect(() => createRuntimeClient(loadSchema(BLOG_SCHEMA), { env: {} })).toThrow(/DATABASE_URL/);
    expect(() => createRuntimeClient(loadSchema(BLOG_SCHEMA), { env: {} })).toThrow(ConfigError);
  });

  it("rejects the postgresql provider and bad limits", () => {
    const schema = loadSchema(BLOG_SCHEMA);
    expect(() => createRuntimeClient(schema, { url: "file::memory:", provider: "postgresql" })).toThrow(
      "Provider postgresql is not supported yet",
    );
    expect(() => createRuntimeClient(schema, { url: "file::memory:", limits: { maxRows: Number.NaN } })).toThrow(ConfigError);
  });

  it("opens its own adapter from the URL and disconnects", async () => {
    const db = createRuntimeClient(loadSchema(BLOG_SCHEMA), { env: { DATABASE_URL: "file::memory:" } });
    await db.$disconnect();
  });
});
