import type { Dialect } from "../dialects/dialect.js";
import type { SelectQuery, SqlExpr } from "../dialects/sql-ast.js";
import { OrmError } from "../errors.js";
import type { FieldIR, ModelIndex, RelationField, SchemaIndex } from "../schema/ir.js";
import { oppositeRelation } from "../schema/ir.js";
import type { RuntimeLimits } from "./limits.js";
import type { FilterNode, OrderByItem, ValidatedFind } from "./validation.js";

export interface BuildContext {
  index: SchemaIndex;
  dialect: Dialect;
  limits: RuntimeLimits;
  /** "t0", "t1", ...: a fresh alias for every (sub)query of one statement. */
  nextAlias(): string;
}

export function createBuildContext(index: SchemaIndex, dialect: Dialect, limits: RuntimeLimits): BuildContext {
  let counter = 0;
  return {
    index,
    dialect,
    limits,
    nextAlias: () => `t${String(counter++)}`,
  };
}

function fail(message: string): never {
  throw new OrmError("VALIDATION", message);
}

function modelOf(ctx: BuildContext, model: string): ModelIndex {
  return ctx.index.models.get(model) ?? fail("Unknown model");
}

function fieldOf(model: ModelIndex, name: string): FieldIR {
  return model.fields.get(name) ?? fail("Unknown field");
}

function columnOf(model: ModelIndex, name: string): string {
  const field = fieldOf(model, name);
  return field.kind === "relation" ? fail("Relation fields have no column") : field.column;
}

function col(alias: string, column: string): SqlExpr {
  return { kind: "column", alias, column };
}

function param(ctx: BuildContext, field: FieldIR, raw: unknown): SqlExpr {
  return { kind: "param", value: ctx.dialect.encode(field, raw) };
}

// ------------------------------------------------------------------ filters

function scalarFilter(ctx: BuildContext, alias: string, field: FieldIR, op: string, raw: unknown): SqlExpr {
  if (field.kind === "relation") return fail("Relation fields cannot be compared");
  const left = col(alias, field.column);
  switch (op) {
    case "equals":
      return raw === null
        ? { kind: "isNull", expr: left, negated: false }
        : { kind: "compare", op: "=", left, right: param(ctx, field, raw) };
    case "not": {
      if (raw === null) return { kind: "isNull", expr: left, negated: true };
      const differs: SqlExpr = { kind: "compare", op: "<>", left, right: param(ctx, field, raw) };
      // SQL <> drops NULL rows; Prisma's `not` keeps them.
      return field.nullable ? { kind: "or", items: [differs, { kind: "isNull", expr: left, negated: false }] } : differs;
    }
    case "in":
    case "notIn": {
      if (!Array.isArray(raw)) return fail("Expected a list of values");
      const values = (raw as unknown[]).map((v) => ctx.dialect.encode(field, v));
      return { kind: "in", expr: left, values, negated: op === "notIn" };
    }
    case "lt":
      return { kind: "compare", op: "<", left, right: param(ctx, field, raw) };
    case "lte":
      return { kind: "compare", op: "<=", left, right: param(ctx, field, raw) };
    case "gt":
      return { kind: "compare", op: ">", left, right: param(ctx, field, raw) };
    case "gte":
      return { kind: "compare", op: ">=", left, right: param(ctx, field, raw) };
    case "contains":
    case "startsWith":
    case "endsWith":
      if (typeof raw !== "string") return fail("Expected a string");
      return { kind: "textMatch", mode: op, expr: left, value: raw };
    default:
      return fail("Unknown filter operator");
  }
}

/** Equality between the parent row (`parentAlias`) and the related row (`childAlias`). */
function joinCondition(
  ctx: BuildContext,
  parent: ModelIndex,
  parentAlias: string,
  relation: RelationField,
  child: ModelIndex,
  childAlias: string,
): SqlExpr {
  const items: SqlExpr[] = [];
  // The owning side holds `fields` (local FK columns) and `references` (columns on the other model).
  const owned = relation.fields.length > 0;
  const owning = owned ? relation : oppositeRelation(ctx.index, parent.ir.name, relation).field;
  owning.fields.forEach((f, i) => {
    const ref = owning.references[i] ?? fail("Relation is missing a reference");
    const childColumn = owned ? columnOf(child, ref) : columnOf(child, f);
    const parentColumn = owned ? columnOf(parent, f) : columnOf(parent, ref);
    items.push({ kind: "compare", op: "=", left: col(childAlias, childColumn), right: col(parentAlias, parentColumn) });
  });
  return { kind: "and", items };
}

function existsQuery(child: ModelIndex, alias: string, where: SqlExpr): SelectQuery {
  return { kind: "select", table: child.ir.table, alias, columns: [], where, orderBy: [] };
}

