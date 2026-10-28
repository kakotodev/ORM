import { SchemaError } from "../../../src/errors.js";
import { parse } from "../../../src/schema/parser.js";
import { BLOG_SCHEMA, minimalSchema } from "../../helpers/schemas.js";

function diagnostics(src: string, options?: Parameters<typeof parse>[1]) {
  try {
    parse(src, options);
  } catch (e) {
    expect(e).toBeInstanceOf(SchemaError);
    return (e as SchemaError).diagnostics;
  }
  return expect.unreachable();
}

it("parses the blog fixture into blocks", () => {
  const ast = parse(BLOG_SCHEMA);
  expect(ast.blocks.map((b) => `${b.kind}:${b.name}`)).toEqual(["datasource:db", "enum:Role", "model:User", "model:Post"]);
});
it("keeps the aligned fixture formatting", () => {
  expect(BLOG_SCHEMA).toContain("name      String?");
});
it("parses field modifiers and attribute arguments", () => {
  const user = parse(minimalSchema("model U { id Int @id @default(autoincrement())\n name String?\n posts P[] }")).blocks[1];
  expect(user).toMatchObject({
    kind: "model",
    fields: [
      {
        name: "id",
        type: "Int",
        optional: false,
        list: false,
        attributes: [{ name: "id" }, { name: "default", args: [{ value: { kind: "call", name: "autoincrement" } }] }],
      },
      { name: "name", optional: true },
      { name: "posts", list: true },
    ],
  });
});
it("parses named attribute args with arrays", () => {
  const ast = parse(minimalSchema("model P { id Int @id\n a A @relation(fields: [aId], references: [id], onDelete: Cascade)\n aId Int }"));
  const model = ast.blocks[1];
  const rel = model?.kind === "model" ? model.fields[1]?.attributes[0] : undefined;
  expect(rel?.args.map((a) => a.name)).toEqual(["fields", "references", "onDelete"]);
});
it("puts @@ attributes in model.attributes and keeps datasource properties", () => {
  const ast = parse(BLOG_SCHEMA);
  expect(ast.blocks[0]).toMatchObject({
    kind: "datasource",
    properties: [
      { key: "provider", value: { kind: "string", value: "sqlite" } },
      { key: "url", value: { kind: "call", name: "env", args: [{ kind: "string", value: "DATABASE_URL" }] } },
    ],
  });
  expect(ast.blocks[3]).toMatchObject({ attributes: [{ name: "index" }] });
  expect(ast.blocks[1]).toMatchObject({ values: [{ name: "USER" }, { name: "ADMIN" }] });
});
it("collects several diagnostics in one SchemaError", () => {
  expect(diagnostics("model A { id }\nmodel B { x Int @ }").length).toBeGreaterThanOrEqual(2);
});
it("rejects nesting deeper than maxNestingDepth", () => {
  expect(() => parse(minimalSchema(`model A { id Int @x(${"[".repeat(20)}${"]".repeat(20)}) }`))).toThrow(SchemaError);
});
it("handles very deep nesting without a stack overflow, and respects a custom limit", () => {
  const deep = "[".repeat(100_000);
  expect(diagnostics(minimalSchema(`model A { id Int @x(${deep}) }`)).length).toBeGreaterThan(0);
  const ok = minimalSchema("model A { id Int @x([[1]]) }");
  expect(() => parse(ok)).not.toThrow();
  expect(() => parse(ok, { limits: { maxNestingDepth: 1 } })).toThrow(SchemaError);
});
it("ignores invalid limit overrides", () => {
  const deep = minimalSchema(`model A { id Int @x(${"[".repeat(20)}${"]".repeat(20)}) }`);
  expect(() => parse(deep, { limits: { maxNestingDepth: Number.NaN } })).toThrow(SchemaError);
  expect(() => parse(deep, { limits: { maxNestingDepth: undefined } })).toThrow(SchemaError);
});
it("reports positions and never echoes source content", () => {
  const [d] = diagnostics("model A {\n  SECRETNAME\n}");
  expect(d).toMatchObject({ line: 2 });
  expect(d?.message).not.toContain("SECRETNAME");
});
it("propagates lexer errors with the file name only", () => {
  try {
    parse("model A { id Int # }", { file: "/abs/dir/schema.orm" });
    expect.unreachable();
  } catch (e) {
    expect((e as SchemaError).message).toContain("schema.orm");
    expect((e as SchemaError).message).not.toContain("/abs/dir");
  }
});
it("rejects unknown block keywords and unterminated blocks", () => {
  expect(diagnostics("widget A { }").length).toBe(1);
  expect(diagnostics("model A { id Int").length).toBe(1);
});
