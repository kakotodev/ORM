import { LimitExceededError, ValidationError } from "../../../src/errors.js";
import { DEFAULT_RUNTIME_LIMITS } from "../../../src/runtime/limits.js";
import { validateArgs, validateScalar, type Operation, type ValidatedArgs, type ValidatedFind } from "../../../src/runtime/validation.js";
import { loadSchema } from "../../../src/schema/index.js";
import { indexSchema, type FieldIR } from "../../../src/schema/ir.js";
import { BLOG_SCHEMA, minimalSchema } from "../../helpers/schemas.js";

const idx = indexSchema(loadSchema(BLOG_SCHEMA));
const L = DEFAULT_RUNTIME_LIMITS;
const v = (op: Operation, args: unknown) => validateArgs(idx, "User", op, args, L);
const p = (op: Operation, args: unknown) => validateArgs(idx, "Post", op, args, L);

function findOf(out: ValidatedArgs): ValidatedFind {
  if (out.op === "findMany" || out.op === "findFirst" || out.op === "count" || out.op === "findUnique") return out;
  throw new Error("not a find result");
}
const fv = (args: unknown) => findOf(v("findMany", args));
const fp = (args: unknown) => findOf(p("findMany", args));
const fu = (args: unknown) => findOf(v("findUnique", args));

function field(model: string, name: string): FieldIR {
  const f = idx.models.get(model)?.fields.get(name);
  if (f === undefined) throw new Error("missing field");
  return f;
}

function rejection(fn: () => unknown): ValidationError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    return e as ValidationError;
  }
  return expect.unreachable();
}

describe("validateArgs (brief)", () => {
  it("normalizes shorthand equality and nested logic", () => {
    expect(v("findMany", { where: { email: "a@b.c", OR: [{ name: null }, { name: { startsWith: "A" } }] } })).toMatchObject({
      where: { kind: "and", items: [
        { kind: "field", field: "email", op: "equals", value: "a@b.c" },
        { kind: "or", items: [{ kind: "field", field: "name", op: "equals", value: null }, { kind: "field", field: "name", op: "startsWith", value: "A" }] },
      ]},
    });
  });
  it.each([
    ["unknown field", { where: { passwrd: "x" } }, "where.passwrd"],
    ["operator object where scalar expected", { where: { email: { $ne: null } } }, "where.email.$ne"],
    ["__proto__ key", JSON.parse('{"where":{"__proto__":{"x":1}}}') as unknown, "where.__proto__"],
    ["undefined value", { where: { email: undefined } }, "where.email"],
    ["NUL byte", { where: { email: "a\u0000" } }, "where.email"],
    ["bad sort direction", { orderBy: { email: "asc; DROP TABLE User" } }, "orderBy.email"],
    ["non-plain object", { where: { email: new (class X { readonly x = 1 })() } }, "where.email"],
    ["select and include", { select: { id: true }, include: { posts: true } }, ""],
    ["unsafe Int", { where: { id: 2 ** 53 } }, "where.id"],
    ["invalid Date", { where: { createdAt: new Date("nope") } }, "where.createdAt"],
  ])("rejects %s", (_n, args, path) => {
    try { v("findMany", args); expect.unreachable(); }
    catch (e) { expect(e).toBeInstanceOf(ValidationError); expect((e as ValidationError).path).toContain(path); expect((e as Error).message).not.toMatch(/DROP|a@b/); }
  });
  it.each([
    ["take", { take: 1001 }], ["in list", { where: { id: { in: Array.from({ length: 1001 }, (_, i) => i) } } }],
    ["where depth", { where: { AND: { AND: { AND: { AND: { AND: { AND: { id: 1 } } } } } } } }],
    ["include depth", { include: { posts: { include: { author: { include: { posts: { include: { author: true } } } } } } } }],
  ])("enforces the %s limit", (_n, args) => { expect(() => v("findMany", args)).toThrow(LimitExceededError); });
  it("requires exactly one unique criterion for findUnique", () => {
    expect(() => v("findUnique", { where: { name: "x" } })).toThrow(ValidationError);
    expect(() => v("findUnique", { where: { id: 1, email: "a" } })).toThrow(ValidationError);
    expect(v("findUnique", { where: { email: "a" } })).toMatchObject({ op: "findUnique" });
  });
  it("requires where on deleteMany and updateMany", () => {
    expect(() => v("deleteMany", {})).toThrow(/where is required/);
    expect(v("deleteMany", { where: {} })).toMatchObject({ op: "deleteMany" });
  });
  it("validates create data against the schema", () => {
    expect(() => validateArgs(idx, "Post", "create", { data: { title: "t" } }, L)).toThrow(/author/); // neither authorId nor connect
    expect(validateArgs(idx, "Post", "create", { data: { title: "t", author: { connect: { id: 1 } } } }, L)).toMatchObject({ op: "create" });
    expect(() => validateArgs(idx, "Post", "create", { data: { title: "t", authorId: 1, author: { connect: { id: 1 } } } }, L)).toThrow(ValidationError);
    expect(() => validateArgs(idx, "User", "create", { data: { email: "e", posts: { create: [] } } }, L)).toThrow(/not supported/);
  });
  it("rejects case-insensitive mode and text ops on non-strings", () => {
    expect(() => v("findMany", { where: { email: { contains: "a", mode: "insensitive" } } })).toThrow(ValidationError);
    expect(() => v("findMany", { where: { id: { contains: "1" } } })).toThrow(ValidationError);
  });
});

