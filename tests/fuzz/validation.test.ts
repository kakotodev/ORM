import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/errors.js";
import type { Operation } from "../../src/runtime/validation.js";
import { validated } from "../helpers/builder.js";
import { numRuns } from "./arbitraries.js";

const OPERATIONS: readonly Operation[] = [
  "findMany", "findFirst", "findUnique", "count", "create", "createMany",
  "update", "updateMany", "upsert", "delete", "deleteMany",
];
const DANGEROUS = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "polluted"] as const;
const OPTION_KEYS = [
  "where", "data", "select", "include", "orderBy", "take", "skip", "create", "update",
  "AND", "OR", "NOT", "some", "is", "equals", "in", "id", "email", "posts", "author",
] as const;

const anything = fc.anything({
  withBigInt: true,
  withDate: true,
  withTypedArray: true,
  withNullPrototype: true,
  withSparseArray: true,
  withBoxedValues: true,
  withMap: true,
  withSet: true,
  withObjectString: true,
  maxDepth: 4,
  maxKeys: 6,
});

const keys = fc.oneof(fc.constantFrom(...DANGEROUS), fc.constantFrom(...OPTION_KEYS), fc.string({ maxLength: 8 }));
const mixedObject = fc.object({
  key: keys,
  values: [anything, fc.constant({}), fc.constant([]), fc.constant(null)],
  maxDepth: 4,
  maxKeys: 6,
});
const optionRecord = fc.dictionary(fc.constantFrom(...OPTION_KEYS), fc.oneof(anything, mixedObject), { maxKeys: 5 });
// Own enumerable dangerous keys, defined explicitly (a plain assignment of __proto__ would set the prototype).
const dangerousRecord = fc
  .array(fc.tuple(fc.constantFrom(...DANGEROUS), fc.oneof(anything, mixedObject)), { maxLength: 4 })
  .map((pairs) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of pairs) Object.defineProperty(out, k, { value: v, enumerable: true, configurable: true, writable: true });
    return out;
  });

const arbArgs = fc.oneof(anything, mixedObject, optionRecord, dangerousRecord);

function protoSnapshot(): string {
  return JSON.stringify([
    Object.getOwnPropertyNames(Object.prototype).sort(),
    Object.getOwnPropertyNames(Array.prototype).sort(),
    Object.getOwnPropertyNames(Function.prototype).sort(),
  ]);
}

describe("validateArgs fuzzing", () => {
  for (const op of OPERATIONS) {
    it(`${op}: returns or throws ValidationError only, never pollutes prototypes`, () => {
      const before = protoSnapshot();
      fc.assert(
        fc.property(fc.constantFrom("User", "Post"), arbArgs, (model, args) => {
          try {
            validated(model, op, args);
          } catch (error) {
            expect(error).toBeInstanceOf(ValidationError);
          }
        }),
        { numRuns: numRuns() },
      );
      expect(protoSnapshot()).toBe(before);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  }
});
