import type { FieldIR, SchemaIndex } from "../../schema/ir.js";
import type { RuntimeLimits } from "../limits.js";
import { enforceLimit, fail, isPlainObject, join, readArray, readObject, withinLimit } from "./plain.js";

// Bounded, unambiguous quantifiers: linear-time matching.
// eslint-disable-next-line security/detect-unsafe-regex
const DECIMAL = /^-?\d{1,65}(\.\d{1,30})?$/;
const MAX_JSON_DEPTH = 32;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// Built-ins captured at load time and applied with `.call`, so brand checks never run caller-defined methods.
/* eslint-disable @typescript-eslint/unbound-method */
const dateGetTime = Date.prototype.getTime;
const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayProto, "byteLength")?.get;
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayProto, Symbol.toStringTag)?.get;
const uint8Set = Uint8Array.prototype.set;
/* eslint-enable @typescript-eslint/unbound-method */

/** Runs a native accessor that throws on objects merely inheriting from the built-in prototype. */
function native<T>(read: () => T, message: string, path: string): T {
  try {
    return read();
  } catch {
    return fail(message, path);
  }
}

function checkString(value: string, path: string, limits: RuntimeLimits): string {
  if (value.includes("\0")) fail("Strings must not contain NUL characters", path);
  if (!withinLimit(value.length, limits.maxStringLength)) fail("String is too long", path);
  return value;
}

/** Deep-copies a JSON value made of plain objects, arrays, strings, finite numbers, booleans and null. */
function copyJson(value: unknown, path: string, limits: RuntimeLimits, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return checkString(value, path, limits);
  if (typeof value === "number") return Number.isFinite(value) ? value : fail("Expected a finite number", path);
  if (typeof value !== "object" || (!Array.isArray(value) && !isPlainObject(value))) {
    return fail("Expected a JSON value", path);
  }
  if (depth > MAX_JSON_DEPTH) return fail("JSON value is nested too deeply", path);
  if (Array.isArray(value)) {
    return readArray(value, path).map((item, i) => copyJson(item, join(path, i), limits, depth + 1));
  }
  const out: [string, unknown][] = [];
  for (const [key, item] of readObject(value, path)) {
    const keyPath = join(path, key);
    checkString(key, keyPath, limits);
    out.push([key, copyJson(item, keyPath, limits, depth + 1)]);
  }
  return Object.fromEntries(out); // own data properties only, never a prototype setter
}

/** Brand-checks a real Date through the built-in getter (subclass overrides are ignored) and copies it. */
function copyDate(value: unknown, path: string): Date {
  const time = native(() => dateGetTime.call(value as Date), "Expected a Date", path);
  if (!Number.isFinite(time)) return fail("Invalid Date", path);
  const copy = new Date(time);
  const year = copy.getUTCFullYear();
  if (year < 1 || year > 9999) return fail("Date year must be between 1 and 9999", path);
  return copy;
}

/**
 * Brand-checks a real Uint8Array through the built-in TypedArray getters and copies its bytes with the
 * built-in `set` (typed-array source: no iterator, species or getter of the caller is consulted).
 */
function copyBytes(value: unknown, path: string): Uint8Array {
  if (typedArrayByteLength === undefined || typedArrayTag === undefined) return fail("Expected a Uint8Array", path);
  const tag: unknown = typedArrayTag.call(value);
  if (tag !== "Uint8Array") return fail("Expected a Uint8Array", path);
  const length = native(() => typedArrayByteLength.call(value) as number, "Expected a Uint8Array", path);
  const copy = new Uint8Array(length);
  native(() => {
    uint8Set.call(copy, value as Uint8Array);
  }, "Expected a Uint8Array", path);
  return copy;
}

/**
 * Validates one value for a scalar or enum field and returns a fresh, normalized copy
 * (BigInt as `bigint`, new Date / Uint8Array / JSON containers). `null` only when the field is nullable.
 */
export function validateScalar(
  index: SchemaIndex,
  field: FieldIR,
  value: unknown,
  path: string,
  limits: RuntimeLimits,
): unknown {
  if (field.kind === "relation") return fail("Expected a scalar field", path);
  if (value === null) return field.nullable ? null : fail("Field is not nullable", path);
  if (field.kind === "enum") {
    const values = index.enums.get(field.enumName)?.values ?? [];
    return typeof value === "string" && values.includes(value) ? value : fail("Expected an enum value", path);
  }
  switch (field.type) {
    case "Int":
      return typeof value === "number" && Number.isSafeInteger(value) ? value : fail("Expected a safe integer", path);
    case "BigInt": {
      if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
      if (typeof value === "bigint" && value >= INT64_MIN && value <= INT64_MAX) return value;
      return fail("Expected a 64-bit integer", path);
    }
    case "Float":
      return typeof value === "number" && Number.isFinite(value) ? value : fail("Expected a finite number", path);
    case "Decimal":
      return typeof value === "string" && DECIMAL.test(value) ? value : fail("Expected a decimal string", path);
    case "String":
      return typeof value === "string" ? checkString(value, path, limits) : fail("Expected a string", path);
    case "Boolean":
      return typeof value === "boolean" ? value : fail("Expected a boolean", path);
    case "DateTime":
      return copyDate(value, path);
    case "Json": {
      const copy = copyJson(value, path, limits, 1);
      enforceLimit("maxStringLength", JSON.stringify(copy).length, limits.maxStringLength, path);
      return copy;
    }
    case "Bytes":
      return copyBytes(value, path);
  }
}
