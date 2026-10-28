import { SchemaError } from "../../../src/errors.js";
import { tokenize } from "../../../src/schema/lexer.js";
import { DEFAULT_SCHEMA_LIMITS } from "../../../src/schema/limits.js";

function diag(src: string, limits?: Parameters<typeof tokenize>[1]) {
  try {
    tokenize(src, limits);
  } catch (e) {
    expect(e).toBeInstanceOf(SchemaError);
    return (e as SchemaError).diagnostics[0] ?? expect.unreachable();
  }
  return expect.unreachable();
}

it("tokenizes a field line with attributes", () => {
  const kinds = tokenize("id Int @id @default(autoincrement())").map((t) => t.kind);
  expect(kinds).toEqual(["ident", "ident", "at", "ident", "at", "ident", "lparen", "ident", "lparen", "rparen", "rparen", "eof"]);
});
it("tracks line and column, CRLF included", () => {
  const toks = tokenize("model A {\r\n  id Int\r\n}");
  const id = toks.find((t) => t.value === "id") ?? expect.unreachable();
  expect([id.line, id.column]).toEqual([2, 3]);
  expect(toks.filter((t) => t.kind === "newline")).toHaveLength(2);
});
it("ignores comments", () => {
  expect(
    tokenize("// hello\n/// doc\nmodel").filter((t) => t.kind === "ident").map((t) => t.value),
  ).toEqual(["model"]);
});
it("merges consecutive newlines", () => {
  expect(tokenize("a\n\n\r\n// c\nb").map((t) => t.kind)).toEqual(["ident", "newline", "ident", "eof"]);
});
it("decodes string escapes", () => {
  expect(tokenize('"a\\"b\\\\c"')[0]).toMatchObject({ kind: "string", value: 'a"b\\c' });
  expect(tokenize('"a\\nb\\tc"')[0]).toMatchObject({ value: "a\nb\tc" });
});
it("tokenizes numbers and punctuation", () => {
  const toks = tokenize("-12 3.5 {}()[]@@=:,?");
  expect(toks.map((t) => t.kind)).toEqual([
    "number", "number", "lbrace", "rbrace", "lparen", "rparen", "lbracket", "rbracket", "atat", "equals", "colon", "comma", "question", "eof",
  ]);
  expect(toks[0]?.value).toBe("-12");
  expect(toks[1]?.value).toBe("3.5");
});
it.each([
  ["NUL byte", "model\u0000A"],
  ["unterminated string", '"abc'],
  ["raw newline in string", '"a\nb"'],
  ["unknown escape", '"\\x41"'],
  ["unexpected char", "model A { id Int; }"],
])("rejects %s with a SchemaError carrying a position", (_n, src) => {
  const d = diag(src);
  expect(d.line).toBeGreaterThan(0);
  expect(d.column).toBeGreaterThan(0);
});
it("ignores undefined, NaN, non-finite, non-positive and fractional limit overrides", () => {
  const big = "a".repeat(DEFAULT_SCHEMA_LIMITS.maxSourceBytes + 1);
  const longIdent = "a".repeat(DEFAULT_SCHEMA_LIMITS.maxIdentifierLength + 1);
  const longString = `"${"s".repeat(DEFAULT_SCHEMA_LIMITS.maxStringLength + 1)}"`;
  for (const bad of [undefined, Number.NaN, Infinity, -Infinity, 0, -1, 1.5]) {
    expect(() => tokenize(big, { maxSourceBytes: bad })).toThrow(SchemaError);
    expect(() => tokenize(longIdent, { maxIdentifierLength: bad })).toThrow(SchemaError);
    expect(() => tokenize(longString, { maxStringLength: bad })).toThrow(SchemaError);
  }
  // Inherited limits are ignored as well.
  expect(() => tokenize(longIdent, Object.create({ maxIdentifierLength: 1000 }) as object)).toThrow(SchemaError);
});
it("rejects sources over maxSourceBytes (UTF-8 bytes)", () => {
  expect(() => tokenize("a".repeat(11), { maxSourceBytes: 10 })).toThrow(SchemaError);
  expect(() => tokenize("é".repeat(6), { maxSourceBytes: 10 })).toThrow(SchemaError);
});
it("rejects strings over maxStringLength", () => {
  expect(() => tokenize('"abcdef"', { maxStringLength: 5 })).toThrow(SchemaError);
  expect(() => tokenize('"abcde"', { maxStringLength: 5 })).not.toThrow();
});
it("reports positions and never echoes source content", () => {
  const d = diag("a\n  SECRET;");
  expect([d.line, d.column]).toEqual([2, 9]);
  expect(d.message).not.toContain("SECRET");
  expect(d.message).not.toContain(";");
});