function relationFilter(
  ctx: BuildContext,
  model: ModelIndex,
  alias: string,
  field: RelationField,
  op: "some" | "none" | "every" | "is" | "isNot",
  filter: FilterNode | null,
): SqlExpr {
  const child = modelOf(ctx, field.target);
  const only = field.fields[0];
  if (filter === null && field.fields.length === 1 && only !== undefined) {
    // `is: null` / `isNot: null` where the foreign key lives on this model.
    return { kind: "isNull", expr: col(alias, columnOf(model, only)), negated: op === "isNot" };
  }
  const childAlias = ctx.nextAlias();
  const join = joinCondition(ctx, model, alias, field, child, childAlias);
  const items: SqlExpr[] = [join];
  if (filter !== null) {
    const inner = buildFilter(ctx, child.ir.name, childAlias, filter);
    // An empty AND is "true": it adds nothing to some / none / is / isNot.
    const trivial = inner.kind === "and" && inner.items.length === 0;
    if (op === "every") {
      // A child violates `every` when the filter is false or NULL (three-valued logic); an empty filter never is.
      items.push(
        trivial
          ? { kind: "false" }
          : { kind: "or", items: [{ kind: "not", expr: inner }, { kind: "isNull", expr: inner, negated: false }] },
      );
    } else if (!trivial) items.push(inner);
  }
  const negated = op === "none" || op === "every" || op === "isNot" || (filter === null && op === "is");
  return { kind: "exists", query: existsQuery(child, childAlias, { kind: "and", items }), negated };
}

export function buildFilter(ctx: BuildContext, model: string, alias: string, node: FilterNode): SqlExpr {
  const target = modelOf(ctx, model);
  switch (node.kind) {
    case "and":
    case "or":
      return { kind: node.kind, items: node.items.map((i) => buildFilter(ctx, model, alias, i)) };
    case "not":
      return { kind: "not", expr: buildFilter(ctx, model, alias, node.item) };
    case "field":
      return scalarFilter(ctx, alias, fieldOf(target, node.field), node.op, node.value);
    case "relation": {
      const field = fieldOf(target, node.field);
      if (field.kind !== "relation") return fail("Not a relation field");
      return relationFilter(ctx, target, alias, field, node.op, node.filter);
    }
  }
}

// ------------------------------------------------------------------ selects

/** `as` is the field name, `column` the database column. */
export function selectedColumns(
  ctx: BuildContext,
  model: string,
  select?: readonly string[],
  extra?: readonly string[],
): { column: string; as: string }[] {
  const target = modelOf(ctx, model);
  const names: string[] = [];
  if (select === undefined) {
    for (const f of target.ir.fields) if (f.kind !== "relation") names.push(f.name);
  } else {
    names.push(...select);
  }
  for (const name of extra ?? []) if (!names.includes(name)) names.push(name);
  return names.map((name) => ({ column: columnOf(target, name), as: name }));
}

function orderColumns(target: ModelIndex, items: readonly OrderByItem[]): SelectQuery["orderBy"] {
  return items.map((o) => ({ column: columnOf(target, o.field), direction: o.direction === "desc" ? "DESC" : "ASC" }));
}

export function buildFind(
  ctx: BuildContext,
  model: string,
  args: ValidatedFind,
  mode: "many" | "first" | "unique",
  extraColumns?: readonly string[],
): SelectQuery {
  const target = modelOf(ctx, model);
  const alias = ctx.nextAlias();
  const query: SelectQuery = {
    kind: "select",
    table: target.ir.table,
    alias,
    columns: selectedColumns(ctx, model, args.select, extraColumns),
    orderBy: orderColumns(target, args.orderBy),
  };
  if (args.where !== undefined) query.where = buildFilter(ctx, model, alias, args.where);
  // Unbounded reads fetch one row past maxRows so the client can detect the overflow.
  query.limit = mode === "many" ? (args.take ?? ctx.limits.maxRows + 1) : 1;
  if (args.skip !== undefined) query.offset = args.skip;
  return query;
}

/**
 * Plain `COUNT(*)` over the filter. `take` / `skip` / `orderBy` are deliberately not applied (the AST has no
 * sub-select to bound a COUNT): the client passes the result through `applyCountWindow`.
 */
export function buildCount(ctx: BuildContext, model: string, args: ValidatedFind): SelectQuery {
  const target = modelOf(ctx, model);
  const alias = ctx.nextAlias();
  const query: SelectQuery = { kind: "select", table: target.ir.table, alias, columns: "count", orderBy: [] };
  if (args.where !== undefined) query.where = buildFilter(ctx, model, alias, args.where);
  return query;
}

/** Applies count's `skip` then `take` window to the unbounded total returned by `buildCount`. */
export function applyCountWindow(total: number, args: { take?: number; skip?: number }): number {
  return Math.max(0, Math.min(total - (args.skip ?? 0), args.take ?? Infinity));
}
