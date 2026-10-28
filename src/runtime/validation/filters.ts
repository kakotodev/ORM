import { LimitExceededError } from "../../errors.js";
import type { EnumField, ModelIndex, RelationField, ScalarField, SchemaIndex } from "../../schema/ir.js";
import type { RuntimeLimits } from "../limits.js";
import { validateScalar } from "./scalars.js";
import { fail, isPlainObject, join, oneOrMany, readArray, readObject } from "./plain.js";
import type { FilterNode, ScalarOp } from "./types.js";

export interface Ctx {
  index: SchemaIndex;
  limits: RuntimeLimits;
}

const SCALAR_OPS: ReadonlySet<string> = new Set<ScalarOp>([
  "equals", "not", "in", "notIn", "lt", "lte", "gt", "gte", "contains", "startsWith", "endsWith",
]);
const EQUALITY_OPS: ReadonlySet<ScalarOp> = new Set<ScalarOp>(["equals", "not", "in", "notIn"]);
const COMPARABLE_OPS: ReadonlySet<ScalarOp> = new Set<ScalarOp>([...EQUALITY_OPS, "lt", "lte", "gt", "gte"]);
const STRING_OPS: ReadonlySet<ScalarOp> = new Set<ScalarOp>([...COMPARABLE_OPS, "contains", "startsWith", "endsWith"]);

function allowedOps(field: ScalarField | EnumField): ReadonlySet<ScalarOp> {
  if (field.kind === "enum") return EQUALITY_OPS;
  switch (field.type) {
    case "String":
      return STRING_OPS;
    case "Int":
    case "BigInt":
    case "Float":
    case "DateTime":
      return COMPARABLE_OPS;
    default:
      return EQUALITY_OPS;
  }
}

export function model(ctx: Ctx, name: string): ModelIndex {
  const found = ctx.index.models.get(name);
  return found ?? fail("Unknown model", "");
}

/** One entry → its node; several → `and` in key order; none → empty `and`. */
function combine(items: FilterNode[]): FilterNode {
  const [first] = items;
  return items.length === 1 && first !== undefined ? first : { kind: "and", items };
}

/** Validates a non-null value for one of the field's scalar operators. */
function operand(ctx: Ctx, field: ScalarField | EnumField, value: unknown, path: string): unknown {
  if (value === null) return fail("Null is only allowed with equals or not", path);
  return validateScalar(ctx.index, field, value, path, ctx.limits);
}

function scalarFilter(ctx: Ctx, field: ScalarField | EnumField, value: unknown, path: string): FilterNode {
  if (field.kind === "scalar" && field.type === "Json") return fail("Json fields cannot be filtered", path);
  if (!isPlainObject(value)) {
    const direct = value === null ? null : operand(ctx, field, value, path);
    return { kind: "field", field: field.name, op: "equals", value: direct };
  }
  const ops = readObject(value, path);
  if (ops.size === 0) return fail("Filter must contain at least one operator", path);
  const allowed = allowedOps(field);
  const items: FilterNode[] = [];
  for (const [key, operandValue] of ops) {
    const opPath = join(path, key);
    if (!SCALAR_OPS.has(key)) fail("Unknown filter operator", opPath);
    const op = key as ScalarOp;
    if (!allowed.has(op)) fail("Operator not supported for this field type", opPath);
    let normalized: unknown;
    if (op === "in" || op === "notIn") {
      const list = readArray(operandValue, opPath, { limit: "maxInListSize", value: ctx.limits.maxInListSize });
      normalized = list.map((item, i) => operand(ctx, field, item, join(opPath, i)));
    } else if ((op === "equals" || op === "not") && operandValue === null) {
      normalized = null;
    } else {
      normalized = operand(ctx, field, operandValue, opPath);
    }
    items.push({ kind: "field", field: field.name, op, value: normalized });
  }
  return combine(items);
}

