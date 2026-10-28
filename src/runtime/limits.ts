export interface RuntimeLimits {
  maxTake: number;
  maxRows: number;
  maxWhereDepth: number;
  maxIncludeDepth: number;
  maxInListSize: number;
  maxCreateManyRows: number;
  maxStringLength: number;
}

export const DEFAULT_RUNTIME_LIMITS: Readonly<RuntimeLimits> = Object.freeze({
  maxTake: 1000,
  maxRows: 10_000,
  maxWhereDepth: 5,
  maxIncludeDepth: 3,
  maxInListSize: 1000,
  maxCreateManyRows: 1000,
  maxStringLength: 1_000_000,
});
