import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compileFind } from "../helpers/builder.js";
import { arbWhere, numRuns, stringsIn } from "./arbitraries.js";

const MODELS = ["User", "Post"] as const;

describe("SQL text depends only on query shape", () => {
  for (const model of MODELS) {
    it(`${model}: two value sets give identical text and the same parameter count`, () => {
      fc.assert(
        fc.property(arbWhere(model), (shape) => {
          const first = compileFind(model, { where: shape.build("a") }, "many");
          const second = compileFind(model, { where: shape.build("b") }, "many");
          expect(second.text).toBe(first.text);
          expect(second.params.length).toBe(first.params.length);
        }),
        { numRuns: numRuns() },
      );
    });

    it(`${model}: hostile string values never appear in the SQL text`, () => {
      fc.assert(
        fc.property(arbWhere(model), (shape) => {
          const where = shape.build("a");
          const { text } = compileFind(model, { where }, "many");
          for (const value of stringsIn(where)) {
            // Short or keyword-like strings may legitimately be substrings of the fixed SQL.
            if (value.length < 4 || !/[^A-Za-z_ ]/.test(value)) continue;
            expect(text.includes(value)).toBe(false);
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
});