describe("validateArgs: where", () => {
  it("normalizes empty where, NOT, arrays and multi-operator objects", () => {
    expect(v("findMany", { where: {} })).toMatchObject({ where: { kind: "and", items: [] } });
    expect(fv({ where: { NOT: { id: 1 } } }).where).toEqual({
      kind: "not", item: { kind: "field", field: "id", op: "equals", value: 1 },
    });
    expect(fv({ where: { NOT: [{ id: 1 }, { id: 2 }] } }).where).toEqual({
      kind: "not", item: { kind: "and", items: [
        { kind: "field", field: "id", op: "equals", value: 1 },
        { kind: "field", field: "id", op: "equals", value: 2 },
      ] },
    });
    expect(fv({ where: { AND: { id: 1 } } }).where).toEqual({
      kind: "and", items: [{ kind: "field", field: "id", op: "equals", value: 1 }],
    });
    expect(fv({ where: { id: { gte: 1, lt: 5 } } }).where).toEqual({
      kind: "and", items: [
        { kind: "field", field: "id", op: "gte", value: 1 },
        { kind: "field", field: "id", op: "lt", value: 5 },
      ],
    });
  });
  it("accepts five levels of nesting", () => {
    expect(() => v("findMany", { where: { AND: { AND: { AND: { AND: { AND: { id: 1 } } } } } } })).not.toThrow();
  });
  it("counts relation filters toward the where depth", () => {
    const deep = { posts: { some: { author: { is: { posts: { some: { author: { is: { posts: { none: { author: { is: { id: 1 } } } } } } } } } } } } };
    expect(() => v("findMany", { where: deep })).toThrow(LimitExceededError);
  });
  it("builds relation filters", () => {
    expect(fv({ where: { posts: { some: { published: true } } } }).where).toEqual({
      kind: "relation", field: "posts", op: "some", filter: { kind: "field", field: "published", op: "equals", value: true },
    });
    expect(fp({ where: { author: { isNot: null } } }).where).toEqual({
      kind: "relation", field: "author", op: "isNot", filter: null,
    });
    rejection(() => v("findMany", { where: { posts: { is: {} } } }));
    rejection(() => p("findMany", { where: { author: { some: {} } } }));
    rejection(() => v("findMany", { where: { posts: { some: null } } }));
  });
  it("restricts operators per type", () => {
    expect(rejection(() => p("findMany", { where: { meta: { equals: 1 } } })).path).toBe("where.meta");
    expect(rejection(() => p("findMany", { where: { rating: { gt: "1" } } })).path).toBe("where.rating.gt");
    expect(rejection(() => p("findMany", { where: { published: { lt: true } } })).path).toBe("where.published.lt");
    expect(rejection(() => v("findMany", { where: { role: { contains: "U" } } })).path).toBe("where.role.contains");
    expect(rejection(() => v("findMany", { where: { role: "ROOT" } })).path).toBe("where.role");
    expect(rejection(() => v("findMany", { where: { id: { in: [1, null] } } })).path).toBe("where.id.in.1");
    expect(rejection(() => v("findMany", { where: { id: { in: 1 } } })).path).toBe("where.id.in");
    expect(rejection(() => v("findMany", { where: { id: { lt: null } } })).path).toBe("where.id.lt");
    expect(rejection(() => v("findMany", { where: { OR: [{ id: 1 }, { nme: "x" }] } })).path).toBe("where.OR.1.nme");
    expect(rejection(() => v("findMany", { where: { email: {} } })).path).toBe("where.email");
    expect(fv({ where: { email: { not: null } } }).where).toEqual({ kind: "field", field: "email", op: "not", value: null });
  });
  it("normalizes BigInt filter values and copies arrays", () => {
    const list = [1, 2];
    const where = fp({ where: { views: { in: list } } }).where;
    expect(where).toEqual({ kind: "field", field: "views", op: "in", value: [1n, 2n] });
    expect(where !== undefined && where.kind === "field" && where.value !== list).toBe(true);
  });
  it("rejects accessor properties, symbols-only tricks and constructor keys", () => {
    const withGetter = {};
    Object.defineProperty(withGetter, "email", { enumerable: true, get: () => "x" });
    expect(rejection(() => v("findMany", { where: withGetter })).path).toBe("where.email");
    expect(rejection(() => v("findMany", { where: { constructor: 1 } })).path).toBe("where.constructor");
    expect(rejection(() => v("findMany", { where: [] })).path).toBe("where");
    // eslint-disable-next-line no-sparse-arrays -- a hole must be rejected like undefined
    expect(rejection(() => v("findMany", { where: { OR: [{ id: 1 }, , { id: 2 }] } })).path).toBe("where.OR.1");
  });
  it("accepts null-prototype objects", () => {
    const where = Object.create(null) as Record<string, unknown>;
    where.id = 1;
    expect(fv({ where }).where).toEqual({ kind: "field", field: "id", op: "equals", value: 1 });
  });
});

