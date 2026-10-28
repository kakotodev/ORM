import { createSqliteAdapter } from "../../src/adapters/sqlite.js";
import { sqliteDialect } from "../../src/dialects/sqlite.js";
import { OrmError, SchemaError, ValidationError } from "../../src/errors.js";
import { generateClient } from "../../src/generator/client.js";
import { resetDatabase } from "../../src/migrations/runner.js";
import { createRuntimeClient } from "../../src/runtime/client.js";
import { loadSchema } from "../../src/schema/index.js";
import { indexSchema } from "../../src/schema/ir.js";
import { createTestClient } from "../helpers/db.js";
import { BLOG_SCHEMA, minimalSchema } from "../helpers/schemas.js";

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
  // Optional IR fields and optional client / adapter / migration options.
  default: { kind: "literal", value: "polluted-default" },
  debug: true,
  env: { DATABASE_URL: "file:./polluted-env.sqlite", NODE_ENV: "polluted" },
  url: "file:./polluted-url.sqlite",
  provider: "postgresql",
  limits: { maxTake: 0, maxRows: 0 },
  force: true,
  adapter: { dialect: {}, query: () => Promise.reject(new Error("polluted adapter")) },
  transactionTimeoutMs: -1,
  now: () => new Date(0),
};

function summary(err: unknown): string {
  if (!(err instanceof OrmError)) throw new Error("expected an OrmError");
  return `${err.name}|${err.code}|${err.message}|debug=${String(Object.hasOwn(err, "debug"))}`;
}

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return summary(err);
  }
  return "no error";
}

const DEFAULT_VARIANTS: unknown[] = [
  POLLUTED["default"],
  { kind: "autoincrement" },
  { kind: "now" },
  { kind: "uuid" },
];

const PLAIN_SCHEMA = minimalSchema("model A {\n  id Int @id\n  n String?\n  s String\n}");

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

  // Required fields stay required, constraint errors stay quiet, DDL and options are unchanged.
  out.push(await failure(db.user.create({ data: {} })));
  out.push(await failure(db.post.create({ data: { title: "no author" } })));
  await db.user.create({ data: { email: "dup@x" } });
  out.push(await failure(db.user.create({ data: { email: "dup@x" } })));
  const schema = loadSchema(BLOG_SCHEMA);
  out.push(sqliteDialect.createTables(indexSchema(schema)));
  try {
    createRuntimeClient(schema, {});
    out.push("client opened");
  } catch (err) {
    out.push(summary(err));
  }
  try {
    createRuntimeClient(schema, { url: "file::memory:" });
    out.push("client opened");
  } catch (err) {
    out.push(summary(err));
  }
  // A model whose fields have no default at all: nothing may be inferred for them.
  const plain = await createTestClient<"a">(PLAIN_SCHEMA);
  out.push(sqliteDialect.createTables(indexSchema(loadSchema(PLAIN_SCHEMA))));
  out.push(await failure(plain.a.create({ data: { id: 1 } })));
  out.push(await plain.a.create({ data: { id: 2, s: "x" } }));
  out.push(await plain.a.createMany({ data: [{ id: 3, s: "y" }, { id: 4, s: "z", n: "n" }] }));
  out.push(await plain.a.findMany({ orderBy: { id: "asc" } }));
  const adapter = createSqliteAdapter({ url: "file::memory:" });
  out.push(await failure(resetDatabase({ schema, adapter, dir: "unused" } as unknown as Parameters<typeof resetDatabase>[0])));
  out.push(await failure(adapter.query({ text: "SELECT * FROM nope", params: [] })));
  await adapter.close();
  return JSON.stringify(out, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

describe("inherited properties", () => {
  it("polluting Object.prototype never changes what a query does", async () => {
    const clean = await battery();
    expect(clean.length).toBeGreaterThan(100);
    const mask = (text: string): string => text.replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, '"D"');
    // `default` is polluted with several shapes: each one must be ignored.
    for (const variant of DEFAULT_VARIANTS) {
      const pollution = { ...POLLUTED, default: variant };
      for (const [k, v] of Object.entries(pollution)) {
        Object.defineProperty(Object.prototype, k, { value: v, configurable: true, writable: true, enumerable: true });
      }
      try {
        expect(mask(await battery())).toBe(mask(clean));
      } finally {
        for (const k of Object.keys(pollution)) Reflect.deleteProperty(Object.prototype, k);
      }
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

/** Defines `values` on Object.prototype for the duration of `fn`. */
function withPollution<T>(values: Record<string, unknown>, fn: () => T): T {
  for (const [k, v] of Object.entries(values)) {
    Object.defineProperty(Object.prototype, k, { value: v, configurable: true, writable: true, enumerable: true });
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(values)) Reflect.deleteProperty(Object.prototype, k);
  }
}

function schemaOutcome(source: string): string {
  try {
    return JSON.stringify(loadSchema(source));
  } catch (err) {
    if (!(err instanceof SchemaError)) throw err;
    return `${err.message}|${JSON.stringify(err.diagnostics)}`;
  }
}

describe("inherited generator and schema options", () => {
  it("a polluted runtimeImport never changes the generated client", () => {
    const schema = loadSchema(BLOG_SCHEMA);
    const clean = generateClient(schema);
    const polluted = withPollution({ runtimeImport: "polluted-runtime" }, () => generateClient(schema));
    expect(polluted).toEqual(clean);
    expect(polluted["index.js"]).not.toContain("polluted");
  });

  it("polluted limits, file or limit keys never change what loadSchema does", () => {
    // The blog schema nests calls two levels deep (`@default(autoincrement())`) and has long identifiers.
    const sources = [BLOG_SCHEMA, minimalSchema("model A {\n  id Nope @id\n}"), "model {"];
    const clean = sources.map(schemaOutcome);
    expect(clean[0]).not.toContain("Schema is invalid");
    for (const pollution of [
      { maxSourceBytes: 10, maxIdentifierLength: 1, maxStringLength: 1, maxNestingDepth: 1 },
      { maxSourceBytes: 10_000_000, maxIdentifierLength: 10_000, maxStringLength: 10_000_000, maxNestingDepth: 10_000 },
      { limits: { maxSourceBytes: 10, maxIdentifierLength: 1, maxStringLength: 1, maxNestingDepth: 1 } },
      { file: "polluted.orm" },
    ]) {
      expect(withPollution(pollution, () => sources.map(schemaOutcome))).toEqual(clean);
    }
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
