import { OrmError } from "../../../src/errors.js";
import type { SelectQuery, SqlExpr } from "../../../src/dialects/sql-ast.js";
import { globPattern, sqliteDialect } from "../../../src/dialects/sqlite.js";
import { loadSchema } from "../../../src/schema/index.js";
import { indexSchema, type FieldIR, type ScalarType } from "../../../src/schema/ir.js";
import { BLOG_SCHEMA, minimalSchema } from "../../helpers/schemas.js";

const col = (column: string, alias = "t0"): SqlExpr => ({ kind: "column", alias, column });
const param = (value: string | number | null): SqlExpr => ({ kind: "param", value });
const eq = (column: string, value: string | number | null): SqlExpr => ({
  kind: "compare",
  op: "=",
  left: col(column),
  right: param(value),
});
const sel = (where?: SqlExpr): SelectQuery => ({
  kind: "select",
  table: "User",
  alias: "t0",
  columns: [{ column: "id", as: "id" }],
  ...(where === undefined ? {} : { where }),
  orderBy: [],
  limit: 10,
});
const whereOf = (where: SqlExpr): string => sqliteDialect.compile(sel(where)).text;
const field = (type: ScalarType): FieldIR => ({
  kind: "scalar",
  name: "x",
  column: "x",
  type,
  nullable: true,
  isId: false,
  isUnique: false,
  updatedAt: false,
});

