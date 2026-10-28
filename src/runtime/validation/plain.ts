import { LimitExceededError, ValidationError } from "../../errors.js";

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function fail(message: string, path: string): never {
  throw new ValidationError(message, path);
}

/** Appends a key or array index to a dotted key path. */
export function join(path: string, key: string | number): string {
  const segment = String(key);
  return path === "" ? segment : `${path}.${segment}`;
}

/** Plain object: prototype is `Object.prototype` or `null`; never an array, Date, Map or class instance. */
export function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Reads an own data property without ever invoking a getter. */
function ownValue(source: object, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined) return fail("Undefined values are not allowed", path); // array hole
  if (!("value" in descriptor)) return fail("Accessor properties are not allowed", path);
  const value: unknown = descriptor.value;
  if (value === undefined) return fail("Undefined values are not allowed", path);
  return value;
}

/**
 * Reads a plain object's own enumerable string keys into a fresh Map.
 * Rejects forbidden keys, accessors and `undefined` values.
 */
export function readObject(value: unknown, path: string, what = "an object"): Map<string, unknown> {
  if (!isPlainObject(value)) return fail(`Expected ${what}`, path);
  const entries = new Map<string, unknown>();
  for (const key of Object.keys(value)) {
    const keyPath = join(path, key);
    if (FORBIDDEN_KEYS.has(key)) fail("Forbidden key", keyPath);
    entries.set(key, ownValue(value, key, keyPath));
  }
  return entries;
}

/** Reads a dense plain array into a fresh array; holes and `undefined` elements are rejected. */
export function readArray(value: unknown, path: string, max?: { limit: string; value: number }): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail("Expected an array", path);
  const length = value.length;
  if (max !== undefined && length > max.value) throw new LimitExceededError(max.limit, path);
  const out: unknown[] = [];
  for (let i = 0; i < length; i++) out.push(ownValue(value, String(i), join(path, i)));
  return out;
}

/** Accepts one value or an array of values (as `AND`, `OR` and `orderBy` do), each with its own path. */
export function oneOrMany(value: unknown, path: string): { value: unknown; path: string }[] {
  if (Array.isArray(value)) return readArray(value, path).map((item, i) => ({ value: item, path: join(path, i) }));
  return [{ value, path }];
}
