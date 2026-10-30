import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/errors.js";
import type { Operation } from "../../src/runtime/validation.js";
import { validated } from "../helpers/builder.js";
import { arbBigInt, arbDate, arbDecimal, arbHostileString, arbWhere, injectKey, numRuns } from "./arbitraries.js";

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

const PROTOS: readonly object[] = [Object.prototype, Array.prototype, Function.prototype];

type Snapshot = readonly (readonly [object, string | symbol, PropertyDescriptor])[];

/** Every own property descriptor (value / get / set / flags) of the built-in prototypes. */
function protoSnapshot(): Snapshot {
  return PROTOS.flatMap((proto) =>
    Reflect.ownKeys(proto).map((key) => [proto, key, Object.getOwnPropertyDescriptor(proto, key) as PropertyDescriptor] as const),
  );
}

function expectUnchanged(before: Snapshot): void {
  const after = protoSnapshot();
  expect(after.length).toBe(before.length);
  for (const [i, [proto, key, d]] of before.entries()) {
    const [p2, k2, d2] = after[i] as Snapshot[number];
    expect(p2).toBe(proto);
    expect(k2).toBe(key);
    expect(Object.is(d2.value, d.value)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- identity comparison only
    expect(Object.is(d2.get, d.get) && Object.is(d2.set, d.set)).toBe(true);
    expect(d2.enumerable).toBe(d.enumerable);
    expect(d2.writable).toBe(d.writable);
    expect(d2.configurable).toBe(d.configurable);
  }
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
}

describe("validateArgs fuzzing", () => {
  for (const op of OPERATIONS) {
    it(`${op}: returns or throws ValidationError only, never pollutes prototypes`, () => {
      const before = protoSnapshot();
      let successes = 0;
      fc.assert(
        fc.property(fc.constantFrom("User", "Post"), arbArgs, (model, args) => {
          try {
            validated(model, op, args);
            successes += 1;
          } catch (error) {
            expect(error).toBeInstanceOf(ValidationError);
          }
        }),
        { numRuns: numRuns() },
      );
      expectUnchanged(before);
      // Guard against a validator that rejects everything: operations that accept `{}` must see successes.
      if (op === "findMany" || op === "findFirst" || op === "count") expect(successes).toBeGreaterThan(0);
    });
  }

  it("valid generated where filters are accepted (the validator does not reject everything)", () => {
    let successes = 0;
    const runs = numRuns();
    for (const model of ["User", "Post"] as const) {
      fc.assert(
        fc.property(arbWhere(model), (shape) => {
          validated(model, "findMany", { where: shape.build("a") });
          validated(model, "deleteMany", { where: shape.build("b") });
          successes += 1;
        }),
        { numRuns: runs },
      );
    }
    expect(successes).toBe(runs * 2);
  });

  const DANGEROUS_KEY = fc.constantFrom(...DANGEROUS.slice(0, 3));
  const payload = fc.constantFrom<unknown>(1, "x", null, {}, { polluted: "yes" }, { prototype: { polluted: "yes" } }, []);
  const path = fc.array(fc.nat(10), { maxLength: 6 });

  it("a dangerous own key injected at any depth of a valid where is rejected, without pollution", () => {
    const before = protoSnapshot();
    for (const model of ["User", "Post"] as const) {
      fc.assert(
        fc.property(arbWhere(model), DANGEROUS_KEY, path, payload, (shape, key, steps, value) => {
          const where = injectKey(shape.build("a"), steps, key, value);
          expect(() => validated(model, "findMany", { where })).toThrow(ValidationError);
        }),
        { numRuns: numRuns() },
      );
    }
    expectUnchanged(before);
  });

  it("a dangerous own key injected into valid create data is rejected, without pollution", () => {
    const before = protoSnapshot();
    const data = fc.record({
      title: arbHostileString,
      published: fc.boolean(),
      views: arbBigInt,
      rating: arbDecimal,
      updatedAt: arbDate,
      author: fc.constant({ connect: { id: 1 } }),
    });
    fc.assert(
      fc.property(data, DANGEROUS_KEY, path, payload, (row, key, steps, value) => {
        // Sanity: the untouched row is valid.
        validated("Post", "create", { data: row });
        const injected = injectKey({ data: row }, steps, key, value);
        expect(() => validated("Post", "create", injected)).toThrow(ValidationError);
      }),
      { numRuns: numRuns() },
    );
    expectUnchanged(before);
  });
});