describe("sqlite compile", () => {
  it("compiles a parameterized select", () => {
    const q = sqliteDialect.compile(sel(eq("email", "' OR 1=1 --")));
    expect(q.text).toBe('SELECT "t0"."id" AS "id" FROM "User" AS "t0" WHERE "t0"."email" = ? LIMIT ?');
    expect(q.params).toEqual(["' OR 1=1 --", 10]);
  });

  it("text depends only on the query shape", () => {
    const inList = (values: number[]) => sel({ kind: "in", expr: col("id"), values, negated: false });
    const a = sqliteDialect.compile(inList([1, 2]));
    const b = sqliteDialect.compile(inList([7, 8]));
    expect(a.text).toBe(b.text);
    expect(a.text).toContain('"t0"."id" IN (?, ?)');
  });

  it("renders the full select shape with glob, order, limit and offset", () => {
    const q = sqliteDialect.compile({
      kind: "select",
      table: "User",
      alias: "t0",
      columns: [
        { column: "id", as: "id" },
        { column: "email", as: "email" },
      ],
      where: { kind: "textMatch", mode: "contains", expr: col("email"), value: "a*" },
      orderBy: [{ column: "createdAt", direction: "DESC" }],
      limit: 5,
      offset: 10,
    });
    expect(q.text).toBe(
      'SELECT "t0"."id" AS "id", "t0"."email" AS "email" FROM "User" AS "t0" WHERE "t0"."email" GLOB ? ORDER BY "t0"."createdAt" DESC LIMIT ? OFFSET ?',
    );
    expect(q.params).toEqual(["*a[*]*", 5, 10]);
  });

  it("uses LIMIT -1 when only an offset is given", () => {
    const q = sqliteDialect.compile({ kind: "select", table: "User", alias: "t0", columns: [{ column: "id", as: "id" }], orderBy: [], offset: 3 });
    expect(q.text).toBe('SELECT "t0"."id" AS "id" FROM "User" AS "t0" LIMIT -1 OFFSET ?');
    expect(q.params).toEqual([3]);
  });

  it("compiles count and SELECT 1", () => {
    const count = sqliteDialect.compile({ kind: "select", table: "User", alias: "t0", columns: "count", orderBy: [] });
    expect(count.text).toBe('SELECT COUNT(*) AS "count" FROM "User" AS "t0"');
    const exists = whereOf({
      kind: "exists",
      negated: false,
      query: {
        kind: "select",
        table: "Post",
        alias: "t1",
        columns: [],
        where: { kind: "compare", op: "=", left: col("authorId", "t1"), right: col("id") },
        orderBy: [],
      },
    });
    expect(exists).toContain('WHERE EXISTS (SELECT 1 FROM "Post" AS "t1" WHERE "t1"."authorId" = "t0"."id")');
    const negated = whereOf({
      kind: "exists",
      negated: true,
      query: { kind: "select", table: "Post", alias: "t1", columns: [], orderBy: [] },
    });
    expect(negated).toContain('NOT EXISTS (SELECT 1 FROM "Post" AS "t1")');
  });

  it("keeps parameter order across subqueries", () => {
    const q = sqliteDialect.compile(
      sel({
        kind: "and",
        items: [
          eq("name", "a"),
          {
            kind: "exists",
            negated: false,
            query: { kind: "select", table: "Post", alias: "t1", columns: [], where: eq("title", "b"), orderBy: [], limit: 1 },
          },
          eq("email", "c"),
        ],
      }),
    );
    expect(q.params).toEqual(["a", "b", 1, "c", 10]);
  });

  it("compiles insert (single and multi-row)", () => {
    const one = sqliteDialect.compile({
      kind: "insert",
      table: "User",
      columns: ["email", "role", "createdAt"],
      rows: [["a@b.c", "USER", "2026-01-01"]],
      returning: ["id", "email"],
    });
    expect(one.text).toBe(
      'INSERT INTO "User" ("email", "role", "createdAt") VALUES (?, ?, ?) RETURNING "id" AS "id", "email" AS "email"',
    );
    expect(one.params).toEqual(["a@b.c", "USER", "2026-01-01"]);
    const many = sqliteDialect.compile({
      kind: "insert",
      table: "T",
      columns: ["a", "b"],
      rows: [
        [1, 2],
        [3, 4],
      ],
      returning: [],
    });
    expect(many.text).toBe('INSERT INTO "T" ("a", "b") VALUES (?, ?), (?, ?)');
    expect(many.params).toEqual([1, 2, 3, 4]);
    const none = sqliteDialect.compile({ kind: "insert", table: "T", columns: [], rows: [[]], returning: [] });
    expect(none.text).toBe('INSERT INTO "T" DEFAULT VALUES');
  });

  it("rejects malformed inserts", () => {
    expect(() => sqliteDialect.compile({ kind: "insert", table: "T", columns: ["a"], rows: [], returning: [] })).toThrow(OrmError);
    expect(() => sqliteDialect.compile({ kind: "insert", table: "T", columns: ["a", "b"], rows: [[1]], returning: [] })).toThrow(OrmError);
  });

  it("compiles update and delete", () => {
    const u = sqliteDialect.compile({
      kind: "update",
      table: "Post",
      alias: "t0",
      set: [
        { column: "title", value: "x" },
        { column: "updatedAt", value: "now" },
      ],
      where: eq("id", 1),
      returning: ["id"],
    });
    expect(u.text).toBe('UPDATE "Post" AS "t0" SET "title" = ?, "updatedAt" = ? WHERE "t0"."id" = ? RETURNING "id" AS "id"');
    expect(u.params).toEqual(["x", "now", 1]);
    const d = sqliteDialect.compile({ kind: "delete", table: "User", alias: "t0", where: eq("role", "ADMIN"), returning: [] });
    expect(d.text).toBe('DELETE FROM "User" AS "t0" WHERE "t0"."role" = ?');
    expect(() => sqliteDialect.compile({ kind: "update", table: "T", alias: "t0", set: [], returning: [] })).toThrow(OrmError);
  });

  it("renders boolean groups per the nesting rules", () => {
    expect(whereOf({ kind: "and", items: [eq("a", 1)] })).toContain('WHERE "t0"."a" = ? LIMIT');
    expect(whereOf({ kind: "and", items: [eq("a", 1), eq("b", 2)] })).toContain('WHERE "t0"."a" = ? AND "t0"."b" = ? LIMIT');
    expect(whereOf({ kind: "and", items: [] })).toBe('SELECT "t0"."id" AS "id" FROM "User" AS "t0" LIMIT ?');
    expect(whereOf({ kind: "or", items: [] })).toContain("WHERE 0");
    expect(whereOf({ kind: "true" })).toContain("WHERE 1");
    expect(whereOf({ kind: "false" })).toContain("WHERE 0");
    expect(
      whereOf({
        kind: "and",
        items: [
          eq("x", 1),
          { kind: "or", items: [eq("a", 1), eq("b", 2)] },
          { kind: "and", items: [] },
          { kind: "or", items: [] },
        ],
      }),
    ).toContain('WHERE "t0"."x" = ? AND ("t0"."a" = ? OR "t0"."b" = ?) AND 1 AND 0 LIMIT');
  });

  it("renders nullable not-equal, not, isNull and empty in", () => {
    expect(
      whereOf({
        kind: "and",
        items: [
          {
            kind: "or",
            items: [
              { kind: "compare", op: "<>", left: col("name"), right: param("x") },
              { kind: "isNull", expr: col("name"), negated: false },
            ],
          },
          eq("id", 1),
        ],
      }),
    ).toContain('WHERE ("t0"."name" <> ? OR "t0"."name" IS NULL) AND "t0"."id" = ?');
    expect(whereOf({ kind: "not", expr: { kind: "or", items: [eq("a", 1), eq("b", 2)] } })).toContain(
      'WHERE NOT ("t0"."a" = ? OR "t0"."b" = ?)',
    );
    expect(whereOf({ kind: "not", expr: { kind: "and", items: [] } })).toContain("WHERE NOT (1)");
    expect(whereOf({ kind: "isNull", expr: col("name"), negated: true })).toContain('"t0"."name" IS NOT NULL');
    const empty = sqliteDialect.compile(sel({ kind: "in", expr: col("id"), values: [], negated: false }));
    expect(empty.text).toContain("WHERE 0");
    expect(empty.params).toEqual([10]);
    expect(whereOf({ kind: "in", expr: col("id"), values: [], negated: true })).toContain("WHERE 1");
    expect(whereOf({ kind: "in", expr: col("id"), values: [1], negated: true })).toContain('"t0"."id" NOT IN (?)');
  });

  it("never puts values in the SQL text", () => {
    const evil = "x'; DROP TABLE User; --";
    const q = sqliteDialect.compile(sel({ kind: "textMatch", mode: "startsWith", expr: col("name"), value: evil }));
    expect(q.text).not.toContain("DROP");
    expect(q.params[0]).toBe(`${evil}*`);
  });

  it("refuses bad identifiers anywhere in the AST", () => {
    expect(() => sqliteDialect.compile({ ...sel(), table: 'User"; --' })).toThrow(OrmError);
    expect(() => sqliteDialect.compile(sel(eq('a"b', 1)))).toThrow(OrmError);
  });
});

