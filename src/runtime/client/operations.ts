import { randomUUID } from "node:crypto";
import type { Queryable } from "../../adapters/adapter.js";
import type { SqlQuery } from "../../dialects/sql-ast.js";
import { DatabaseError, LimitExceededError, NotFoundError, OrmError } from "../../errors.js";
import type { ModelIndex } from "../../schema/ir.js";
import { shapeFields, shapeRows } from "../include.js";
import {
  applyCountWindow,
  buildCount,
  buildDelete,
  buildFind,
  buildInsert,
  buildUpdate,
  resolvedConnectColumns,
  type WriteEnv,
} from "../query-builder.js";
import { validateArgs, type FilterNode, type IncludeNode, type Operation, type ValidatedData, type ValidatedFind } from "../validation.js";
import { buildContext, type Engine, fetchRows, modelOf, type Row, type Scope } from "./engine.js";

export const OPERATIONS: readonly Operation[] = [
  "findMany",
  "findFirst",
  "findUnique",
  "count",
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
];

interface Shape {
  select?: string[];
  include: IncludeNode[];
}

function writeEnv(): WriteEnv {
  return { now: new Date(), uuid: randomUUID };
}

function single(rows: readonly Row[]): Row {
  const [row] = rows;
  if (row === undefined) throw new DatabaseError();
  return row;
}

async function read(engine: Engine, q: Queryable, model: ModelIndex, find: ValidatedFind, mode: "many" | "first" | "unique"): Promise<Row[]> {
  const fields = shapeFields(engine, model, find);
  const query = buildFind(buildContext(engine), model.ir.name, { ...find, select: fields }, mode);
  const rows = await fetchRows(engine, q, query, model, fields);
  if (rows.length > engine.limits.maxRows) throw new LimitExceededError("maxRows", "take");
  return shapeRows(engine, q, model, rows, find);
}

function exists(engine: Engine, q: Queryable, model: ModelIndex, where: FilterNode): Promise<Row[]> {
  const pk = [model.ir.primaryKey];
  const query = buildFind(buildContext(engine), model.ir.name, { where, select: pk, include: [], orderBy: [] }, "unique");
  return fetchRows(engine, q, query, model, pk);
}

/** Replaces every `connect` by the foreign-key values read from the target row (on the same connection). */
async function resolveConnects(engine: Engine, q: Queryable, model: ModelIndex, data: ValidatedData): Promise<ValidatedData> {
  const connects = resolvedConnectColumns(buildContext(engine), model.ir.name, data);
  if (connects.size === 0) return data;
  const values = new Map(data.values);
  for (const [name, where] of connects) {
    const relation = model.fields.get(name);
    if (relation?.kind !== "relation") throw new OrmError("VALIDATION", "Cannot connect this relation");
    const target = modelOf(engine, relation.target);
    const refs = relation.references;
    const query = buildFind(buildContext(engine), target.ir.name, { where, select: refs, include: [], orderBy: [] }, "unique");
    const [found] = await fetchRows(engine, q, query, target, refs);
    if (found === undefined) throw new NotFoundError(target.ir.name);
    relation.fields.forEach((fk, i) => {
      const ref = refs[i];
      if (ref !== undefined) values.set(fk, found[ref]);
    });
  }
  return { values, connects: new Map() };
}

async function create(engine: Engine, q: Queryable, model: ModelIndex, data: ValidatedData, shape: Shape): Promise<Row> {
  const resolved = await resolveConnects(engine, q, model, data);
  const fields = shapeFields(engine, model, shape);
  const query = buildInsert(buildContext(engine), model.ir.name, [resolved], writeEnv(), fields);
  const rows = await fetchRows(engine, q, query, model, fields);
  return single(await shapeRows(engine, q, model, rows, shape));
}

