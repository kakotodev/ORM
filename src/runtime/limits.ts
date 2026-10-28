import { ConfigError } from "../errors.js";

export interface RuntimeLimits {
  maxTake: number;
  maxRows: number;
  maxWhereDepth: number;
  maxIncludeDepth: number;
  maxInListSize: number;
  maxCreateManyRows: number;
  maxStringLength: number;
  /** Field conditions summed over every where of one call; an in/notIn condition counts its elements. */
  maxWhereTerms: number;
  /** orderBy entries per query or per include. */
  maxOrderBy: number;
}

export const DEFAULT_RUNTIME_LIMITS: Readonly<RuntimeLimits> = Object.freeze({
  maxTake: 1000,
  maxRows: 10_000,
  maxWhereDepth: 5,
  maxIncludeDepth: 3,
  maxInListSize: 1000,
  maxCreateManyRows: 1000,
  maxStringLength: 1_000_000,
  maxWhereTerms: 5000,
  maxOrderBy: 16,
});

/**
 * Merges partial overrides onto the defaults. `undefined` entries are ignored; any other value must be a
 * positive safe integer, so a NaN, negative or non-numeric override can never disable a limit.
 */
export function resolveRuntimeLimits(overrides?: Partial<RuntimeLimits> | null): RuntimeLimits {
  const resolved: RuntimeLimits = { ...DEFAULT_RUNTIME_LIMITS };
  if (overrides === undefined) return resolved;
  if (typeof (overrides as unknown) !== "object" || overrides === null) throw new ConfigError("Runtime limits must be an object");
  const known = new Set<string>(Object.keys(DEFAULT_RUNTIME_LIMITS));
  for (const key of Object.keys(overrides)) {
    if (!known.has(key)) throw new ConfigError("Unknown runtime limit option");
  }
  for (const key of Object.keys(DEFAULT_RUNTIME_LIMITS) as (keyof RuntimeLimits)[]) {
    if (!Object.hasOwn(overrides, key)) continue;
    const value: unknown = overrides[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new ConfigError(`Runtime limit ${key} must be a positive integer`);
    }
    resolved[key] = value;
  }
  return resolved;
}
