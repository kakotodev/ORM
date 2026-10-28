import { SchemaError } from "../../../src/errors.js";
import { loadSchema } from "../../../src/schema/index.js";
import { indexSchema, oppositeRelation, type RelationField } from "../../../src/schema/ir.js";
import { BLOG_SCHEMA, minimalSchema } from "../../helpers/schemas.js";

/** Narrows away undefined without a non-null assertion. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

const bad = (models: string) => () => loadSchema(minimalSchema(models));

function messages(models: string): string[] {
  try {
    loadSchema(minimalSchema(models));
  } catch (e) {
    expect(e).toBeInstanceOf(SchemaError);
    return (e as SchemaError).diagnostics.map((d) => d.message);
  }
  return expect.unreachable();
}

const REL =
  "model A { id Int @id\n bs B[] }\nmodel B { id Int @id\n a A @relation(fields: [aId], references: [id])\n aId Int }";
const OWNER = "model B { id Int @id\n a A @relation(fields: [aId], references: [id])\n aId Int }";

const EXPECTED_MESSAGE = new Map<string, string>(Object.entries({
 "missing @id": "exactly one @id",
 "two @id": "found several",
 "@@id": "@@id",
 "nullable @id": "cannot be optional",
 "Float @id": "must be Int, BigInt or String",
 "enum @id": "not allowed here",
 "reserved name": "model name: it is reserved",
 "__proto__ field": "field name: it is reserved",
 "prototype model": "model name: it is reserved",
 "_mini_orm prefix": "model name: it is reserved",
 "identifier too long": "too long",
 "bad @map ident": "column name: it has invalid",
 "bad @@map ident": "table name: it has invalid",
 "reserved delegate": "delegate name: it is reserved",
 "duplicate model": "Duplicate model",
 "duplicate delegate": "delegate .* already used",
 "duplicate table": "Table .* already used",
 "duplicate field": "Duplicate field",
 "duplicate enum": "Duplicate enum ",
 "duplicate enum value": "Duplicate enum value",
 "empty enum": "at least one value",
 "enum named like a model": "conflicts with another type",
 "model named like a scalar": "conflicts with another type",
 "autoincrement on String": "autoincrement\\(\\) is only",
 "autoincrement on non-id": "autoincrement\\(\\) is only",
 "now() on Int": "now\\(\\) is only",
 "uuid() on Int": "uuid\\(\\) is only",
 "unknown default function": "Unknown default function",
 "string default on Int": "does not match",
 "number default on String": "does not match",
 "fractional Int default": "safe integer",
 "unsafe Int default": "safe integer",
 "unsafe BigInt default": "safe integer",
 "boolean default on Int": "does not match",
 "unknown enum default": "not a value of the enum",
 "Json default": "cannot have a default",
 "@updatedAt on Int": "only allowed on DateTime",
 "Json unique": "cannot be unique",
 "Bytes unique": "cannot be unique",
 "Json @@index": "cannot be indexed",
 "Json id": "must be Int, BigInt or String",
 "list of scalars": "Only relation fields can be lists",
 "unknown type": "Unknown type",
 "unknown attribute": "not allowed here",
 "unknown block attribute": "not allowed here",
 "duplicate attribute": "Duplicate attribute",
 "unknown field in @@unique": "Unknown scalar field",
 "relation field in @@index": "Unknown scalar field",
 "@id on relation": "not allowed here",
 "relation without back side": "no opposite field",
 "inverse without owner": "Exactly one side",
 "both sides owners": "Exactly one side",
 "two relations between two models": "Only one relation between two",
 "named relation": "Named relations",
 "self relation": "Self-relations",
 "FK type mismatch": "type must match",
 "FK nullability mismatch": "nullability must match",
 "FK count mismatch": "same length",
 "unknown FK field": "Foreign key must be a scalar",
 "references a non-unique field": "@id or a unique",
 "missing relation arguments": "requires fields and references",
 "SetNull on required relation": "SetNull requires an optional",
 "unknown onDelete": "onDelete must be",
 "onDelete on inverse side": "onDelete is only allowed on the side",
 "list owner": "cannot be a list",
 "1:1 inverse without unique FK": "requires a unique foreign key",
 "required 1:1 inverse": "must be optional",
 "optional list": "cannot be optional",
 "duplicate column via @map": "Duplicate column"
}));

describe("buildSchema / loadSchema", () => {
  it("builds the IR of the blog fixture", () => {
    const ir = loadSchema(BLOG_SCHEMA);
    expect(ir.provider).toBe("sqlite");
    expect(ir.urlEnv).toBe("DATABASE_URL");
    const user = must(ir.models.find((m) => m.name === "User"));
    expect(user).toMatchObject({ delegate: "user", table: "User", primaryKey: "id", uniques: [["email"]] });
    const author = must(ir.models.find((m) => m.name === "Post")).fields.find((f) => f.name === "author");
    expect(author).toMatchObject({
      kind: "relation",
      target: "User",
      list: false,
      fields: ["authorId"],
      references: ["id"],
      onDelete: "Cascade",
    });
    expect(ir.enums).toEqual([{ name: "Role", values: ["USER", "ADMIN"] }]);
  });

  it("keeps declaration order and models fields precisely", () => {
    const ir = loadSchema(BLOG_SCHEMA);
    expect(ir.models.map((m) => m.name)).toEqual(["User", "Post"]);
    const user = must(ir.models[0]);
    expect(user.fields.map((f) => f.name)).toEqual(["id", "email", "name", "role", "posts", "createdAt"]);
    expect(user.fields[0]).toMatchObject({
      kind: "scalar",
      type: "Int",
      isId: true,
      default: { kind: "autoincrement" },
    });
    expect(user.fields[3]).toMatchObject({
      kind: "enum",
      enumName: "Role",
      default: { kind: "literal", value: "USER" },
    });
    expect(user.fields[2]).toMatchObject({ nullable: true });
    const post = must(ir.models[1]);
    expect(post.indexes).toEqual([["authorId"]]);
    expect(post.fields.find((f) => f.name === "views")).toMatchObject({ default: { kind: "literal", value: 0 } });
    expect(post.fields.find((f) => f.name === "updatedAt")).toMatchObject({ updatedAt: true });
    expect(post.fields.find((f) => f.name === "published")).toMatchObject({
      default: { kind: "literal", value: false },
    });
    const posts = user.fields.find((f) => f.name === "posts");
    expect(posts).toMatchObject({ kind: "relation", target: "Post", list: true, fields: [], references: [] });
  });

  it("is plain JSON data", () => {
    const ir = loadSchema(BLOG_SCHEMA);
    expect(JSON.parse(JSON.stringify(ir))).toEqual(ir);
  });

  it("applies @map, @@map, @@unique and compound indexes", () => {
    const ir = loadSchema(
      minimalSchema(
        'model Item { id String @id @default(uuid())\n a Int @map("col_a")\n b Int\n @@map("items")\n @@unique([a, b])\n @@index([b, a]) }',
      ),
    );
    const m = must(ir.models[0]);
    expect(m).toMatchObject({
      table: "items",
      delegate: "item",
      primaryKey: "id",
      uniques: [["a", "b"]],
      indexes: [["b", "a"]],
    });
    expect(m.fields[1]).toMatchObject({ column: "col_a" });
  });

  it("defaults onDelete to Restrict (required) and SetNull (optional)", () => {
    const req = loadSchema(minimalSchema(REL));
    expect(must(req.models[1]).fields[1]).toMatchObject({ onDelete: "Restrict" });
    const opt = loadSchema(
      minimalSchema(
        "model A { id Int @id\n bs B[] }\nmodel B { id Int @id\n a A? @relation(fields: [aId], references: [id])\n aId Int? }",
      ),
    );
    expect(must(opt.models[1]).fields[1]).toMatchObject({ nullable: true, onDelete: "SetNull" });
  });

  it("accepts a one-to-one relation with a unique foreign key", () => {
    const ir = loadSchema(
      minimalSchema(
        "model A { id Int @id\n b B? }\nmodel B { id Int @id\n a A @relation(fields: [aId], references: [id])\n aId Int @unique }",
      ),
    );
    expect(must(ir.models[0]).fields[1]).toMatchObject({ kind: "relation", list: false, nullable: true });
  });

  it("accepts a generator block and postgresql", () => {
    const ir = loadSchema(
      'generator client {\n provider = "x"\n}\ndatasource db {\n provider = "postgresql"\n url = env("PG_URL")\n}\nmodel A { id BigInt @id }',
    );
    expect(ir).toMatchObject({ provider: "postgresql", urlEnv: "PG_URL" });
  });

  it("accepts a unique composite reference in any order", () => {
    const ir = loadSchema(
      minimalSchema(
        "model A { id Int @id\n x Int\n y Int\n bs B[]\n @@unique([x, y]) }\nmodel B { id Int @id\n a A @relation(fields: [ax, ay], references: [y, x])\n ax Int\n ay Int }",
      ),
    );
    expect(must(ir.models[1]).fields[1]).toMatchObject({ fields: ["ax", "ay"], references: ["y", "x"] });
  });

  it.each([
    ["missing @id", "model A { name String }"],
    ["two @id", "model A { id Int @id\n b Int @id }"],
    ["@@id", "model A { a Int\n b Int\n @@id([a, b]) }"],
    ["nullable @id", "model A { id Int? @id }"],
    ["Float @id", "model A { id Float @id }"],
    ["enum @id", "enum E { X }\nmodel A { id E @id }"],
    ["reserved name", "model constructor { id Int @id }"],
    ["__proto__ field", "model A { id Int @id\n __proto__ Int }"],
    ["prototype model", "model prototype { id Int @id }"],
    ["_mini_orm prefix", "model _mini_orm_x { id Int @id }"],
    ["identifier too long", `model ${"A".repeat(64)} { id Int @id }`],
    ["bad @map ident", 'model A { id Int @id\n x Int @map("a-b") }'],
    ["bad @@map ident", 'model A { id Int @id\n @@map("a b") }'],
    ["reserved delegate", "model Constructor { id Int @id }"],
    ["duplicate model", "model A { id Int @id }\nmodel A { id Int @id }"],
    ["duplicate delegate", "model User { id Int @id }\nmodel user { id Int @id }"],
    ["duplicate table", 'model A { id Int @id\n @@map("t") }\nmodel B { id Int @id\n @@map("t") }'],
    ["duplicate field", "model A { id Int @id\n x Int\n x Int }"],
    ["duplicate enum", "enum E { X }\nenum E { Y }"],
    ["duplicate enum value", "enum E { X\n X }"],
    ["empty enum", "enum E {\n}"],
    ["enum named like a model", "enum A { X }\nmodel A { id Int @id }"],
    ["model named like a scalar", "model Int { id Int @id }"],
    ["autoincrement on String", "model A { id String @id @default(autoincrement()) }"],
    ["autoincrement on non-id", "model A { id Int @id\n n Int @default(autoincrement()) }"],
    ["now() on Int", "model A { id Int @id\n n Int @default(now()) }"],
    ["uuid() on Int", "model A { id Int @id\n n Int @default(uuid()) }"],
    ["unknown default function", "model A { id Int @id\n n Int @default(foo()) }"],
    ["string default on Int", 'model A { id Int @id\n n Int @default("x") }'],
    ["number default on String", "model A { id Int @id\n s String @default(1) }"],
    ["fractional Int default", "model A { id Int @id\n n Int @default(1.5) }"],
    ["unsafe Int default", "model A { id Int @id\n n Int @default(9007199254740993) }"],
    ["unsafe BigInt default", "model A { id Int @id\n n BigInt @default(9007199254740993) }"],
    ["boolean default on Int", "model A { id Int @id\n n Int @default(true) }"],
    ["unknown enum default", "enum E { X }\nmodel A { id Int @id\n e E @default(Y) }"],
    ["Json default", 'model A { id Int @id\n j Json @default("{}") }'],
    ["@updatedAt on Int", "model A { id Int @id\n n Int @updatedAt }"],
    ["Json unique", "model A { id Int @id\n j Json @unique }"],
    ["Bytes unique", "model A { id Int @id\n j Bytes @unique }"],
    ["Json @@index", "model A { id Int @id\n j Json\n @@index([j]) }"],
    ["Json id", "model A { id Json @id }"],
    ["list of scalars", "model A { id Int @id\n tags String[] }"],
    ["unknown type", "model A { id Int @id\n x Foo }"],
    ["unknown attribute", "model A { id Int @id\n x Int @foo }"],
    ["unknown block attribute", "model A { id Int @id\n @@foo([id]) }"],
    ["duplicate attribute", "model A { id Int @id\n x Int @unique @unique }"],
    ["unknown field in @@unique", "model A { id Int @id\n @@unique([nope]) }"],
    ["relation field in @@index", `model A { id Int @id\n bs B[]\n @@index([bs]) }\n${OWNER}`],
    ["@id on relation", "model A { id Int @id\n bs B[] @id }\n" + OWNER],
    ["relation without back side", "model A { id Int @id }\n" + OWNER],
    ["inverse without owner", "model A { id Int @id\n bs B[] }\nmodel B { id Int @id\n as A[] }"],
    [
      "both sides owners",
      "model A { id Int @id\n b B @relation(fields: [bId], references: [id])\n bId Int }\n" + OWNER,
    ],
    [
      "two relations between two models",
      "model A { id Int @id\n b1 B[]\n b2 B[] }\nmodel B { id Int @id\n a1 A @relation(fields: [a1Id], references: [id])\n a1Id Int\n a2 A @relation(fields: [a2Id], references: [id])\n a2Id Int }",
    ],
    [
      "named relation",
      'model A { id Int @id\n bs B[] }\nmodel B { id Int @id\n a A @relation(name: "x", fields: [aId], references: [id])\n aId Int }',
    ],
    [
      "self relation",
      "model A { id Int @id\n parentId Int?\n parent A? @relation(fields: [parentId], references: [id])\n kids A[] }",
    ],
    [
      "FK type mismatch",
      "model A { id Int @id\n bs B[] }\nmodel B { id Int @id\n a A @relation(fields: [aId], references: [id])\n aId String }",
    ],
    [
      "FK nullability mismatch",
      "model A { id Int @id\n bs B[] }\nmodel B { id Int @id\n a A @relation(fields: [aId], references: [id])\n aId Int? }",
    ],
    [
      "FK count mismatch",
      "model A { id Int @id\n bs B[] }\nmodel B { id Int @id\n a A @relation(fields: [aId, id], references: [id])\n aId Int }",
    ],
    [
      "unknown FK field",
      "model A { id Int @id\n bs B[] }\nmodel B { id Int @id\n a A @relation(fields: [nope], references: [id]) }",
    ],
    [
      "references a non-unique field",
      "model A { id Int @id\n n Int\n bs B[] }\nmodel B { id Int @id\n a A @relation(fields: [aId], references: [n])\n aId Int }",
    ],
    [
      "missing relation arguments",
      "model A { id Int @id\n bs B[] }\nmodel B { id Int @id\n a A @relation(fields: [aId])\n aId Int }",
    ],
    [
      "SetNull on required relation",
      "model A { id Int @id\n bs B[] }\nmodel B { id Int @id\n a A @relation(fields: [aId], references: [id], onDelete: SetNull)\n aId Int }",
    ],
    [
      "unknown onDelete",
      "model A { id Int @id\n bs B[] }\nmodel B { id Int @id\n a A @relation(fields: [aId], references: [id], onDelete: Boom)\n aId Int }",
    ],
    [
      "onDelete on inverse side",
      "model A { id Int @id\n bs B[] @relation(onDelete: Cascade) }\n" + OWNER,
    ],
    [
      "list owner",
      "model A { id Int @id\n b B? }\nmodel B { id Int @id\n a A[] @relation(fields: [aId], references: [id])\n aId Int }",
    ],
    ["1:1 inverse without unique FK", "model A { id Int @id\n b B? }\n" + OWNER],
    [
      "required 1:1 inverse",
      "model A { id Int @id\n b B }\nmodel B { id Int @id\n a A @relation(fields: [aId], references: [id])\n aId Int @unique }",
    ],
    ["optional list", "model A { id Int @id\n bs B[]? }\n" + OWNER],
    ["duplicate column via @map", 'model A { id Int @id\n x Int @map("y")\n y Int }'],
  ])("rejects %s", (name, models) => {
    expect(bad(models)).toThrow(SchemaError);
    // The pattern comes from the fixed EXPECTED_MESSAGE table above, not user input.
    // eslint-disable-next-line security/detect-non-literal-regexp
    const pattern = new RegExp(must(EXPECTED_MESSAGE.get(name)));
    expect(messages(models).some((m) => pattern.test(m))).toBe(true);
  });

  it.each([
    ["models differing by case", "model FOO { id Int @id }\nmodel Foo { id Int @id }"],
    ["@@map differing by case", 'model Post { id Int @id }\nmodel Other { id Int @id\n @@map("post") }'],
    ["fields differing by case", "model A { id Int @id\n Email String\n email String }"],
    ["@map differing by case", 'model A { id Int @id\n x Int @map("Y")\n y Int }'],
  ])("rejects case-insensitive collision: %s", (_n, models) => {
    expect(messages(models).some((m) => /already used|Duplicate column/.test(m))).toBe(true);
  });

  it("keeps the primary key out of uniques", () => {
    const ir = loadSchema(minimalSchema("model A { id Int @id @unique\n k Int @unique\n @@unique([id]) }"));
    expect(must(ir.models[0]).uniques).toEqual([["k"]]);
  });

  it("rejects a non-finite Float default", () => {
    expect(bad(`model A { id Int @id\n n Float @default(${"9".repeat(400)}) }`)).toThrow(SchemaError);
  });

  it("rejects a NUL in a string default", () => {
    expect(bad('model A { id Int @id\n s String @default("a\\u0000b") }')).toThrow(SchemaError);
  });

  it("rejects a literal datasource url without echoing it", () => {
    const src = 'datasource db { provider = "sqlite"\n url = "file:./secret.db" }\nmodel A { id Int @id }';
    expect(() => loadSchema(src)).toThrow(/Schema is invalid/);
    try {
      loadSchema(src);
    } catch (e) {
      const diags = (e as SchemaError).diagnostics;
      expect(diags.some((d) => /env\(/.test(d.message))).toBe(true);
      expect(JSON.stringify(diags)).not.toContain("secret");
    }
  });

  it.each([
    ["no datasource", "model A { id Int @id }"],
    [
      "two datasources",
      'datasource a { provider = "sqlite"\n url = env("X") }\ndatasource b { provider = "sqlite"\n url = env("X") }\nmodel A { id Int @id }',
    ],
    ["unknown provider", 'datasource a { provider = "mysql"\n url = env("X") }\nmodel A { id Int @id }'],
    ["missing url", 'datasource a { provider = "sqlite" }\nmodel A { id Int @id }'],
    ["bad env name", 'datasource a { provider = "sqlite"\n url = env("a-b") }\nmodel A { id Int @id }'],
    ["env with two args", 'datasource a { provider = "sqlite"\n url = env("A", "B") }\nmodel A { id Int @id }'],
  ])("rejects datasource: %s", (_n, src) => {
    expect(() => loadSchema(src)).toThrow(SchemaError);
  });

  it("collects every diagnostic with positions and passes the file through", () => {
    let err: SchemaError | undefined;
    try {
      loadSchema(minimalSchema("model A { name String }\nmodel B { id Int @id\n x Foo }"), { file: "dir/schema.orm" });
    } catch (e) {
      err = e as SchemaError;
    }
    expect(err).toBeInstanceOf(SchemaError);
    expect(must(err).diagnostics.length).toBeGreaterThanOrEqual(2);
    expect(must(err).message).toContain("schema.orm");
    for (const d of must(err).diagnostics) expect(d.line).toBeGreaterThan(0);
  });

  it("never echoes invalid names in diagnostics", () => {
    const msgs = messages('model constructor { id Int @id }\nmodel A { id Int @id\n __proto__ Int\n x Int @map("a-b") }');
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    for (const m of msgs) expect(m).not.toMatch(/constructor|__proto__|a-b/);
  });
});

describe("indexSchema", () => {
  it("uses Maps so prototype keys never resolve", () => {
    const idx = indexSchema(loadSchema(BLOG_SCHEMA));
    expect(idx.byDelegate.get("__proto__")).toBeUndefined();
    expect(must(idx.models.get("User")).fields.get("constructor")).toBeUndefined();
    expect(must(idx.models.get("User")).byColumn.get("toString")).toBeUndefined();
  });

  it("indexes by name, delegate, table and column (scalar/enum only)", () => {
    const idx = indexSchema(loadSchema(BLOG_SCHEMA));
    expect(idx.byDelegate.get("user")).toBe(idx.models.get("User"));
    expect(idx.byTable.get("Post")).toBe(idx.models.get("Post"));
    expect(idx.enums.get("Role")).toEqual({ name: "Role", values: ["USER", "ADMIN"] });
    const user = must(idx.models.get("User"));
    expect(user.byColumn.get("email")?.name).toBe("email");
    expect(user.byColumn.has("posts")).toBe(false);
    expect(user.fields.has("posts")).toBe(true);
  });

  it("finds the opposite relation side", () => {
    const idx = indexSchema(loadSchema(BLOG_SCHEMA));
    const posts = must(idx.models.get("User")).fields.get("posts") as RelationField;
    const opposite = oppositeRelation(idx, "User", posts);
    expect(opposite.model.ir.name).toBe("Post");
    expect(opposite.field.name).toBe("author");
    const back = oppositeRelation(idx, "Post", opposite.field);
    expect(back.field.name).toBe("posts");
  });
});