describe("sqlite identifiers and literals", () => {
  it("globPattern escapes GLOB metacharacters", () => {
    expect(globPattern("contains", "a*b?[c]")).toBe("*a[*]b[?][[]c]*");
    expect(globPattern("startsWith", "x")).toBe("x*");
    expect(globPattern("endsWith", "x")).toBe("*x");
  });

  it("refuses identifiers that are not plain names", () => {
    const bad = 'User"; DROP TABLE x; --';
    expect(() => sqliteDialect.quoteIdentifier(bad)).toThrow(OrmError);
    try {
      sqliteDialect.quoteIdentifier(bad);
    } catch (e) {
      expect((e as Error).message).not.toContain("DROP");
    }
    expect(() => sqliteDialect.quoteIdentifier("a".repeat(64))).toThrow(OrmError);
    expect(() => sqliteDialect.quoteIdentifier("1abc")).toThrow(OrmError);
    expect(() => sqliteDialect.quoteIdentifier("")).toThrow(OrmError);
    expect(sqliteDialect.quoteIdentifier("a".repeat(63))).toBe(`"${"a".repeat(63)}"`);
    expect(sqliteDialect.quoteIdentifier("_ok1")).toBe('"_ok1"');
  });

  it("quotes DDL literals safely", () => {
    expect(sqliteDialect.quoteLiteral("it's")).toBe("'it''s'");
    expect(() => sqliteDialect.quoteLiteral("a\u0000")).toThrow(OrmError);
    expect(sqliteDialect.quoteLiteral(true)).toBe("1");
    expect(sqliteDialect.quoteLiteral(false)).toBe("0");
    expect(sqliteDialect.quoteLiteral(-3.5)).toBe("-3.5");
    expect(() => sqliteDialect.quoteLiteral(Number.NaN)).toThrow(OrmError);
    expect(() => sqliteDialect.quoteLiteral(Infinity)).toThrow(OrmError);
  });
});