describe("validateArgs: options", () => {
  it("rejects non-object args and unknown options", () => {
    expect(rejection(() => v("findMany", undefined)).path).toBe("");
    expect(rejection(() => v("findMany", { limit: 1 })).path).toBe("limit");
    expect(rejection(() => v("count", { select: { id: true } })).path).toBe("select");
    expect(rejection(() => v("findUnique", { where: { id: 1 }, take: 1 })).path).toBe("take");
  });
  it("normalizes select, include and orderBy", () => {
    expect(v("findMany", {
      select: { id: true, email: true }, orderBy: [{ email: "desc" }, { id: "asc" }], take: 10, skip: 0,
    })).toEqual({ op: "findMany", select: ["id", "email"], include: [], orderBy: [
      { field: "email", direction: "desc" }, { field: "id", direction: "asc" },
    ], take: 10, skip: 0 });
    expect(fv({ include: { posts: { where: { published: true }, orderBy: { id: "desc" }, select: { title: true } } } }).include).toEqual([
      { relation: "posts", where: { kind: "field", field: "published", op: "equals", value: true },
        orderBy: [{ field: "id", direction: "desc" }], select: ["title"], include: [] },
    ]);
    expect(fv({ include: { posts: true } }).include).toEqual([{ relation: "posts", orderBy: [], include: [] }]);
    expect(fv({ include: { posts: { include: { author: { include: { posts: true } } } } } }).include).toHaveLength(1);
  });
  it.each([
    ["select false", { select: { id: false } }, "select.id"],
    ["empty select", { select: {} }, "select"],
    ["select relation", { select: { posts: true } }, "select.posts"],
    ["include scalar", { include: { email: true } }, "include.email"],
    ["include false", { include: { posts: false } }, "include.posts"],
    ["include unknown option", { include: { posts: { take: 1 } } }, "include.posts.take"],
    ["nested select and include", { include: { posts: { select: { id: true }, include: { author: true } } } }, "include.posts"],
    ["orderBy two keys", { orderBy: { id: "asc", email: "desc" } }, "orderBy"],
    ["orderBy Json", null, ""],
    ["negative take", { take: -1 }, "take"],
    ["fractional skip", { skip: 1.5 }, "skip"],
  ])("rejects %s", (_n, args, path) => {
    if (args === null) {
      expect(rejection(() => p("findMany", { orderBy: { meta: "asc" } })).path).toBe("orderBy.meta");
      return;
    }
    expect(rejection(() => v("findMany", args)).path).toBe(path);
  });
  it("limits skip", () => {
    expect(() => v("findMany", { skip: 1_000_001 })).toThrow(LimitExceededError);
    expect(v("findMany", { skip: 1_000_000 })).toMatchObject({ skip: 1_000_000 });
  });
  it("rejects where options on to-one includes", () => {
    expect(rejection(() => p("findMany", { include: { author: { where: { id: 1 } } } })).path).toBe("include.author.where");
  });
});

