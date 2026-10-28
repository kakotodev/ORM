import fc from "fast-check";
import { vi } from "vitest";
import type { FieldIR } from "../../src/schema/ir.js";
import { idx } from "../helpers/builder.js";
import { INJECTION_PAYLOADS } from "../security/corpus.js";

// Deep campaigns (FC_NUM_RUNS=2000+) exceed the default 5 s per-test timeout.
vi.setConfig({ testTimeout: 300_000 });

/** Number of runs per property; override with FC_NUM_RUNS for deeper campaigns. */
export function numRuns(): number {
  return Number(process.env.FC_NUM_RUNS ?? 200);
}

const noNul = (s: string): string => s.replaceAll("\0", "");

/** Hostile strings: the injection corpus, arbitrary Unicode and binary-ish text. Never contains NUL. */
export const arbHostileString: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...INJECTION_PAYLOADS),
  fc.string({ unit: "binary", maxLength: 40 }).map(noNul),
  fc.string({ unit: "grapheme", maxLength: 40 }).map(noNul),
  fc.string({ unit: "binary-ascii", maxLength: 40 }).map(noNul),
  fc.constantFrom("'", '"', "`", ";", "--", "/*", "%", "_", "\\", "?", "$1", ":x", "@x").map((s) => s + "' OR 1=1 --"),
);

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

function cleanJson(value: unknown): boolean {
  if (typeof value === "string") return !value.includes("\0");
  if (Array.isArray(value)) return value.every(cleanJson);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).every(([k, v]) => !FORBIDDEN_KEYS.has(k) && !k.includes("\0") && cleanJson(v));
  }
  return true;
}

/** Non-null JSON values that survive a stringify/parse trip unchanged (no -0), without forbidden keys or NUL. */
export const arbJson: fc.Arbitrary<unknown> = fc
  .jsonValue()
  .map((v) => JSON.parse(JSON.stringify(v)) as unknown)
  .filter((v) => v !== null && cleanJson(v) && JSON.stringify(v).length <= 1_000_000);

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

export const arbBigInt: fc.Arbitrary<bigint> = fc.oneof(
  fc.bigInt({ min: INT64_MIN, max: INT64_MAX }),
  fc.constantFrom(INT64_MIN, INT64_MAX, 0n, -1n, 1n),
);

export const arbDecimal: fc.Arbitrary<string> = fc
  .tuple(
    fc.boolean(),
    fc.stringMatching(/^[0-9]{1,65}$/),
    fc.option(fc.stringMatching(/^[0-9]{1,30}$/), { nil: undefined }),
  )
  .map(([neg, int, frac]) => `${neg ? "-" : ""}${int}${frac === undefined ? "" : "." + frac}`);

export const arbDate: fc.Arbitrary<Date> = fc.date({
  min: new Date("0001-01-01T00:00:00.000Z"),
  max: new Date("9999-12-31T23:59:59.999Z"),
  noInvalidDate: true,
});

/** A non-null value valid for the given scalar or enum field. */
export function arbValueFor(field: FieldIR): fc.Arbitrary<unknown> {
  if (field.kind === "relation") throw new Error("relation fields have no scalar value");
  if (field.kind === "enum") return fc.constantFrom(...(idx.enums.get(field.enumName)?.values ?? []));
  switch (field.type) {
    case "Int":
      return fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER });
    case "BigInt":
      return arbBigInt;
    case "Float":
      return fc.double({ noNaN: true, noDefaultInfinity: true });
    case "Decimal":
      return arbDecimal;
    case "String":
      return arbHostileString;
    case "Boolean":
      return fc.boolean();
    case "DateTime":
      return arbDate;
    case "Json":
      return arbJson;
    case "Bytes":
      return fc.uint8Array({ maxLength: 256 });
  }
}

const EQUALITY = ["equals", "not", "in", "notIn"] as const;
const COMPARABLE = [...EQUALITY, "lt", "lte", "gt", "gte"] as const;
const TEXT = [...COMPARABLE, "contains", "startsWith", "endsWith"] as const;

function opsFor(field: FieldIR): readonly string[] {
  if (field.kind === "enum") return EQUALITY;
  if (field.kind === "relation") return [];
  switch (field.type) {
    case "String":
      return TEXT;
    case "Int":
    case "BigInt":
    case "Float":
    case "DateTime":
      return COMPARABLE;
    case "Json":
      return [];
    default:
      return EQUALITY;
  }
}

type ValueSet = "a" | "b";
type Builder = (set: ValueSet) => unknown;

