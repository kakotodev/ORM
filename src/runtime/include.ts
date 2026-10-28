import type { Queryable } from "../adapters/adapter.js";
import { LimitExceededError, OrmError } from "../errors.js";
import type { ModelIndex } from "../schema/ir.js";
import { oppositeRelation } from "../schema/ir.js";
import { buildContext, type Engine, fetchRows, modelOf, project, type Row, scalarNames, union } from "./client/engine.js";
import { buildFind } from "./query-builder.js";
import type { FilterNode, IncludeNode } from "./validation.js";
import { own } from "../own.js";

/** How parent rows match related rows: `parentFields[i]` on the parent equals `childFields[i]` on the child. */
interface Link {
  child: ModelIndex;
  parentFields: readonly string[];
  childFields: readonly string[];
  list: boolean;
}

function linkOf(engine: Engine, parent: ModelIndex, relationName: string): Link {
  const relation = parent.fields.get(relationName);
  if (relation?.kind !== "relation") throw new OrmError("VALIDATION", "Only relations can be included");
  const child = modelOf(engine, relation.target);
  if (relation.fields.length > 0) {
    // n-1: this model holds the foreign key.
    return { child, parentFields: relation.fields, childFields: relation.references, list: false };
  }
  const owning = oppositeRelation(engine.index, parent.ir.name, relation).field;
  return { child, parentFields: owning.references, childFields: owning.fields, list: relation.list };
}

/** Parent fields that must be read so the given includes can be matched. */
export function joinFields(engine: Engine, model: ModelIndex, include: readonly IncludeNode[]): string[] {
  let out: string[] = [];
  for (const node of include) out = union(out, linkOf(engine, model, node.relation).parentFields);
  return out;
}

/** The fields to read for a shape: selected (or all scalar) fields plus the join fields of its includes. */
export function shapeFields(engine: Engine, model: ModelIndex, shape: { select?: string[]; include: IncludeNode[] }): string[] {
  return union(own(shape, "select") ?? scalarNames(model), joinFields(engine, model, shape.include));
}

/** Loads the includes onto rows read with `shapeFields`, then drops the helper columns. */
export async function shapeRows(
  engine: Engine,
  q: Queryable,
  model: ModelIndex,
  rows: Row[],
  shape: { select?: string[]; include: IncludeNode[] },
): Promise<Row[]> {
  await loadIncludes(engine, q, model, rows, shape.include);
  const fields = own(shape, "select") ?? scalarNames(model);
  return rows.map((row) => project(row, fields, shape.include));
}

function keyPart(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return String(value);
}

/** A stable map key for the tuple of `fields`, or undefined when any of them is NULL. */
function keyOf(row: Row, fields: readonly string[]): string | undefined {
  const parts: string[] = [];
  for (const name of fields) {
    const value = row[name];
    if (value === null || value === undefined) return undefined;
    parts.push(keyPart(value));
  }
  return JSON.stringify(parts);
}

function keyFilter(fields: readonly string[], tuples: readonly unknown[][]): FilterNode {
  const [only] = fields;
  if (fields.length === 1 && only !== undefined) {
    return { kind: "field", field: only, op: "in", value: tuples.map((t) => t[0]) };
  }
  return {
    kind: "or",
    items: tuples.map((t) => ({
      kind: "and",
      items: fields.map((field, i): FilterNode => ({ kind: "field", field, op: "equals", value: t[i] })),
    })),
  };
}

async function loadRelation(engine: Engine, q: Queryable, parent: ModelIndex, rows: Row[], node: IncludeNode): Promise<void> {
  const link = linkOf(engine, parent, node.relation);
  const keys = new Map<string, unknown[]>();
  for (const row of rows) {
    const key = keyOf(row, link.parentFields);
    if (key !== undefined && !keys.has(key)) keys.set(key, link.parentFields.map((f) => row[f]));
  }

  const fields = union(shapeFields(engine, link.child, node), link.childFields);
  const tuples = [...keys.values()];
  const batchSize = Math.ceil(engine.limits.maxInListSize / 2);
  const children: Row[] = [];
  for (let i = 0; i < tuples.length; i += batchSize) {
    const byKey = keyFilter(link.childFields, tuples.slice(i, i + batchSize));
    const nodeWhere = own(node, "where");
    const where: FilterNode = nodeWhere === undefined ? byKey : { kind: "and", items: [byKey, nodeWhere] };
    const query = buildFind(buildContext(engine), link.child.ir.name, { where, select: fields, include: [], orderBy: node.orderBy }, "many");
    children.push(...(await fetchRows(engine, q, query, link.child, fields)));
    if (children.length > engine.limits.maxRows) throw new LimitExceededError("maxRows", `include.${node.relation}`);
  }

  await loadIncludes(engine, q, link.child, children, node.include);
  const selected = own(node, "select") ?? scalarNames(link.child);
  const groups = new Map<string, Row[]>();
  for (const child of children) {
    const key = keyOf(child, link.childFields);
    if (key === undefined) continue;
    const group = groups.get(key);
    const shaped = project(child, selected, node.include);
    if (group === undefined) groups.set(key, [shaped]);
    else group.push(shaped);
  }
  for (const row of rows) {
    const key = keyOf(row, link.parentFields);
    const group = (key === undefined ? undefined : groups.get(key)) ?? [];
    row[node.relation] = link.list ? group : (group[0] ?? null);
  }
}

/**
 * Attaches every included relation to `rows` (decoded records holding the join fields): one query per level
 * and batch of ceil(maxInListSize / 2) keys, related rows grouped back onto their parents.
 */
export async function loadIncludes(
  engine: Engine,
  q: Queryable,
  model: ModelIndex,
  rows: Row[],
  include: readonly IncludeNode[],
): Promise<void> {
  for (const node of include) await loadRelation(engine, q, model, rows, node);
}