describe("sqlite DDL", () => {
  const blog = indexSchema(loadSchema(BLOG_SCHEMA));

  it("generates DDL for the blog fixture in FK order", () => {
    const ddl = sqliteDialect.createTables(blog);
    expect(ddl[0]).toMatch(/^CREATE TABLE IF NOT EXISTS "User"/);
    expect(ddl.join("\n")).toContain('FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE CASCADE');
    expect(ddl.join("\n")).toContain(`CHECK ("role" IN ('USER', 'ADMIN'))`);
  });

  it("renders column definitions, defaults, indexes", () => {
    const ddl = sqliteDialect.createTables(blog);
    const user = ddl.find((s) => s.startsWith('CREATE TABLE IF NOT EXISTS "User"')) ?? "";
    expect(user).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(user).toContain('"email" TEXT NOT NULL UNIQUE');
    expect(user).toContain('"name" TEXT,');
    expect(user).toContain(`"role" TEXT NOT NULL DEFAULT 'USER'`);
    expect(user).not.toContain("posts");
    expect(user).not.toMatch(/"createdAt" TEXT NOT NULL DEFAULT/);
    const post = ddl.find((s) => s.startsWith('CREATE TABLE IF NOT EXISTS "Post"')) ?? "";
    expect(post).toContain('"published" INTEGER NOT NULL DEFAULT 0');
    expect(post).toContain('"views" INTEGER NOT NULL DEFAULT 0');
    expect(post).toContain('"rating" TEXT,');
    expect(post).toContain('"cover" BLOB,');
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS "Post_authorId_idx" ON "Post" ("authorId")');
  });

  it("orders tables by FK dependency regardless of declaration order", () => {
    const schema = indexSchema(
      loadSchema(
        minimalSchema(
          "model B { id Int @id\n a A @relation(fields: [aId], references: [id], onDelete: Restrict)\n aId Int }\nmodel A { id Int @id\n bs B[] }",
        ),
      ),
    );
    const ddl = sqliteDialect.createTables(schema);
    expect(ddl[0]).toContain('"A"');
    expect(ddl[1]).toContain('"B"');
    expect(ddl[1]).toContain("ON DELETE RESTRICT");
    expect(sqliteDialect.createTables(schema, ["B"])).toHaveLength(1);
  });

  it("emits composite uniques and SET NULL", () => {
    const schema = indexSchema(
      loadSchema(
        minimalSchema(
          "model A { id Int @id\n bs B[] }\nmodel B { id Int @id\n a A? @relation(fields: [aId], references: [id], onDelete: SetNull)\n aId Int?\n k String\n @@unique([aId, k]) }",
        ),
      ),
    );
    const sql = sqliteDialect.createTables(schema).join("\n");
    expect(sql).toContain('UNIQUE ("aId", "k")');
    expect(sql).toContain("ON DELETE SET NULL");
  });

  it("emits UNIQUE for a single-column @@unique", () => {
    const schema = indexSchema(loadSchema(minimalSchema("model A { id Int @id\n k String\n @@unique([k]) }")));
    expect(sqliteDialect.createTables(schema).join("\n")).toContain('UNIQUE ("k")');
  });

  it("keeps index names within 63 chars and collision-free", () => {
    const long = indexSchema(
      loadSchema(
        minimalSchema(
          "model OrganizationMembership { id Int @id\n organizationIdentifier Int\n invitedByUserIdentifier Int\n @@index([organizationIdentifier, invitedByUserIdentifier]) }",
        ),
      ),
    );
    const longSql = sqliteDialect.createTables(long).find((s) => s.startsWith("CREATE INDEX")) ?? "";
    const longName = /INDEX IF NOT EXISTS "([^"]+)"/.exec(longSql)?.[1] ?? "";
    expect(longName.length).toBeLessThanOrEqual(63);
    expect(longName).toMatch(/_[0-9a-f]{8}$/);
    const clash = indexSchema(
      loadSchema(minimalSchema("model T { id Int @id\n a_b Int\n a Int\n b Int\n @@index([a_b])\n @@index([a, b]) }")),
    );
    const names = sqliteDialect
      .createTables(clash)
      .filter((s) => s.startsWith("CREATE INDEX"))
      .map((s) => /INDEX IF NOT EXISTS "([^"]+)"/.exec(s)?.[1]);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  it("generates drops", () => {
    expect(sqliteDialect.dropTables(["Post", "User"])).toEqual(['DROP TABLE IF EXISTS "Post"', 'DROP TABLE IF EXISTS "User"']);
    expect(() => sqliteDialect.dropTables(["a;b"])).toThrow(OrmError);
  });
});