async function update(
  engine: Engine,
  q: Queryable,
  model: ModelIndex,
  where: FilterNode,
  data: ValidatedData,
  shape: Shape,
): Promise<Row> {
  const resolved = await resolveConnects(engine, q, model, data);
  const fields = shapeFields(engine, model, shape);
  const query = buildUpdate(buildContext(engine), model.ir.name, where, resolved, writeEnv(), fields);
  const rows = await fetchRows(engine, q, query, model, fields);
  if (rows.length === 0) throw new NotFoundError(model.ir.name);
  return single(await shapeRows(engine, q, model, rows, shape));
}

async function remove(engine: Engine, q: Queryable, model: ModelIndex, where: FilterNode, shape: Shape): Promise<Row> {
  if (shape.include.length > 0) {
    // Relations are read before the row (and any cascaded children) disappear.
    const [found] = await read(engine, q, model, { ...shape, where, orderBy: [] }, "unique");
    if (found === undefined) throw new NotFoundError(model.ir.name);
    await q.execute(engine.dialect.compile(buildDelete(buildContext(engine), model.ir.name, where, [])));
    return found;
  }
  const fields = shapeFields(engine, model, shape);
  const rows = await fetchRows(engine, q, buildDelete(buildContext(engine), model.ir.name, where, fields), model, fields);
  if (rows.length === 0) throw new NotFoundError(model.ir.name);
  return single(await shapeRows(engine, q, model, rows, shape));
}

async function count(engine: Engine, q: Queryable, model: ModelIndex, find: ValidatedFind): Promise<number> {
  const [row] = await q.query(engine.dialect.compile(buildCount(buildContext(engine), model.ir.name, find)));
  const raw = row?.count;
  const total = typeof raw === "bigint" ? Number(raw) : raw;
  if (typeof total !== "number" || !Number.isSafeInteger(total)) throw new DatabaseError();
  return applyCountWindow(total, find);
}

async function changes(engine: Engine, q: Queryable, query: SqlQuery): Promise<{ count: number }> {
  const { changes: n } = await q.execute(engine.dialect.compile(query));
  return { count: n };
}

/** Validates, builds, runs and decodes one delegate call. Multi-step calls run atomically through `scope.atomic`. */
export async function runOperation(engine: Engine, model: ModelIndex, op: Operation, scope: Scope, args: unknown): Promise<unknown> {
  scope.assertActive();
  const v = validateArgs(engine.index, model.ir.name, op, args ?? {}, engine.limits);
  const { q } = scope;
  switch (v.op) {
    case "findMany":
      return read(engine, q, model, v, "many");
    case "findFirst":
      return (await read(engine, q, model, v, "first"))[0] ?? null;
    case "findUnique":
      return (await read(engine, q, model, v, "unique"))[0] ?? null;
    case "count":
      return count(engine, q, model, v);
    case "create":
      return v.data.connects.size > 0 || v.include.length > 0
        ? scope.atomic((tx) => create(engine, tx, model, v.data, v))
        : create(engine, q, model, v.data, v);
    case "createMany":
      return changes(engine, q, buildInsert(buildContext(engine), model.ir.name, v.data, writeEnv(), []));
    case "update":
      return v.data.connects.size > 0 || v.include.length > 0
        ? scope.atomic((tx) => update(engine, tx, model, v.where, v.data, v))
        : update(engine, q, model, v.where, v.data, v);
    case "updateMany": {
      const run = async (tx: Queryable): Promise<{ count: number }> => {
        const data = await resolveConnects(engine, tx, model, v.data);
        return changes(engine, tx, buildUpdate(buildContext(engine), model.ir.name, v.where, data, writeEnv(), []));
      };
      return v.data.connects.size > 0 ? scope.atomic(run) : run(q);
    }
    case "upsert":
      return scope.atomic(async (tx) =>
        (await exists(engine, tx, model, v.where)).length > 0
          ? update(engine, tx, model, v.where, v.update, v)
          : create(engine, tx, model, v.create, v),
      );
    case "delete":
      return v.include.length > 0 ? scope.atomic((tx) => remove(engine, tx, model, v.where, v)) : remove(engine, q, model, v.where, v);
    case "deleteMany":
      return changes(engine, q, buildDelete(buildContext(engine), model.ir.name, v.where, []));
  }
}
