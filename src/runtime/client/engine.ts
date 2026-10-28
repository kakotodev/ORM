import type { Queryable } from "../../adapters/adapter.js";
import type { Dialect } from "../../dialects/dialect.js";
import type { SqlQuery } from "../../dialects/sql-ast.js";
import { OrmError } from "../../errors.js";
import type { ModelIndex, SchemaIndex } from "../../schema/ir.js";
import type { RuntimeLimits } from "../limits.js";
import { createBuildContext, type BuildContext } from "../query-builder.js";
import type { IncludeNode } from "../validation.js";

/** A decoded record keyed by field name (never a raw driver row). */
export type Row = Record<string, unknown>;

/** Everything a client call needs besides the connection. */
export interface Engine {
  readonly index: SchemaIndex;
  readonly dialect: Dialect;
  readonly limits: RuntimeLimits;
  readonly debug: boolean;
}

/** Where a call runs: on the adapter itself, or on the Queryable of an open transaction. */
export interface Scope {
  readonly q: Queryable;
  /** Runs `fn` atomically: in a new transaction at top level, directly on `q` inside a transaction. */
  atomic<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Throws once this scope can no longer be used. */
  assertActive(): void;
}

/** A fresh build context: aliases restart for every statement. */
export function buildContext(engine: Engine): BuildContext {
  return createBuildContext(engine.index, engine.dialect, engine.limits);
}

function corrupt(): never {
  throw new OrmError("DATABASE", "Stored value could not be decoded");
}

export function modelOf(engine: Engine, name: string): ModelIndex {
  return engine.index.models.get(name) ?? corrupt();
}

export function scalarNames(model: ModelIndex): string[] {
  const out: string[] = [];
  for (const f of model.ir.fields) if (f.kind !== "relation") out.push(f.name);
  return out;
}

/** `base` followed by the names of `extra` it does not already contain. */
export function union(base: readonly string[], extra: readonly string[]): string[] {
  const out = [...base];
  for (const name of extra) if (!out.includes(name)) out.push(name);
  return out;
}

/** Builds a plain object holding only the listed schema fields, each decoded by the dialect. */
export function decodeRow(engine: Engine, model: ModelIndex, raw: Record<string, unknown>, fields: readonly string[]): Row {
  const out: Row = {};
  for (const name of fields) {
    const field = model.fields.get(name);
    if (field === undefined || !Object.hasOwn(raw, name)) return corrupt();
    out[name] = engine.dialect.decode(field, raw[name]);
  }
  return out;
}

/** Compiles and runs `query` on `q`, decoding the returned `fields` of every row. */
export async function fetchRows(
  engine: Engine,
  q: Queryable,
  query: SqlQuery,
  model: ModelIndex,
  fields: readonly string[],
): Promise<Row[]> {
  const rows = await q.query(engine.dialect.compile(query));
  return rows.map((raw) => decodeRow(engine, model, raw, fields));
}

/** The shaped result: selected (or all scalar) fields, then the included relations. Drops helper columns. */
export function project(row: Row, fields: readonly string[], include: readonly IncludeNode[]): Row {
  const out: Row = {};
  for (const name of fields) out[name] = row[name];
  for (const node of include) out[node.relation] = row[node.relation];
  return out;
}
