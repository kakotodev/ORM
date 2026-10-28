import { sqliteDialect } from "../../../src/dialects/sqlite.js";
import { DEFAULT_RUNTIME_LIMITS } from "../../../src/runtime/limits.js";
import { buildCount, selectedColumns } from "../../../src/runtime/query-builder.js";
import { compileFind, ctx } from "../../helpers/builder.js";

describe("read query builder", () => {
  it("builds a filtered, sorted, paginated select", () => {
    const q = compileFind(
      "User",
      { where: { email: { contains: "@x.io" } }, select: { id: true, email: true }, orderBy: [{ createdAt: "desc" }], take: 20, skip: 40 },
      "many",
    );
    expect(q.text).toBe(
      'SELECT "t0"."id" AS "id", "t0"."email" AS "email" FROM "User" AS "t0" WHERE "t0"."email" GLOB ? ORDER BY "t0"."createdAt" DESC LIMIT ? OFFSET ?',
    );
    expect(q.params).toEqual(["*@x.io*", 20, 40]);
  });

  it("caps unbounded findMany at maxRows + 1", () => {
    expect(compileFind("User", {}, "many").params.at(-1)).toBe(DEFAULT_RUNTIME_LIMITS.maxRows + 1);
  });

  it("limits first and unique to one row", () => {
    expect(compileFind("User", {}, "first").params).toEqual([1]);
    expect(compileFind("User", { take: 5 }, "unique").params).toEqual([1]);
  });

  it("compiles relation filters to EXISTS subqueries", () => {
    const q = compileFind("User", { where: { posts: { some: { published: true } } } }, "many");
    expect(q.text).toContain('EXISTS (SELECT 1 FROM "Post" AS "t1" WHERE "t1"."authorId" = "t0"."id" AND "t1"."published" = ?)');
    expect(compileFind("User", { where: { posts: { every: { published: true } } } }, "many").text).toContain(
      'NOT EXISTS (SELECT 1 FROM "Post" AS "t1" WHERE "t1"."authorId" = "t0"."id" AND NOT ("t1"."published" = ?))',
    );
    expect(compileFind("User", { where: { posts: { none: {} } } }, "many").text).toContain(
      'NOT EXISTS (SELECT 1 FROM "Post" AS "t1" WHERE "t1"."authorId" = "t0"."id")',
    );
  });

  it("compiles to-one relation filters through the parent foreign key", () => {
    const is = compileFind("Post", { where: { author: { is: { role: "ADMIN" } } } }, "many");
    expect(is.text).toContain('EXISTS (SELECT 1 FROM "User" AS "t1" WHERE "t1"."id" = "t0"."authorId" AND "t1"."role" = ?)');
    expect(compileFind("Post", { where: { author: { isNot: { role: "ADMIN" } } } }, "many").text).toContain("NOT EXISTS");
    expect(compileFind("Post", { where: { author: { is: null } } }, "many").text).toContain('"t0"."authorId" IS NULL');
  });

  it("uses a fresh alias for every nested subquery", () => {
    const q = compileFind("User", { where: { posts: { some: { author: { is: { email: "a" } } } } } }, "many");
    expect(q.text).toContain('"t1"');
    expect(q.text).toContain('"t2"');
  });

  it("treats not on a nullable column like Prisma", () => {
    expect(compileFind("User", { where: { name: { not: "A" } } }, "many").text).toContain('("t0"."name" <> ? OR "t0"."name" IS NULL)');
    expect(compileFind("User", { where: { email: { not: "A" } } }, "many").text).toContain('"t0"."email" <> ?');
  });

  it("maps null comparisons to IS NULL", () => {
    expect(compileFind("User", { where: { name: null } }, "many").text).toContain('"t0"."name" IS NULL');
    expect(compileFind("User", { where: { name: { not: null } } }, "many").text).toContain('"t0"."name" IS NOT NULL');
  });

  it("renders empty in / notIn lists as constants", () => {
    expect(compileFind("User", { where: { id: { in: [] } } }, "many").text).toContain("WHERE 0");
    expect(compileFind("User", { where: { id: { notIn: [] } } }, "many").text).toContain("WHERE 1");
  });

  it("builds or / not groups", () => {
    const q = compileFind("User", { where: { OR: [{ id: 1 }, { id: 2 }], NOT: { name: "x" } } }, "many");
    expect(q.text).toContain('("t0"."id" = ? OR "t0"."id" = ?) AND NOT ("t0"."name" = ?)');
  });

  it("encodes DateTime and Boolean params", () => {
    const d = new Date("2026-01-01T00:00:00.000Z");
    expect(compileFind("Post", { where: { published: true, updatedAt: { gte: d } } }, "many").params.slice(0, 2)).toEqual([1, d.toISOString()]);
  });

  it("builds count queries", () => {
    expect(sqliteDialect.compile(buildCount(ctx(), "User", { include: [], orderBy: [] })).text).toBe(
      'SELECT COUNT(*) AS "count" FROM "User" AS "t0"',
    );
  });

  it("selects scalar and enum fields by default, plus missing extras", () => {
    const c = ctx();
    expect(selectedColumns(c, "User").map((s) => s.as)).toEqual(["id", "email", "name", "role", "createdAt"]);
    expect(selectedColumns(c, "User", ["email"], ["id", "email"])).toEqual([
      { column: "email", as: "email" },
      { column: "id", as: "id" },
    ]);
  });
});