/** A `where` shape carrying two independent value sets (`a` and `b`) for every value slot. */
export interface Shape {
  readonly build: (set: ValueSet) => Record<string, unknown>;
}

function slot(field: FieldIR): fc.Arbitrary<Record<ValueSet, unknown>> {
  return fc.record({ a: arbValueFor(field), b: arbValueFor(field) });
}

function operatorValue(field: FieldIR, op: string): fc.Arbitrary<Builder> {
  if (op === "in" || op === "notIn") {
    return fc
      .integer({ min: 0, max: 4 })
      .chain((n) => fc.array(slot(field), { minLength: n, maxLength: n }))
      .map((slots) => (set: ValueSet) => slots.map((s) => s[set]));
  }
  return slot(field).map((s) => (set: ValueSet) => s[set]);
}

function leaf(field: FieldIR): fc.Arbitrary<Builder> {
  const direct = slot(field).map((s): Builder => (set) => s[set]);
  const operators = fc
    .uniqueArray(fc.constantFrom(...opsFor(field)), { minLength: 1, maxLength: 4 })
    .chain((ops) =>
      fc.tuple(...ops.map((op) => operatorValue(field, op))).map((builders): Builder => (set) => {
        const out: Record<string, unknown> = {};
        builders.forEach((b, i) => {
          out[ops[i] as string] = b(set);
        });
        return out;
      }),
    );
  return fc.oneof(direct, operators);
}

/** Valid where shapes over the blog schema, nested at most `depth` levels (default 3). */
export function arbWhere(modelName: string, depth = 3): fc.Arbitrary<Shape> {
  const model = idx.models.get(modelName);
  if (model === undefined) throw new Error("unknown model");
  const entries: Record<string, fc.Arbitrary<Builder>> = {};
  for (const [name, field] of model.fields) {
    if (field.kind === "relation") {
      if (depth <= 1) continue;
      const ops = field.list ? (["some", "none", "every"] as const) : (["is", "isNot"] as const);
      entries[name] = fc
        .tuple(fc.constantFrom(...ops), arbWhere(field.target, depth - 1))
        .map(([op, shape]): Builder => (set) => ({ [op]: shape.build(set) }));
    } else if (opsFor(field).length > 0) {
      entries[name] = leaf(field);
    }
  }
  if (depth > 1) {
    const sub = arbWhere(modelName, depth - 1);
    const list = fc.array(sub, { maxLength: 3 }).map((xs): Builder => (set) => xs.map((x) => x.build(set)));
    entries.AND = list;
    entries.OR = list;
    entries.NOT = sub.map((x): Builder => (set) => x.build(set));
  }
  return fc.record(entries, { requiredKeys: [] }).map((rec) => ({
    build: (set: ValueSet): Record<string, unknown> =>
      Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, (v as Builder)(set)])),
  }));
}

/** Every string anywhere inside a value (used to check no value leaks into SQL text). */
export function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === "object" && value !== null && !(value instanceof Date) && !(value instanceof Uint8Array)) {
    return Object.values(value).flatMap(stringsIn);
  }
  return [];
}

/** Number of scalar values (not containers, not empty lists) inside a where-like value. */
export function leafCount(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + leafCount(v), 0);
  if (typeof value === "object" && value !== null && !(value instanceof Date) && !(value instanceof Uint8Array)) {
    return Object.values(value).reduce<number>((n, v) => n + leafCount(v), 0);
  }
  return 1;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof Uint8Array);
}

/**
 * Returns a copy of `root` where an own `key` is defined (via defineProperty, so `__proto__` is an own
 * property) on a plain object found by following `path` (indexes into the child containers) as deep as possible.
 */
export function injectKey(root: unknown, path: readonly number[], key: string, payload: unknown): unknown {
  const copy = structuredCloneLoose(root);
  let current: unknown = copy;
  for (const step of path) {
    const children = (Array.isArray(current) ? current : isPlain(current) ? Object.values(current) : []).filter(
      (c) => isPlain(c) || Array.isArray(c),
    );
    if (children.length === 0) break;
    current = children[step % children.length];
  }
  const target = isPlain(current) ? current : isPlain(copy) ? copy : undefined;
  if (target === undefined) return root;
  Object.defineProperty(target, key, { value: payload, enumerable: true, configurable: true, writable: true });
  return copy;
}

function structuredCloneLoose(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structuredCloneLoose);
  if (isPlain(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, structuredCloneLoose(v)]));
  return value;
}