function relationFilter(
  ctx: Ctx,
  field: RelationField,
  value: unknown,
  path: string,
  depth: number,
): FilterNode {
  const target = model(ctx, field.target);
  const ops = readObject(value, path);
  if (ops.size === 0) return fail("Relation filter must contain at least one operator", path);
  const items: FilterNode[] = [];
  for (const [key, inner] of ops) {
    const opPath = join(path, key);
    if (field.list) {
      if (key !== "some" && key !== "none" && key !== "every") fail("Unknown to-many relation operator", opPath);
      items.push({ kind: "relation", field: field.name, op: key, filter: parseWhere(ctx, target, inner, opPath, depth) });
    } else {
      if (key !== "is" && key !== "isNot") fail("Unknown to-one relation operator", opPath);
      const filter = inner === null ? null : parseWhere(ctx, target, inner, opPath, depth);
      items.push({ kind: "relation", field: field.name, op: key, filter });
    }
  }
  return combine(items);
}

/**
 * Normalizes a `where` object. `depth` is the nesting level of this object
 * (top-level 0; each AND / OR / NOT / relation filter adds one).
 */
export function parseWhere(ctx: Ctx, target: ModelIndex, value: unknown, path: string, depth: number): FilterNode {
  if (depth > ctx.limits.maxWhereDepth) throw new LimitExceededError("maxWhereDepth", path);
  const entries = readObject(value, path);
  const items: FilterNode[] = [];
  for (const [key, entry] of entries) {
    const keyPath = join(path, key);
    if (key === "AND" || key === "OR") {
      const parts = oneOrMany(entry, keyPath).map((part) => parseWhere(ctx, target, part.value, part.path, depth + 1));
      items.push({ kind: key === "AND" ? "and" : "or", items: parts });
    } else if (key === "NOT") {
      const parts = oneOrMany(entry, keyPath).map((part) => parseWhere(ctx, target, part.value, part.path, depth + 1));
      const [single] = parts;
      const item: FilterNode = Array.isArray(entry) || single === undefined ? { kind: "and", items: parts } : single;
      items.push({ kind: "not", item });
    } else {
      const field = target.fields.get(key) ?? fail("Unknown field", keyPath);
      items.push(
        field.kind === "relation"
          ? relationFilter(ctx, field, entry, keyPath, depth + 1)
          : scalarFilter(ctx, field, entry, keyPath),
      );
    }
  }
  return combine(items);
}

function uniqueValue(ctx: Ctx, target: ModelIndex, name: string, value: unknown, path: string): FilterNode {
  const field = target.fields.get(name);
  if (field === undefined || field.kind === "relation") return fail("Unknown field", path);
  if (value === null) return fail("Unique criterion must not be null", path);
  if (isPlainObject(value)) return fail("Unique criterion must be a direct value", path);
  return { kind: "field", field: name, op: "equals", value: validateScalar(ctx.index, field, value, path, ctx.limits) };
}

/**
 * Validates a `where` that must identify one row: exactly one key, which is the `@id`,
 * an `@unique` field, or a compound `@@unique([a, b])` given as `a_b: { a, b }`. Strict equality only.
 */
export function parseUniqueWhere(ctx: Ctx, target: ModelIndex, value: unknown, path: string): FilterNode {
  const entries = readObject(value, path);
  const [entry] = entries;
  if (entries.size !== 1 || entry === undefined) return fail("where must contain exactly one unique criterion", path);
  const [key, criterion] = entry;
  const keyPath = join(path, key);
  const field = target.fields.get(key);
  if (field !== undefined) {
    const unique = field.kind !== "relation" && (target.ir.primaryKey === key || field.isUnique);
    if (!unique) return fail("Field is not a unique criterion", keyPath);
    return uniqueValue(ctx, target, key, criterion, keyPath);
  }
  const compound = target.ir.uniques.find((names) => names.length > 1 && names.join("_") === key);
  if (compound === undefined) return fail("Unknown unique criterion", keyPath);
  const parts = readObject(criterion, keyPath);
  for (const name of parts.keys()) {
    if (!compound.includes(name)) fail("Unknown field in compound unique", join(keyPath, name));
  }
  const items = compound.map((name) => {
    const partPath = join(keyPath, name);
    if (!parts.has(name)) return fail("Missing field in compound unique", partPath);
    return uniqueValue(ctx, target, name, parts.get(name), partPath);
  });
  return { kind: "and", items };
}
