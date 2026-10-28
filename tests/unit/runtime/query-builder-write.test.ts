import { sqliteDialect } from "../../../src/dialects/sqlite.js";
import { OrmError } from "../../../src/errors.js";
import { DEFAULT_RUNTIME_LIMITS } from "../../../src/runtime/limits.js";
import {
  buildDelete,
  buildInsert,
  buildUpdate,
  createBuildContext,
  resolvedConnectColumns,
} from "../../../src/runtime/query-builder.js";
import { validateArgs } from "../../../src/runtime/validation.js";
import { loadSchema } from "../../../src/schema/index.js";
import { indexSchema } from "../../../src/schema/ir.js";
import { ctx, validatedRows, validatedWhere, validatedWrite } from "../../helpers/builder.js";
import { minimalSchema } from "../../helpers/schemas.js";

const env = { now: new Date("2026-10-28T00:00:00.000Z"), uuid: () => "00000000-0000-4000-8000-000000000000" };

describe("write query builder", () => {
  it("inserts with runtime defaults and RETURNING", () => {
    const { data } = validatedWrite("User", "create", { data: { email: "a@b.c" } });
    const q = sqliteDialect.compile(buildInsert(ctx(), "User", [data], env, ["id", "email"]));
    expect(q.text).toBe(
      'INSERT INTO "User" ("email", "role", "createdAt") VALUES (?, ?, ?) RETURNING "id" AS "id", "email" AS "email"',
    );
    expect(q.params).toEqual(["a@b.c", "USER", "2026-10-28T00:00:00.000Z"]);
  });

  it("sets @updatedAt on update", () => {
    const a = validatedWrite("Post", "update", { where: { id: 1 }, data: { title: "x" } });
    const q = sqliteDialect.compile(buildUpdate(ctx(), "Post", a.where, a.data, env, ["id"]));
    expect(q.text).toBe('UPDATE "Post" AS "t0" SET "title" = ?, "updatedAt" = ? WHERE "t0"."id" = ? RETURNING "id" AS "id"');
    expect(q.params).toEqual(["x", "2026-10-28T00:00:00.000Z", 1]);
  });

  it("keeps an explicit @updatedAt value", () => {
    const when = new Date("2020-01-01T00:00:00.000Z");
    const a = validatedWrite("Post", "update", { where: { id: 1 }, data: { updatedAt: when } });
    const q = sqliteDialect.compile(buildUpdate(ctx(), "Post", a.where, a.data, env, []));
    expect(q.params).toEqual(["2020-01-01T00:00:00.000Z", 1]);
  });

  it("omits WHERE for updateMany with {}", () => {
    const a = validatedWrite("Post", "updateMany", { where: {}, data: { title: "x" } });
    const q = sqliteDialect.compile(buildUpdate(ctx(), "Post", a.where, a.data, env, []));
    expect(q.text).toBe('UPDATE "Post" AS "t0" SET "title" = ?, "updatedAt" = ?');
  });

  it("builds a multi-row insert with aligned columns", () => {
    const rows = validatedRows("User", { data: [{ email: "a" }, { email: "b", name: "B" }] });
    const q = sqliteDialect.compile(buildInsert(ctx(), "User", rows, env, []));
    expect(q.text).toMatch(/VALUES \(\?, \?, \?, \?\), \(\?, \?, \?, \?\)$/);
    expect(q.text).toContain('("email", "name", "role", "createdAt")');
    expect(q.params).toEqual(["a", null, "USER", "2026-10-28T00:00:00.000Z", "b", "B", "USER", "2026-10-28T00:00:00.000Z"]);
  });

  it("encodes literal defaults by field type", () => {
    const { data } = validatedWrite("Post", "create", { data: { title: "t", author: { connect: { id: 1 } } } });
    data.connects.clear();
    data.values.set("authorId", 1);
    const q = sqliteDialect.compile(buildInsert(ctx(), "Post", [data], env, []));
    expect(q.text).toContain('("title", "published", "views", "updatedAt", "authorId")');
    expect(q.params).toEqual(["t", 0, 0n, "2026-10-28T00:00:00.000Z", 1]);
  });

  it("generates a uuid per row", () => {
    const index = indexSchema(loadSchema(minimalSchema("model Tag {\n  id String @id @default(uuid())\n  label String\n}\n")));
    const c = createBuildContext(index, sqliteDialect, DEFAULT_RUNTIME_LIMITS);
    const v = validateArgs(index, "Tag", "createMany", { data: [{ label: "a" }, { label: "b" }] }, DEFAULT_RUNTIME_LIMITS);
    if (v.op !== "createMany") throw new Error("unexpected");
    let n = 0;
    const q = sqliteDialect.compile(buildInsert(c, "Tag", v.data, { now: env.now, uuid: () => `id-${String(n++)}` }, []));
    expect(q.params).toEqual(["id-0", "a", "id-1", "b"]);
  });

  it("deletes with a filter and RETURNING", () => {
    const where = validatedWhere("User", "deleteMany", { where: { role: "ADMIN" } });
    expect(sqliteDialect.compile(buildDelete(ctx(), "User", where, [])).text).toBe(
      'DELETE FROM "User" AS "t0" WHERE "t0"."role" = ?',
    );
    expect(sqliteDialect.compile(buildDelete(ctx(), "User", undefined, ["id"])).text).toBe(
      'DELETE FROM "User" AS "t0" RETURNING "id" AS "id"',
    );
  });

  it("refuses unresolved connects and exposes them to the client", () => {
    const { data } = validatedWrite("Post", "create", { data: { title: "t", author: { connect: { id: 7 } } } });
    expect(() => buildInsert(ctx(), "Post", [data], env, [])).toThrow(OrmError);
    const upd = validatedWrite("Post", "update", { where: { id: 1 }, data: { author: { connect: { id: 7 } } } });
    expect(() => buildUpdate(ctx(), "Post", upd.where, upd.data, env, [])).toThrow(OrmError);
    const connects = resolvedConnectColumns(ctx(), "Post", data);
    expect([...connects.keys()]).toEqual(["author"]);
    expect(connects.get("author")).toBe(data.connects.get("author"));
  });

  it("rejects unknown returning fields", () => {
    const { data } = validatedWrite("User", "create", { data: { email: "a" } });
    expect(() => buildInsert(ctx(), "User", [data], env, ["nope"])).toThrow(OrmError);
  });
});