describe("validateArgs: unique where", () => {
  const COMPOSITE = minimalSchema("model M {\n id Int @id\n a String\n b Int\n @@unique([a, b])\n}");
  const cidx = indexSchema(loadSchema(COMPOSITE));
  it("accepts composite keys", () => {
    expect(findOf(validateArgs(cidx, "M", "findUnique", { where: { a_b: { b: 2, a: "x" } } }, L)).where).toEqual({
      kind: "and", items: [
        { kind: "field", field: "a", op: "equals", value: "x" },
        { kind: "field", field: "b", op: "equals", value: 2 },
      ],
    });
    rejection(() => validateArgs(cidx, "M", "findUnique", { where: { a_b: { a: "x" } } }, L));
    rejection(() => validateArgs(cidx, "M", "findUnique", { where: { a_b: { a: "x", b: 2, c: 1 } } }, L));
    rejection(() => validateArgs(cidx, "M", "findUnique", { where: { a: "x" } }, L));
  });
  it("requires strict equality on the unique value", () => {
    expect(fu({ where: { id: 1 } }).where).toEqual({ kind: "field", field: "id", op: "equals", value: 1 });
    expect(rejection(() => v("findUnique", { where: { id: { gt: 1 } } })).path).toBe("where.id");
    expect(rejection(() => v("findUnique", { where: { email: null } })).path).toBe("where.email");
    rejection(() => v("findUnique", { where: {} }));
    rejection(() => v("findUnique", {}));
    rejection(() => v("update", { where: { name: "x" }, data: { name: "y" } }));
    rejection(() => v("delete", { where: { id: 1, name: "x" } }));
  });
});

