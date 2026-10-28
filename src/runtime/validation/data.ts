import type { ModelIndex, RelationField } from "../../schema/ir.js";
import { own } from "../../own.js";
import { type Ctx, model, parseUniqueWhere } from "./filters.js";
import { fail, join, readObject } from "./plain.js";
import { validateScalar } from "./scalars.js";
import type { FilterNode, ValidatedData } from "./types.js";

export type DataMode = "create" | "createMany" | "update";

function parseConnect(ctx: Ctx, field: RelationField, value: unknown, path: string, mode: DataMode): FilterNode {
  if (field.list) return fail("Nested writes on to-many relations are not supported", path);
  if (field.fields.length === 0) return fail("Nested writes on this side of the relation are not supported", path);
  if (mode === "createMany") return fail("connect is not supported in createMany", path);
  const entries = readObject(value, path);
  for (const key of entries.keys()) {
    if (key !== "connect") fail(key === "create" ? "Nested create is not supported" : "Unknown relation write", join(path, key));
  }
  if (!entries.has("connect")) return fail("Relation write requires connect", path);
  const connectPath = join(path, "connect");
  return parseUniqueWhere(ctx, model(ctx, field.target), entries.get("connect"), connectPath);
}

/**
 * Validates `data` for a create (required fields enforced) or an update (all optional, at least one field).
 * An n-1 relation is set either through its foreign key or `{ connect: <unique> }`, never both.
 */
export function parseData(ctx: Ctx, target: ModelIndex, value: unknown, path: string, mode: DataMode): ValidatedData {
  const entries = readObject(value, path);
  const values = new Map<string, unknown>();
  const connects = new Map<string, FilterNode>();
  if (mode === "update" && entries.size === 0) fail("data must contain at least one field", path);

  for (const [key, entry] of entries) {
    const keyPath = join(path, key);
    const field = target.fields.get(key) ?? fail("Unknown field", keyPath);
    if (field.kind === "relation") {
      connects.set(key, parseConnect(ctx, field, entry, keyPath, mode));
      continue;
    }
    if (target.ir.primaryKey === key) {
      if (mode === "update") fail("The id cannot be modified", keyPath);
      if (field.kind === "scalar" && own(field, "default")?.kind === "autoincrement") fail("Autoincrement ids cannot be set", keyPath);
    }
    values.set(key, validateScalar(ctx.index, field, entry, keyPath, ctx.limits));
  }

  const coveredByConnect = new Set<string>();
  for (const name of connects.keys()) {
    const relation = target.fields.get(name);
    if (relation?.kind !== "relation") continue;
    for (const fk of relation.fields) {
      if (values.has(fk)) fail("Provide either the foreign key or connect, not both", join(path, name));
      coveredByConnect.add(fk);
    }
  }
  if (mode === "update") return { values, connects };

  for (const field of target.ir.fields) {
    if (field.kind === "relation" || values.has(field.name) || coveredByConnect.has(field.name)) continue;
    const optional = field.nullable || own(field, "default") !== undefined || (field.kind === "scalar" && field.updatedAt);
    if (optional) continue;
    const owner = target.ir.fields.find((f) => f.kind === "relation" && f.fields.includes(field.name));
    if (owner !== undefined) fail("Missing required relation (provide its foreign key or connect)", join(path, owner.name));
    fail("Missing required field", join(path, field.name));
  }
  return { values, connects };
}
