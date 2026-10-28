import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SchemaError } from "../../src/errors.js";
import { loadSchema } from "../../src/schema/index.js";
import { BLOG_SCHEMA } from "../helpers/schemas.js";
import { numRuns } from "./arbitraries.js";

function check(source: string): void {
  const start = performance.now();
  try {
    expect(typeof loadSchema(source)).toBe("object");
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaError);
  }
  expect(performance.now() - start).toBeLessThan(1000);
}

type Mutation = readonly [kind: "delete" | "duplicate" | "insert", at: number, length: number, text: string];

function mutate(source: string, mutations: readonly Mutation[]): string {
  let out = source;
  for (const [kind, at, length, text] of mutations) {
    const pos = at % (out.length + 1);
    if (kind === "delete") out = out.slice(0, pos) + out.slice(pos + length);
    else if (kind === "duplicate") out = out.slice(0, pos + length) + out.slice(pos, pos + length) + out.slice(pos + length);
    else out = out.slice(0, pos) + text + out.slice(pos);
  }
  return out;
}

const arbMutation: fc.Arbitrary<Mutation> = fc.tuple(
  fc.constantFrom("delete" as const, "duplicate" as const, "insert" as const),
  fc.nat(BLOG_SCHEMA.length * 2),
  fc.integer({ min: 1, max: 40 }),
  fc.oneof(
    fc.string({ maxLength: 8 }),
    fc.constantFrom("{", "}", "(", ")", "[", "]", "@", "@@", '"', "//", "/*", "?", ",", "\0", "\r", String.fromCharCode(0x202e)),
  ),
);

const TOKENS = [
  "model", "enum", "datasource", "User", "{", "}", "@id", "@@index", "[", "]", "(", ")", "?", "String", "Int",
  "\n", '"', "=", ",", "env(", "@relation(", "fields:", "references:",
] as const;

describe("schema parser fuzzing", () => {
  it("random strings give an IR or a SchemaError, quickly", () => {
    fc.assert(fc.property(fc.string({ unit: "binary", maxLength: 300 }), check), { numRuns: numRuns() });
  });

  it("random token soups give an IR or a SchemaError, quickly", () => {
    const soup = fc.array(fc.constantFrom(...TOKENS), { maxLength: 60 }).map((t) => t.join(" "));
    fc.assert(fc.property(soup, check), { numRuns: numRuns() });
  });

  it("mutations of the blog schema give an IR or a SchemaError, quickly", () => {
    fc.assert(
      fc.property(fc.array(arbMutation, { minLength: 1, maxLength: 5 }), (mutations) => {
        check(mutate(BLOG_SCHEMA, mutations));
      }),
      { numRuns: numRuns() },
    );
  });
});