describe("validateArgs: data", () => {
  it("returns validated values and connects in fresh containers", () => {
    const meta = { tags: ["a"], nested: { n: 1 } };
    const out = p("create", { data: { title: "t", views: 5, meta, author: { connect: { email: "a" } } } });
    if (out.op !== "create") return expect.unreachable();
    expect(out.data.values.get("views")).toBe(5n);
    expect(out.data.values.get("meta")).toEqual(meta);
    expect(out.data.values.get("meta")).not.toBe(meta);
    expect(out.data.connects.get("author")).toEqual({ kind: "field", field: "email", op: "equals", value: "a" });
    expect(out.include).toEqual([]);
  });
  it("applies create rules", () => {
    expect(rejection(() => v("create", { data: { email: "e", id: 3 } })).path).toBe("data.id");
    expect(rejection(() => v("create", { data: { name: "n" } })).path).toBe("data.email");
    expect(rejection(() => v("create", { data: { email: "e", role: null } })).path).toBe("data.role");
    expect(rejection(() => p("create", { data: { title: "t", authorId: 1, author: { create: {} } } })).message).toMatch(/not supported/);
    expect(rejection(() => p("create", { data: { title: "t", authorId: 1, rating: 1.5 } })).path).toBe("data.rating");
    expect(rejection(() => p("create", { data: { title: "t", authorId: 1, meta: { __proto__: null, x: undefined } } })).path).toBe("data.meta.x");
    expect(rejection(() => p("create", { data: { title: "t", authorId: 1, meta: new Map() } })).path).toBe("data.meta");
    expect(p("create", { data: { title: "t", authorId: 1, rating: "-12.50", cover: new Uint8Array([1]) } })).toMatchObject({ op: "create" });
  });
  it("applies update rules", () => {
    expect(rejection(() => v("update", { where: { id: 1 }, data: {} })).path).toBe("data");
    expect(rejection(() => v("update", { where: { id: 1 }, data: { id: 2 } })).path).toBe("data.id");
    expect(rejection(() => v("update", { where: { id: 1 }, data: { name: undefined } })).path).toBe("data.name");
    const out = v("update", { where: { id: 1 }, data: { name: null } });
    if (out.op !== "update") return expect.unreachable();
    expect(out.data.values.get("name")).toBeNull();
    expect(v("updateMany", { where: {}, data: { name: "x" } })).toMatchObject({ op: "updateMany" });
    expect(() => v("updateMany", { data: { name: "x" } })).toThrow("where is required (use {} to target all rows)");
  });
  it("validates upsert and createMany", () => {
    expect(v("upsert", { where: { email: "a" }, create: { email: "a" }, update: { name: "n" } })).toMatchObject({ op: "upsert" });
    expect(rejection(() => v("upsert", { where: { email: "a" }, create: {}, update: { name: "n" } })).path).toBe("create.email");
    const many = p("createMany", { data: [{ title: "a", authorId: 1 }, { title: "b", authorId: 2 }] });
    if (many.op !== "createMany") return expect.unreachable();
    expect(many.data).toHaveLength(2);
    expect(rejection(() => p("createMany", { data: [] })).path).toBe("data");
    expect(rejection(() => p("createMany", { data: [{ title: "a", author: { connect: { id: 1 } } }] })).path).toBe("data.0.author");
    const tooMany = Array.from({ length: 1001 }, () => ({ title: "a", authorId: 1 }));
    expect(() => p("createMany", { data: tooMany })).toThrow(LimitExceededError);
  });
});

describe("validateScalar", () => {
  it.each([
    ["Int", "User", "id", 1.5],
    ["BigInt", "Post", "views", 2 ** 63],
    ["BigInt range", "Post", "views", 2n ** 63n],
    ["BigInt string", "Post", "views", "1"],
    ["Decimal", "Post", "rating", "1e5"],
    ["Decimal precision", "Post", "rating", "1." + "1".repeat(31)],
    ["String", "User", "email", 1],
    ["DateTime year", "User", "createdAt", new Date("+010000-01-01T00:00:00Z")],
    ["Bytes", "Post", "cover", [1, 2]],
    ["Json NaN", "Post", "meta", { n: Number.NaN }],
    ["Json bigint", "Post", "meta", 1n],
    ["Json NUL", "Post", "meta", ["a\u0000"]],
    ["forged Date", "User", "createdAt", Object.create(Date.prototype) as unknown],
    ["forged Uint8Array", "Post", "cover", Object.create(Uint8Array.prototype) as unknown],
    ["non-nullable null", "User", "email", null],
    ["relation", "Post", "author", 1],
  ])("rejects bad %s values", (_n, model, name, value) => {
    expect(rejection(() => validateScalar(idx, field(model, name), value, "x", L)).path).toMatch(/^x/);
  });
  it("limits Json depth and string length", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 33; i++) deep = [deep];
    rejection(() => validateScalar(idx, field("Post", "meta"), deep, "x", L));
    rejection(() => validateScalar(idx, field("User", "email"), "ab", "x", { ...L, maxStringLength: 1 }));
  });
  it("normalizes and copies values", () => {
    expect(validateScalar(idx, field("Post", "views"), 7, "x", L)).toBe(7n);
    const date = new Date("2020-01-01T00:00:00Z");
    const out = validateScalar(idx, field("User", "createdAt"), date, "x", L);
    expect(out).toEqual(date);
    expect(out).not.toBe(date);
    const bytes = new Uint8Array([1]);
    expect(validateScalar(idx, field("Post", "cover"), bytes, "x", L)).not.toBe(bytes);
    expect(validateScalar(idx, field("Post", "rating"), null, "x", L)).toBeNull();
    rejection(() => validateScalar(idx, field("Post", "views"), 2.5, "x", L));
  });
});
