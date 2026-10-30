import type { Adapter } from "../../src/adapters/adapter.js";
import { createSqliteAdapter } from "../../src/adapters/sqlite.js";
import { sqliteDialect } from "../../src/dialects/sqlite.js";
import { ValidationError } from "../../src/errors.js";
import { createRuntimeClient, type RuntimeDelegate } from "../../src/runtime/client.js";
import { loadSchema } from "../../src/schema/index.js";
import { indexSchema } from "../../src/schema/ir.js";
import { createTestClient } from "../helpers/db.js";
import { BLOG_SCHEMA } from "../helpers/schemas.js";
import { INJECTION_PAYLOADS } from "./corpus.js";

type Args = Record<string, unknown>;

/** Every position where a payload can appear as an object key, with the operation that receives it. */
const KEY_POSITIONS: Record<string, (payload: string) => { op: "findMany" | "create"; args: Args }> = {
  "where": (p) => ({ op: "findMany", args: { where: { [p]: 1 } } }),
  "where filter operator": (p) => ({ op: "findMany", args: { where: { email: { [p]: "x" } } } }),
  "where relation filter": (p) => ({ op: "findMany", args: { where: { posts: { some: { [p]: 1 } } } } }),
  "where relation operator": (p) => ({ op: "findMany", args: { where: { posts: { [p]: {} } } } }),
  "select": (p) => ({ op: "findMany", args: { select: { [p]: true } } }),
  "orderBy": (p) => ({ op: "findMany", args: { orderBy: { [p]: "asc" } } }),
  "include": (p) => ({ op: "findMany", args: { include: { [p]: true } } }),
  "include option": (p) => ({ op: "findMany", args: { include: { posts: { [p]: true } } } }),
  "data": (p) => ({ op: "create", args: { data: { email: "x", [p]: "v" } } }),
  "top-level option": (p) => ({ op: "findMany", args: { [p]: 1 } }),
};

