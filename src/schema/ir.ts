export type ScalarType =
  | "Int"
  | "BigInt"
  | "Float"
  | "Decimal"
  | "String"
  | "Boolean"
  | "DateTime"
  | "Json"
  | "Bytes";

export type DefaultValue =
  | { kind: "autoincrement" }
  | { kind: "now" }
  | { kind: "uuid" }
  | { kind: "literal"; value: string | number | boolean };

export interface ScalarField {
  kind: "scalar";
  name: string;
  column: string;
  type: ScalarType;
  nullable: boolean;
  isId: boolean;
  isUnique: boolean;
  default?: DefaultValue;
  updatedAt: boolean;
}

export interface EnumField {
  kind: "enum";
  name: string;
  column: string;
  enumName: string;
  nullable: boolean;
  isUnique: boolean;
  default?: { kind: "literal"; value: string };
}

export type OnDelete = "Cascade" | "Restrict" | "SetNull";

/** `fields` / `references` are empty on the inverse side; `onDelete` is copied from the owning side there. */
export interface RelationField {
  kind: "relation";
  name: string;
  target: string;
  list: boolean;
  nullable: boolean;
  fields: string[];
  references: string[];
  onDelete: OnDelete;
}

export type FieldIR = ScalarField | EnumField | RelationField;

export interface ModelIR {
  name: string;
  delegate: string;
  table: string;
  fields: FieldIR[];
  primaryKey: string;
  uniques: string[][];
  indexes: string[][];
}

export interface EnumIR {
  name: string;
  values: string[];
}

/** Plain JSON-serialisable schema description: no Maps or class instances. */
export interface SchemaIR {
  provider: "sqlite" | "postgresql";
  urlEnv: string;
  models: ModelIR[];
  enums: EnumIR[];
}

export interface ModelIndex {
  ir: ModelIR;
  fields: ReadonlyMap<string, FieldIR>;
  /** Column name to field, scalar and enum fields only. */
  byColumn: ReadonlyMap<string, FieldIR>;
}

export interface SchemaIndex {
  ir: SchemaIR;
  models: ReadonlyMap<string, ModelIndex>;
  byDelegate: ReadonlyMap<string, ModelIndex>;
  byTable: ReadonlyMap<string, ModelIndex>;
  enums: ReadonlyMap<string, EnumIR>;
}

/** Builds Map-based lookups so user-controlled keys can never hit prototype properties. */
export function indexSchema(ir: SchemaIR): SchemaIndex {
  const models = new Map<string, ModelIndex>();
  const byDelegate = new Map<string, ModelIndex>();
  const byTable = new Map<string, ModelIndex>();
  for (const model of ir.models) {
    const fields = new Map<string, FieldIR>();
    const byColumn = new Map<string, FieldIR>();
    for (const field of model.fields) {
      fields.set(field.name, field);
      if (field.kind !== "relation") byColumn.set(field.column, field);
    }
    const entry: ModelIndex = { ir: model, fields, byColumn };
    models.set(model.name, entry);
    byDelegate.set(model.delegate, entry);
    byTable.set(model.table, entry);
  }
  const enums = new Map<string, EnumIR>();
  for (const e of ir.enums) enums.set(e.name, e);
  return { ir, models, byDelegate, byTable, enums };
}

/** Returns the relation field on the target model that points back at `model`. */
export function oppositeRelation(
  index: SchemaIndex,
  model: string,
  field: RelationField,
): { model: ModelIndex; field: RelationField } {
  const target = index.models.get(field.target);
  if (target !== undefined) {
    for (const candidate of target.ir.fields) {
      if (candidate.kind === "relation" && candidate.target === model) return { model: target, field: candidate };
    }
  }
  throw new Error("Relation has no opposite side");
}
