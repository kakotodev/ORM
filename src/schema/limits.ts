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
