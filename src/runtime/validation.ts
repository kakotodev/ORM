import type { SchemaIndex } from "../schema/ir.js";
import type { RuntimeLimits } from "./limits.js";
import { parseData } from "./validation/data.js";
import { type Ctx, model, parseUniqueWhere, parseWhere } from "./validation/filters.js";
import { fail, join, readArray, readObject } from "./validation/plain.js";
import { parseInclude, parseOrderBy, parseSelect, parseSkip, parseTake } from "./validation/query.js";
import type { FilterNode, IncludeNode, Operation, ValidatedArgs, ValidatedData, ValidatedFind } from "./validation/types.js";

export { validateScalar } from "./validation/scalars.js";
export type {
  FilterNode,
  IncludeNode,
  Operation,
  OrderByItem,
  ScalarOp,
  ValidatedArgs,
  ValidatedData,
  ValidatedFind,
} from "./validation/types.js";

const OPTIONS: ReadonlyMap<Operation, ReadonlySet<string>> = new Map<Operation, ReadonlySet<string>>([
  ["findMany", new Set(["where", "select", "include", "orderBy", "take", "skip"])],
  ["findFirst", new Set(["where", "select", "include", "orderBy", "take", "skip"])],
  ["findUnique", new Set(["where", "select", "include"])],
  ["count", new Set(["where", "orderBy", "take", "skip"])],
  ["create", new Set(["data", "select", "include"])],
  ["createMany", new Set(["data"])],
  ["update", new Set(["where", "data", "select", "include"])],
  ["updateMany", new Set(["where", "data"])],
  ["upsert", new Set(["where", "create", "update", "select", "include"])],
  ["delete", new Set(["where", "select", "include"])],
  ["deleteMany", new Set(["where"])],
]);

type Args = ReadonlyMap<string, unknown>;

function required(args: Args, key: string): unknown {
  return args.has(key) ? args.get(key) : fail(`${key} is required`, key);
}

function shape(ctx: Ctx, target: ReturnType<typeof model>, args: Args): { select?: string[]; include: IncludeNode[] } {
  if (args.has("select") && args.has("include")) fail("select and include cannot be used together", "");
  const out: { select?: string[]; include: IncludeNode[] } = { include: [] };
  if (args.has("select")) out.select = parseSelect(target, args.get("select"), "select");
  if (args.has("include")) out.include = parseInclude(ctx, target, args.get("include"), "include", 1);
  return out;
}

function find(ctx: Ctx, target: ReturnType<typeof model>, args: Args): ValidatedFind {
  const out: ValidatedFind = { ...shape(ctx, target, args), orderBy: [] };
  if (args.has("where")) out.where = parseWhere(ctx, target, args.get("where"), "where", 0);
  if (args.has("orderBy")) out.orderBy = parseOrderBy(target, args.get("orderBy"), "orderBy");
  if (args.has("take")) out.take = parseTake(ctx, args.get("take"), "take");
  if (args.has("skip")) out.skip = parseSkip(args.get("skip"), "skip");
  return out;
}

function unique(ctx: Ctx, target: ReturnType<typeof model>, args: Args): FilterNode {
  return parseUniqueWhere(ctx, target, required(args, "where"), "where");
}

function bulkWhere(ctx: Ctx, target: ReturnType<typeof model>, args: Args): FilterNode {
  if (!args.has("where")) fail("where is required (use {} to target all rows)", "where");
  return parseWhere(ctx, target, args.get("where"), "where", 0);
}

function createMany(ctx: Ctx, target: ReturnType<typeof model>, args: Args): ValidatedData[] {
  const rows = readArray(required(args, "data"), "data", { limit: "maxCreateManyRows", value: ctx.limits.maxCreateManyRows });
  if (rows.length === 0) fail("data must contain at least one row", "data");
  return rows.map((row, i) => parseData(ctx, target, row, join("data", i), "createMany"));
}

/**
 * Validates and normalizes client arguments for one operation. Everything not explicitly allowed by
 * the schema is rejected; the result is built from fresh containers and never aliases the input.
 */
export function validateArgs(
  index: SchemaIndex,
  modelName: string,
  op: Operation,
  args: unknown,
  limits: RuntimeLimits,
): ValidatedArgs {
  const ctx: Ctx = { index, limits };
  const target = model(ctx, modelName);
  const allowed = OPTIONS.get(op) ?? fail("Unknown operation", "");
  const entries = readObject(args, "", "an arguments object");
  for (const key of entries.keys()) {
    if (!allowed.has(key)) fail("Unknown option for this operation", key);
  }

  switch (op) {
    case "findMany":
    case "findFirst":
    case "count":
      return { op, ...find(ctx, target, entries) };
    case "findUnique":
      return { op, where: unique(ctx, target, entries), ...shape(ctx, target, entries), orderBy: [] };
    case "create":
      return { op, data: parseData(ctx, target, required(entries, "data"), "data", "create"), ...shape(ctx, target, entries) };
    case "createMany":
      return { op, data: createMany(ctx, target, entries) };
    case "update":
      return {
        op,
        where: unique(ctx, target, entries),
        data: parseData(ctx, target, required(entries, "data"), "data", "update"),
        ...shape(ctx, target, entries),
      };
    case "updateMany":
      return {
        op,
        where: bulkWhere(ctx, target, entries),
        data: parseData(ctx, target, required(entries, "data"), "data", "update"),
      };
    case "upsert":
      return {
        op,
        where: unique(ctx, target, entries),
        create: parseData(ctx, target, required(entries, "create"), "create", "create"),
        update: parseData(ctx, target, required(entries, "update"), "update", "update"),
        ...shape(ctx, target, entries),
      };
    case "delete":
      return { op, where: unique(ctx, target, entries), ...shape(ctx, target, entries) };
    case "deleteMany":
      return { op, where: bulkWhere(ctx, target, entries) };
  }
}
