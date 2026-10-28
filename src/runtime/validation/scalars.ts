import type { FieldIR, SchemaIndex } from "../../schema/ir.js";
import type { RuntimeLimits } from "../limits.js";
import { fail, isPlainObject, join, readArray, readObject } from "./plain.js";

// Bounded, unambiguous quantifiers: linear-time matching.
// eslint-disable-next-line security/detect-unsafe-regex
const DECIMAL = /^-?\d{1,65}(\.\d{1,30})?$/;
const MAX_JSON_DEPTH = 32;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

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
  if (value.length > limits.maxStringLength) fail("String is too long", path);
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
    case "DateTime": {
      if (!(value instanceof Date)) return fail("Expected a Date", path);
      const time = native(() => value.getTime(), "Expected a Date", path);
      if (Number.isNaN(time)) return fail("Invalid Date", path);
      const year = value.getUTCFullYear();
      if (year < 1 || year > 9999) return fail("Date year must be between 1 and 9999", path);
      return new Date(time);
    }
    case "Json":
      return copyJson(value, path, limits, 1);
    case "Bytes":
      if (!(value instanceof Uint8Array)) return fail("Expected a Uint8Array", path);
      native(() => value.byteLength, "Expected a Uint8Array", path);
      return new Uint8Array(value);
  }
}
