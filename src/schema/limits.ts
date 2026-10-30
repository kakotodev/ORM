export interface SchemaLimits {
  maxSourceBytes: number;
  maxIdentifierLength: number;
  maxStringLength: number;
  maxNestingDepth: number;
}

export const DEFAULT_SCHEMA_LIMITS: Readonly<SchemaLimits> = Object.freeze({
  maxSourceBytes: 1_048_576,
  maxIdentifierLength: 63,
  maxStringLength: 4096,
  maxNestingDepth: 16,
});

/**
 * Merges partial overrides with the defaults. Only own properties count, and undefined, non-finite,
 * non-positive and non-integer values are ignored, so an override can never disable a limit.
 */
export function resolveSchemaLimits(overrides: Partial<SchemaLimits> | null | undefined): SchemaLimits {
  const resolved: SchemaLimits = { ...DEFAULT_SCHEMA_LIMITS };
  if (overrides === undefined || overrides === null) return resolved;
  for (const key of Object.keys(DEFAULT_SCHEMA_LIMITS) as (keyof SchemaLimits)[]) {
    const value = Object.hasOwn(overrides, key) ? overrides[key] : undefined;
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) resolved[key] = value;
  }
  return resolved;
}
