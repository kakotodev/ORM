import { SchemaError } from "../../src/errors.js";
import { loadSchema } from "../../src/schema/index.js";
import { minimalSchema } from "../helpers/schemas.js";

const RLO = String.fromCharCode(0x202e); // right-to-left override

const model = (body: string): string => minimalSchema(`model A {\n  id Int @id\n${body}\n}`);

function diagnostics(source: string): string {
  try {
    loadSchema(source);
  } catch (err) {
    expect(err).toBeInstanceOf(SchemaError);
    return JSON.stringify((err as SchemaError).diagnostics) + (err as SchemaError).message;
  }
  throw new Error("expected the schema to be rejected");
}

describe("hostile schema input", () => {
  it("rejects oversized sources, identifiers, strings and nesting with a typed error", () => {
    expect(diagnostics(minimalSchema("model A {\n id Int @id\n}\n") + "// " + "x".repeat(1_048_576))).toMatch(/too large|size/i);
    expect(diagnostics(model(`  ${"a".repeat(64)} String`))).toMatch(/too long/);
    expect(diagnostics(model(`  s String @default("${"x".repeat(4097)}")`))).toMatch(/too long/);
    expect(diagnostics(model(`  @@index(${"[".repeat(40)}${"]".repeat(40)})`))).toMatch(/deep/i);
    expect(diagnostics(model(`  s String @default(${"f(".repeat(40)}1${")".repeat(40)})`))).toMatch(/deep/i);
  });

  it("rejects names that could break out of a quoted SQL identifier", () => {
    for (const bad of ['a"b', "a b", "a;b", "a--b", "a'b", "1a", "aа", `a${RLO}b`]) {
      expect(diagnostics(model(`  f String @map(${JSON.stringify(bad)})`)), bad).toMatch(/invalid|reserved|characters/i);
      expect(diagnostics(minimalSchema(`model M {\n id Int @id\n @@map(${JSON.stringify(bad)})\n}`)), bad).toMatch(
        /invalid|reserved|characters/i,
      );
    }
  });

  it("rejects reserved internal names", () => {
    expect(diagnostics(model('  f String @map("_mini_orm_migrations")'))).toMatch(/reserved/);
    expect(diagnostics(minimalSchema("model _mini_orm_x {\n id Int @id\n}"))).toMatch(/reserved/);
  });

  it("never throws anything but SchemaError on garbage", () => {
    const garbage = [
      "",
      "\0",
      "model",
      "model {",
      "model A {",
      "model A { id Int @id",
      'datasource db { url = "' + "\\".repeat(5001),
      RLO.repeat(100),
      "{".repeat(10_000),
      "@".repeat(10_000),
      "model A { id Int @id } ".repeat(2000),
      'enum E { A B C } model M { id Int @id e E @default("A") }',
      minimalSchema("model A {\n id Int @id\n x Int @default(99999999999999999999999)\n}"),
    ];
    for (const source of garbage) {
      try {
        loadSchema(source);
      } catch (err) {
        expect(err, JSON.stringify(source.slice(0, 40))).toBeInstanceOf(SchemaError);
      }
    }
  });

  it("does not echo source text in diagnostics for oversized or hostile input", () => {
    const marker = "LEAKED_SECRET_MARKER";
    const text = diagnostics(model(`  ${marker} Nope @default(${marker})`));
    expect(text).not.toContain(marker);
  });
});
