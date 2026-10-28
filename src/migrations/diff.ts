import { isDeepStrictEqual } from "node:util";
import type { FieldIR, ModelIR, SchemaIR } from "../schema/ir.js";

export type SchemaDiff =
  | { kind: "none" }
  | { kind: "additive"; newModels: string[] }
  | { kind: "unsupported"; reasons: string[] };

/** An inverse list relation has no column, so adding one to an existing model needs no DDL. */
function isInverseList(field: FieldIR): boolean {
  return field.kind === "relation" && field.list && field.fields.length === 0;
}

/**
 * Compares two schemas. A change is additive when every existing model is unchanged, apart from
 * inverse list relations pointing to new models, and no existing enum changed.
 */
export function diffSchemas(previous: SchemaIR | null, next: SchemaIR): SchemaDiff {
  if (previous === null) {
    return next.models.length === 0
      ? { kind: "none" }
      : { kind: "additive", newModels: next.models.map((m) => m.name) };
  }

  const before = new Map<string, ModelIR>(previous.models.map((m) => [m.name, m]));
  const after = new Map<string, ModelIR>(next.models.map((m) => [m.name, m]));
  const newModels = next.models.filter((m) => !before.has(m.name)).map((m) => m.name);
  const created = new Set(newModels);
  const reasons: string[] = [];

  if (previous.provider !== next.provider) reasons.push("The provider changed");

  for (const [name, old] of before) {
    const current = after.get(name);
    if (current === undefined) {
      reasons.push(`Model ${name} was removed`);
      continue;
    }
    const oldFields = new Set(old.fields.map((f) => f.name));
    const comparable: ModelIR = {
      ...current,
      fields: current.fields.filter(
        (f) => oldFields.has(f.name) || !(isInverseList(f) && f.kind === "relation" && created.has(f.target)),
      ),
    };
    if (!isDeepStrictEqual(old, comparable)) reasons.push(`Model ${name} was changed`);
  }

  const nextEnums = new Map(next.enums.map((e) => [e.name, e]));
  for (const old of previous.enums) {
    const current = nextEnums.get(old.name);
    if (current === undefined || !isDeepStrictEqual(old, current)) reasons.push(`Enum ${old.name} was changed or removed`);
  }

  if (reasons.length > 0) return { kind: "unsupported", reasons };
  return newModels.length === 0 ? { kind: "none" } : { kind: "additive", newModels };
}
