import { LimitExceededError } from "../../errors.js";
import type { ModelIndex } from "../../schema/ir.js";
import { type Ctx, model, parseWhere } from "./filters.js";
import { enforceLimit, fail, join, oneOrMany, readObject, withinLimit } from "./plain.js";
import type { IncludeNode, OrderByItem } from "./types.js";

const MAX_SKIP = 1_000_000;
const INCLUDE_OPTIONS: ReadonlySet<string> = new Set(["where", "orderBy", "select", "include"]);

export function parseSelect(target: ModelIndex, value: unknown, path: string): string[] {
  const entries = readObject(value, path);
  if (entries.size === 0) return fail("select must contain at least one field", path);
  const fields: string[] = [];
  for (const [key, flag] of entries) {
    const keyPath = join(path, key);
    const field = target.fields.get(key) ?? fail("Unknown field", keyPath);
    if (field.kind === "relation") fail("Relations cannot be selected; use include", keyPath);
    if (flag !== true) fail("select values must be true", keyPath);
    fields.push(key);
  }
  return fields;
}

export function parseOrderBy(ctx: Ctx, target: ModelIndex, value: unknown, path: string): OrderByItem[] {
  const parts = oneOrMany(value, path);
  enforceLimit("maxOrderBy", parts.length, ctx.limits.maxOrderBy, path);
  return parts.map((part) => {
    const entries = readObject(part.value, part.path);
    const [entry] = entries;
    if (entries.size !== 1 || entry === undefined) return fail("Each orderBy object must have exactly one key", part.path);
    const [key, direction] = entry;
    const keyPath = join(part.path, key);
    const field = target.fields.get(key) ?? fail("Unknown field", keyPath);
    if (field.kind === "relation") return fail("Relations cannot be ordered by", keyPath);
    if (field.kind === "scalar" && (field.type === "Json" || field.type === "Bytes" || field.type === "Decimal")) {
      return fail("Field type cannot be ordered by", keyPath);
    }
    if (direction !== "asc" && direction !== "desc") return fail("Sort direction must be asc or desc", keyPath);
    return { field: key, direction };
  });
}

function boundedInt(value: unknown, path: string, limit: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail("Expected a non-negative integer", path);
  }
  if (!withinLimit(value, max)) throw new LimitExceededError(limit, path);
  return value;
}

export function parseTake(ctx: Ctx, value: unknown, path: string): number {
  return boundedInt(value, path, "maxTake", ctx.limits.maxTake);
}

export function parseSkip(value: unknown, path: string): number {
  return boundedInt(value, path, "maxSkip", MAX_SKIP);
}

/** `depth` is the level of the relations listed in this object (top-level include is 1). */
export function parseInclude(ctx: Ctx, target: ModelIndex, value: unknown, path: string, depth: number): IncludeNode[] {
  const entries = readObject(value, path);
  if (entries.size > 0 && !withinLimit(depth, ctx.limits.maxIncludeDepth)) {
    throw new LimitExceededError("maxIncludeDepth", path);
  }
  const nodes: IncludeNode[] = [];
  for (const [key, spec] of entries) {
    const keyPath = join(path, key);
    const field = target.fields.get(key) ?? fail("Unknown relation", keyPath);
    if (field.kind !== "relation") return fail("Only relations can be included", keyPath);
    if (spec === true) {
      nodes.push({ relation: key, orderBy: [], include: [] });
      continue;
    }
    const related = model(ctx, field.target);
    const options = readObject(spec, keyPath, "true or an include object");
    for (const option of options.keys()) {
      if (!INCLUDE_OPTIONS.has(option)) fail("Unknown include option", join(keyPath, option));
      if (!field.list && (option === "where" || option === "orderBy")) {
        fail("Option only applies to to-many relations", join(keyPath, option));
      }
    }
    if (options.has("select") && options.has("include")) fail("select and include cannot be used together", keyPath);
    const node: IncludeNode = { relation: key, orderBy: [], include: [] };
    if (options.has("where")) node.where = parseWhere(ctx, related, options.get("where"), join(keyPath, "where"), 0);
    if (options.has("orderBy")) node.orderBy = parseOrderBy(ctx, related, options.get("orderBy"), join(keyPath, "orderBy"));
    if (options.has("select")) node.select = parseSelect(related, options.get("select"), join(keyPath, "select"));
    if (options.has("include")) {
      node.include = parseInclude(ctx, related, options.get("include"), join(keyPath, "include"), depth + 1);
    }
    nodes.push(node);
  }
  return nodes;
}