describe("sqlite codec", () => {
  it("round-trips values through the codec", () => {
    const d = new Date("2026-10-28T12:00:00.000Z");
    expect(sqliteDialect.decode(field("DateTime"), sqliteDialect.encode(field("DateTime"), d))).toEqual(d);
    expect(sqliteDialect.encode(field("Boolean"), true)).toBe(1);
    expect(sqliteDialect.decode(field("Int"), 5n)).toBe(5);
    expect(sqliteDialect.decode(field("BigInt"), 2n ** 60n)).toBe(2n ** 60n);
  });

  it("encodes each type", () => {
    expect(sqliteDialect.encode(field("Boolean"), false)).toBe(0);
    expect(sqliteDialect.encode(field("DateTime"), new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01T00:00:00.000Z");
    expect(sqliteDialect.encode(field("Json"), { a: [1] })).toBe('{"a":[1]}');
    expect(sqliteDialect.encode(field("Decimal"), "1.50")).toBe("1.50");
    expect(sqliteDialect.encode(field("BigInt"), 5n)).toBe(5n);
    expect(sqliteDialect.encode(field("Int"), 7)).toBe(7);
    const bytes = new Uint8Array([1, 2]);
    expect(sqliteDialect.encode(field("Bytes"), bytes)).toBe(bytes);
    expect(sqliteDialect.encode(field("String"), null)).toBeNull();
    const roleField: FieldIR = { kind: "enum", name: "r", column: "r", enumName: "Role", nullable: false, isUnique: false };
    expect(sqliteDialect.encode(roleField, "USER")).toBe("USER");
  });

  it("decodes each type", () => {
    expect(sqliteDialect.decode(field("Boolean"), 1)).toBe(true);
    expect(sqliteDialect.decode(field("Boolean"), 0n)).toBe(false);
    expect(sqliteDialect.decode(field("Json"), '{"a":1}')).toEqual({ a: 1 });
    expect(sqliteDialect.decode(field("Float"), 1.5)).toBe(1.5);
    expect(sqliteDialect.decode(field("Decimal"), "2.5")).toBe("2.5");
    expect(sqliteDialect.decode(field("Bytes"), new Uint8Array([9]))).toEqual(new Uint8Array([9]));
    expect(sqliteDialect.decode(field("Int"), null)).toBeNull();
    expect(sqliteDialect.decode(field("BigInt"), 5)).toBe(5n);
  });

  it("rejects values of the wrong runtime type and relation fields", () => {
    expect(() => sqliteDialect.encode(field("DateTime"), "2026")).toThrow(OrmError);
    expect(() => sqliteDialect.encode(field("Int"), "1")).toThrow(OrmError);
    expect(() => sqliteDialect.encode(field("DateTime"), new Date(Number.NaN))).toThrow(OrmError);
    expect(() => sqliteDialect.encode(field("Json"), { n: 1n })).toThrow(OrmError);
    const circular: Record<string, unknown> = {};
    circular["secretKey"] = circular;
    try {
      sqliteDialect.encode(field("Json"), circular);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(OrmError);
      expect((e as Error).message).not.toContain("secretKey");
    }
    expect(() => sqliteDialect.encode(field("Int"), 2 ** 60)).toThrow(OrmError);
    expect(() => sqliteDialect.decode(field("Int"), 1.5)).toThrow(OrmError);
    expect(() => sqliteDialect.decode(field("BigInt"), 2 ** 60)).toThrow(OrmError);
    expect(() => sqliteDialect.decode(field("Json"), "{bad")).toThrow(OrmError);
    expect(() => sqliteDialect.decode(field("DateTime"), "nope")).toThrow(OrmError);
    const rel: FieldIR = { kind: "relation", name: "r", target: "T", list: false, nullable: false, fields: [], references: [], onDelete: "Restrict" };
    expect(() => sqliteDialect.encode(rel, 1)).toThrow(OrmError);
  });
});
