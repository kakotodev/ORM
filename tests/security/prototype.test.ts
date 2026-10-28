import { SchemaError, ValidationError } from "../../src/errors.js";
import { loadSchema } from "../../src/schema/index.js";
import { createTestClient } from "../helpers/db.js";
import { minimalSchema } from "../helpers/schemas.js";

const POLLUTION = '{"polluted":"yes"}';
const FORBIDDEN = ["__proto__", "constructor", "prototype"] as const;

/** Builds an argument object with `JSON.parse`, the only way to create an own `__proto__` key. */
function json(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

function nested(key: string): Record<string, string> {
  // `constructor` and `prototype` are attacks through a chain; `__proto__` is the direct one.
  return {
    direct: `{"${key}":${POLLUTION}}`,
    chained: `{"${key}":{"prototype":${POLLUTION}}}`,
  };
}

type Build = (payload: string) => { op: "findMany" | "create" | "update"; args: Record<string, unknown> };

const POSITIONS: Record<string, Build> = {
  "where": (p) => ({ op: "findMany", args: json(`{"where":${p}}`) }),
  "where filter": (p) => ({ op: "findMany", args: json(`{"where":{"email":${p}}}`) }),
  "where logical": (p) => ({ op: "findMany", args: json(`{"where":{"OR":[${p}]}}`) }),
  "where relation filter": (p) => ({ op: "findMany", args: json(`{"where":{"posts":{"some":${p}}}}`) }),
  "select": (p) => ({ op: "findMany", args: json(`{"select":${p}}`) }),
  "include": (p) => ({ op: "findMany", args: json(`{"include":${p}}`) }),
  "include options": (p) => ({ op: "findMany", args: json(`{"include":{"posts":${p}}}`) }),
  "orderBy": (p) => ({ op: "findMany", args: json(`{"orderBy":${p}}`) }),
  "data": (p) => ({ op: "create", args: json(`{"data":{"email":"x","name":"n",${p.slice(1, -1)}}}`) }),
  "update data": (p) => ({ op: "update", args: json(`{"where":{"id":1},"data":${p}}`) }),
  "top level": (p) => ({ op: "findMany", args: json(p) }),
};

describe.each(FORBIDDEN)("forbidden key %s", (key) => {
  describe.each(Object.entries(nested(key)))("%s", (_shape, payload) => {
    it.each(Object.keys(POSITIONS))("is rejected in %s and pollutes nothing", async (position) => {
      const db = await createTestClient();
      await db.user.create({ data: { email: "seed@x" } });
      const build = POSITIONS[position];
      if (build === undefined) throw new Error("unknown position");
      const { op, args } = build(payload);
      await expect(db.user[op](args)).rejects.toBeInstanceOf(ValidationError);
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
      expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
      expect(await db.user.count()).toBe(1);
    });
  });

  it("is rejected as a key inside a Json value, at any depth, and is never stored", async () => {
    const db = await createTestClient();
    const user = (await db.user.create({ data: { email: "a@x" } })) as { id: number };
    for (const meta of [
      json(`{"${key}":${POLLUTION}}`),
      json(`{"a":{"b":[{"${key}":${POLLUTION}}]}}`),
      json(`{"a":{"${key}":1}}`),
    ]) {
      await expect(db.post.create({ data: { title: "t", authorId: user.id, meta } })).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(await db.post.count()).toBe(0);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("is rejected as a model or field name in a schema", () => {
    expect(() => loadSchema(minimalSchema(`model ${key} {\n id Int @id\n}`))).toThrow(SchemaError);
    expect(() => loadSchema(minimalSchema(`model A {\n id Int @id\n ${key} String\n}`))).toThrow(SchemaError);
  });
});

/** Hostile values for every optional property internal objects (validated args, query AST) may lack. */
const POLLUTED: Record<string, unknown> = {
  where: { kind: "field", field: "id", op: "equals", value: -1 },
  select: ["id"],
  take: 0,
  skip: 1000,
  limit: 0,
  offset: 1000,
  returning: [],
  filter: null,
};

async function battery(): Promise<string> {
  const db = await createTestClient();
  const out: unknown[] = [];
  const u1 = (await db.user.create({ data: { email: "a@x", name: "A" } })) as { id: number };
  await db.user.create({ data: { email: "b@x" } });
  await db.post.createMany({ data: [{ title: "p1", authorId: u1.id }, { title: "p2", authorId: u1.id }] });
  out.push(await db.user.findMany({}));
  out.push(await db.user.findMany({ include: { posts: true } }));
  out.push(await db.user.findMany({ include: { posts: { orderBy: { title: "asc" } } } }));
  out.push(await db.user.findFirst({}));
  out.push(await db.user.findUnique({ where: { id: u1.id }, include: { posts: true } }));
  out.push(await db.user.count());
  out.push(await db.user.count({ where: { name: { not: null } } }));
  out.push(await db.post.findMany({ include: { author: true } }));
  out.push(await db.user.update({ where: { id: u1.id }, data: { name: "A2" } }));
  out.push(await db.user.upsert({ where: { email: "c@x" }, create: { email: "c@x" }, update: { name: "u" } }));
  out.push(await db.user.updateMany({ where: {}, data: { name: "all" } }));
  out.push(await db.user.delete({ where: { email: "c@x" }, include: { posts: true } }));
  out.push(await db.post.deleteMany({ where: {} }));
  out.push(await db.user.deleteMany({ where: {} }));
  return JSON.stringify(out, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

describe("inherited properties", () => {
  it("polluting Object.prototype never changes what a query does", async () => {
    const clean = await battery();
    expect(clean.length).toBeGreaterThan(100);
    for (const [k, v] of Object.entries(POLLUTED)) {
      Object.defineProperty(Object.prototype, k, { value: v, configurable: true, writable: true, enumerable: true });
    }
    try {
      const polluted = await battery();
      // Dates differ between runs; compare the structure with timestamps masked.
      const mask = (text: string): string => text.replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, '"D"');
      expect(mask(polluted)).toBe(mask(clean));
    } finally {
      for (const k of Object.keys(POLLUTED)) Reflect.deleteProperty(Object.prototype, k);
    }
  });

  it("do not make unknown field names valid (own-property lookups only)", async () => {
    const db = await createTestClient();
    for (const name of ["toString", "hasOwnProperty", "valueOf", "__defineGetter__", "isPrototypeOf"]) {
      await expect(db.user.findMany({ where: { [name]: 1 } })).rejects.toBeInstanceOf(ValidationError);
      await expect(db.user.findMany({ select: { [name]: true } })).rejects.toBeInstanceOf(ValidationError);
      await expect(db.user.create({ data: { email: "x", [name]: 1 } })).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("do not expose delegates or operations that do not exist", async () => {
    const db = await createTestClient();
    const bag = db as unknown as Record<string, unknown>;
    expect(Object.getPrototypeOf(db)).toBeNull();
    expect(bag["constructor"]).toBeUndefined();
    expect(bag["__proto__"]).toBeUndefined();
    expect(Reflect.get(bag, "toString")).toBeUndefined();
    const user = db.user as unknown as Record<string, unknown>;
    expect(Reflect.get(user, "constructor")).toBeUndefined();
    expect(Reflect.get(user, "hasOwnProperty")).toBeUndefined();
  });
});

describe("query results", () => {
  it("are plain objects with schema fields only, at every level", async () => {
    const db = await createTestClient();
    const user = (await db.user.create({ data: { email: "a@x", name: "A" } })) as { id: number };
    await db.post.create({ data: { title: "P", authorId: user.id, meta: { k: [1, { n: null }] } } });
    const schemaUser = ["createdAt", "email", "id", "name", "role"];
    const schemaPost = ["authorId", "cover", "id", "meta", "published", "rating", "title", "updatedAt", "views"];

    const rows = (await db.user.findMany({ include: { posts: true } })) as Record<string, unknown>[];
    const posts = (await db.post.findMany({ include: { author: true } })) as Record<string, unknown>[];
    for (const row of rows) {
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      expect(Object.keys(row).sort()).toEqual([...schemaUser, "posts"].sort());
      for (const post of row["posts"] as Record<string, unknown>[]) {
        expect(Object.getPrototypeOf(post)).toBe(Object.prototype);
        expect(Object.keys(post).sort()).toEqual(schemaPost);
      }
    }
    for (const post of posts) {
      expect(Object.keys(post).sort()).toEqual([...schemaPost, "author"].sort());
      const author = post["author"] as Record<string, unknown>;
      expect(Object.getPrototypeOf(author)).toBe(Object.prototype);
      expect(Object.keys(author).sort()).toEqual(schemaUser);
    }
    const [selected] = (await db.user.findMany({ select: { email: true } })) as Record<string, unknown>[];
    expect(Object.getPrototypeOf(selected)).toBe(Object.prototype);
    expect(Object.keys(selected ?? {})).toEqual(["email"]);
    const meta = ((await db.post.findFirst({ select: { meta: true } })) as { meta: Record<string, unknown> }).meta;
    expect(Object.getPrototypeOf(meta)).toBe(Object.prototype);
  });
});
