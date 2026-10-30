import { isDeepStrictEqual } from "node:util";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { globPattern } from "../../src/dialects/sqlite.js";
import { compileFind } from "../helpers/builder.js";
import { arbWhere, leafCount, numRuns, stringsIn } from "./arbitraries.js";

const MODELS = ["User", "Post"] as const;

function placeholders(text: string): number {
  return text.split("?").length - 1;
}

describe("SQL text depends only on query shape", () => {
  for (const model of MODELS) {
    it(`${model}: two value sets give identical text, different parameters, and a real WHERE`, () => {
      fc.assert(
        fc.property(arbWhere(model), (shape) => {
          const whereA = shape.build("a");
          const whereB = shape.build("b");
          const first = compileFind(model, { where: whereA }, "many");
          const second = compileFind(model, { where: whereB }, "many");
          expect(second.text).toBe(first.text);
          expect(second.params.length).toBe(first.params.length);
          expect(placeholders(first.text)).toBe(first.params.length);
          if (leafCount(whereA) > 0) {
            expect(first.text).toContain("WHERE");
            expect(first.params.length).toBeGreaterThanOrEqual(leafCount(whereA));
          }
          if (!isDeepStrictEqual(whereA, whereB)) {
            expect(isDeepStrictEqual(first.params, second.params)).toBe(false);
          }
        }),
        { numRuns: numRuns() },
      );
    });

    it(`${model}: hostile string values reach params and never appear in the SQL text`, () => {
      fc.assert(
        fc.property(arbWhere(model), (shape) => {
          const where = shape.build("a");
          const { text, params } = compileFind(model, { where }, "many");
          for (const value of stringsIn(where)) {
            // Short or keyword-like strings may legitimately be substrings of the fixed SQL.
            if (value.length < 4 || !/[^A-Za-z_ ]/.test(value)) continue;
            expect(text.includes(value)).toBe(false);
            // Bound either as is, or inside a GLOB pattern (text operators).
            const encoded = globPattern("contains", value).slice(1, -1);
            const bound = params.some((p) => p === value || (typeof p === "string" && p.includes(encoded)));
            expect(bound).toBe(true);
          }
        }),
        { numRuns: numRuns() },
      );
    });
  }

  it("null comparisons change the shape (IS NULL) but stay value-free", () => {
    const isNull = compileFind("User", { where: { name: null } }, "many");
    const equals = compileFind("User", { where: { name: "x" } }, "many");
    expect(isNull.text).not.toBe(equals.text);
    expect(isNull.params).not.toContain("x");
    expect(compileFind("User", { where: { name: null } }, "many").text).toBe(isNull.text);
  });

  it("null filters on nullable fields compile to IS [NOT] NULL with no null parameter", () => {
    const nullable = fc.constantFrom(["User", "name"], ["Post", "rating"], ["Post", "cover"]);
    const form = fc.constantFrom("direct", "equals", "not");
    const wrap = fc.array(fc.constantFrom("AND", "OR", "NOT", "AND[]", "OR[]"), { maxLength: 2 });
    fc.assert(
      fc.property(nullable, form, wrap, ([model, field], f, wrappers) => {
        const leaf = f === "direct" ? null : f === "equals" ? { equals: null } : { not: null };
        let where: Record<string, unknown> = { [field as string]: leaf };
        for (const w of wrappers) {
          where = w === "AND[]" || w === "OR[]" ? { [w.slice(0, -2)]: [where] } : { [w]: where };
        }
        const { text, params } = compileFind(model, { where }, "many");
        expect(text).toContain(f === "not" ? "IS NOT NULL" : "IS NULL");
        expect(params).not.toContain(null);
        expect(placeholders(text)).toBe(params.length);
      }),
      { numRuns: numRuns() },
    );
  });
});