describe.each(INJECTION_PAYLOADS)("payload %#", (payload) => {
  it("is stored and matched literally as a value", async () => {
    const db = await createTestClient();
    await db.user.create({ data: { email: payload, name: payload } });
    await db.user.create({ data: { email: "victim@x" } });
    expect(await db.user.findMany({ where: { email: payload } })).toHaveLength(1);
    expect(await db.user.count({ where: { name: { contains: payload } } })).toBe(1);
    expect(await db.user.count({ where: { name: { startsWith: payload } } })).toBe(1);
    expect(await db.user.count({ where: { name: { endsWith: payload } } })).toBe(1);
    expect(await db.user.count({ where: { email: { in: [payload] } } })).toBe(1);
    expect(await db.user.count({ where: { email: { not: payload } } })).toBe(1);
    expect(await db.user.count()).toBe(2); // no table was emptied
    const [row] = (await db.user.findMany({ where: { email: payload } })) as { email: string; name: string }[];
    expect(row?.email).toBe(payload);
    expect(row?.name).toBe(payload);
  });

  it("is stored literally through update, upsert and a nested relation filter", async () => {
    const db = await createTestClient();
    const user = (await db.user.create({ data: { email: "a@x" } })) as { id: number };
    await db.user.update({ where: { id: user.id }, data: { name: payload } });
    await db.user.upsert({ where: { email: "a@x" }, create: { email: "a@x" }, update: { name: payload } });
    await db.post.create({ data: { title: payload, author: { connect: { id: user.id } } } });
    expect(await db.user.count({ where: { name: payload } })).toBe(1);
    expect(await db.user.count({ where: { posts: { some: { title: payload } } } })).toBe(1);
    expect(await db.post.count({ where: { title: { contains: payload } } })).toBe(1);
  });

  it.each(Object.keys(KEY_POSITIONS))("is rejected as a key in %s", async (position) => {
    const db = await createTestClient();
    const build = KEY_POSITIONS[position];
    if (build === undefined) throw new Error("unknown position");
    const { op, args } = build(payload);
    await expect(db.user[op](args)).rejects.toBeInstanceOf(ValidationError);
    expect(await db.user.count()).toBe(0);
  });

  it.each(["orderBy", "orderBy in include"])("is rejected as a sort direction (%s)", async (where) => {
    const db = await createTestClient();
    const args: Args =
      where === "orderBy" ? { orderBy: { email: payload } } : { include: { posts: { orderBy: { title: payload } } } };
    await expect(db.user.findMany(args)).rejects.toBeInstanceOf(ValidationError);
  });

  it("is rejected as an enum value", async () => {
    const db = await createTestClient();
    await expect(db.user.create({ data: { email: "x", role: payload } })).rejects.toBeInstanceOf(ValidationError);
    await expect(db.user.findMany({ where: { role: payload } })).rejects.toBeInstanceOf(ValidationError);
  });

  it("is rejected where a number is expected", async () => {
    const db = await createTestClient();
    await expect(db.user.findMany({ where: { id: payload } })).rejects.toBeInstanceOf(ValidationError);
    await expect(db.user.findMany({ take: payload })).rejects.toBeInstanceOf(ValidationError);
    await expect(db.user.findMany({ skip: payload })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("values never reach the SQL text", () => {
  it.each(INJECTION_PAYLOADS.map((p, i) => [i, p] as const))("payload %# is only ever a bound parameter", async (_i, payload) => {
    const schema = loadSchema(BLOG_SCHEMA);
    const inner = createSqliteAdapter({ url: "file::memory:" });
    await inner.executeScript(sqliteDialect.createTables(indexSchema(schema)));
    const texts: string[] = [];
    const params: unknown[] = [];
    const record = (q: { text: string; params: readonly unknown[] }): void => {
      texts.push(q.text);
      params.push(...q.params);
    };
    const adapter: Adapter = {
      ...inner,
      query: (q) => (record(q), inner.query(q)),
      execute: (q) => (record(q), inner.execute(q)),
    };
    const db = createRuntimeClient(schema, { adapter }) as unknown as Record<"user", RuntimeDelegate>;
    await db.user.create({ data: { email: payload, name: payload } });
    await db.user.findMany({ where: { OR: [{ email: payload }, { name: { contains: payload } }, { email: { in: [payload] } }] } });
    await db.user.updateMany({ where: { email: payload }, data: { name: payload } });
    await db.user.deleteMany({ where: { email: payload } });
    expect(texts.length).toBeGreaterThanOrEqual(4);
    for (const text of texts) {
      expect(text).not.toContain(payload);
      expect(text).toMatch(/\?/);
    }
    expect(params).toContain(payload);
    await inner.close();
  });
});

describe("string filters treat pattern metacharacters literally", () => {
  it("does not let *, ?, [, %, _ or a backslash act as wildcards", async () => {
    const db = await createTestClient();
    const names = ["a*b", "axxb", "a?b", "aXb", "a[x]b", "axb", "a%b", "a_b", "a\\b", "100%"];
    for (const [i, name] of names.entries()) await db.user.create({ data: { email: `u${String(i)}@x`, name } });
    const count = (pattern: string, op: "contains" | "startsWith" | "endsWith" = "contains"): Promise<unknown> =>
      db.user.count({ where: { name: { [op]: pattern } } });
    expect(await count("a*b")).toBe(1);
    expect(await count("a?b")).toBe(1);
    expect(await count("a[x]b")).toBe(1);
    expect(await count("a%b")).toBe(1);
    expect(await count("a_b")).toBe(1);
    expect(await count("a\\b")).toBe(1);
    expect(await count("*")).toBe(1);
    expect(await count("%")).toBe(2);
    expect(await count("a*", "startsWith")).toBe(1);
    expect(await count("*b", "endsWith")).toBe(1);
  });
});

describe("NUL characters", () => {
  it("are rejected in values, filters and keys without echoing the value", async () => {
    const db = await createTestClient();
    const secret = "nul-secret-value";
    const evil = `${secret}\0`;
    const results = await Promise.allSettled([
      db.user.create({ data: { email: evil } }),
      db.user.findMany({ where: { email: evil } }),
      db.user.findMany({ where: { email: { contains: evil } } }),
      db.user.findMany({ where: { email: { in: [evil] } } }),
    ]);
    // Key names may appear (sanitized, truncated) in the key path by design; values never do.
    const keyResults = await Promise.allSettled([
      db.user.findMany({ where: { [evil]: 1 } }),
      db.post.create({ data: { title: "t", meta: { [evil]: 1 }, authorId: 1 } }),
    ]);
    for (const result of [...results, ...keyResults]) {
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") continue;
      expect(result.reason).toBeInstanceOf(ValidationError);
      expect((result.reason as Error).message).not.toContain("\0");
    }
    for (const result of results) {
      if (result.status === "rejected") expect((result.reason as Error).message).not.toContain(secret);
    }
    expect(await db.user.count()).toBe(0);
  });
});

describe("whole corpus against one database", () => {
  it("leaves the schema and the data intact", async () => {
    const schema = loadSchema(BLOG_SCHEMA);
    const adapter = createSqliteAdapter({ url: "file::memory:" });
    await adapter.executeScript(sqliteDialect.createTables(indexSchema(schema)));
    const db = createRuntimeClient(schema, { adapter }) as unknown as Record<"user" | "post", RuntimeDelegate>;
    const owner = (await db.user.create({ data: { email: "owner@x" } })) as { id: number };
    await db.post.create({ data: { title: "keep", author: { connect: { id: owner.id } } } });

    for (const payload of INJECTION_PAYLOADS) {
      await db.user.create({ data: { email: payload, name: payload } });
      await db.user.findMany({ where: { OR: [{ email: payload }, { name: { contains: payload } }] } });
      await db.user.deleteMany({ where: { email: payload } });
      for (const build of Object.values(KEY_POSITIONS)) {
        const { op, args } = build(payload);
        await expect(db.user[op](args)).rejects.toBeInstanceOf(ValidationError);
      }
      await expect(db.user.findMany({ orderBy: { email: payload } })).rejects.toBeInstanceOf(ValidationError);
    }

    const tables = await adapter.query({
      text: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      params: [],
    });
    expect(tables.map((r) => r["name"])).toEqual(["Post", "User"]);
    expect(await db.user.count()).toBe(1);
    expect(await db.post.count()).toBe(1);
    await adapter.close();
  });
});
