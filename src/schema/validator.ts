import { SchemaError, type SchemaDiagnostic } from "../errors.js";
import type { AttributeNode, BlockNode, Expr, FieldNode, Pos, SchemaAst } from "./ast.js";
import type {
  DefaultValue,
  EnumField,
  EnumIR,
  FieldIR,
  ModelIR,
  OnDelete,
  RelationField,
  ScalarField,
  ScalarType,
  SchemaIR,
} from "./ir.js";
import { DEFAULT_SCHEMA_LIMITS } from "./limits.js";

type Report = (message: string, pos: Pos) => void;
type ModelNode = Extract<BlockNode, { kind: "model" }>;
type EnumNode = Extract<BlockNode, { kind: "enum" }>;
type DatasourceNode = Extract<BlockNode, { kind: "datasource" | "generator" }>;

const SCALAR_TYPES: ReadonlySet<string> = new Set<ScalarType>([
  "Int",
  "BigInt",
  "Float",
  "Decimal",
  "String",
  "Boolean",
  "DateTime",
  "Json",
  "Bytes",
]);
const ID_TYPES: ReadonlySet<string> = new Set(["Int", "BigInt", "String"]);
const UNINDEXABLE_TYPES: ReadonlySet<string> = new Set(["Json", "Bytes"]);
const PROVIDERS: ReadonlySet<string> = new Set(["sqlite", "postgresql"]);
const ON_DELETE: ReadonlySet<string> = new Set<OnDelete>(["Cascade", "Restrict", "SetNull"]);
const FORBIDDEN_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DECIMAL_LITERAL = /^-?\d+$|^-?\d+\.\d+$/;

const SCALAR_FIELD_ATTRIBUTES: ReadonlySet<string> = new Set(["id", "unique", "default", "map", "updatedAt"]);
const ENUM_FIELD_ATTRIBUTES: ReadonlySet<string> = new Set(["unique", "default", "map"]);
const RELATION_FIELD_ATTRIBUTES: ReadonlySet<string> = new Set(["relation"]);
const MODEL_ATTRIBUTES: ReadonlySet<string> = new Set(["map", "unique", "index", "id"]);

/** Returns why an identifier is unusable, without echoing it, or undefined when it is fine. */
function identifierProblem(name: string): string | undefined {
  if (name.length > DEFAULT_SCHEMA_LIMITS.maxIdentifierLength) return "is too long";
  if (!IDENTIFIER.test(name)) return "has invalid characters";
  if (FORBIDDEN_NAMES.has(name) || name.startsWith("_mini_orm")) return "is reserved";
  return undefined;
}

/** A name that is safe to put in a message: only identifiers that passed validation are echoed. */
function show(name: string): string {
  return identifierProblem(name) === undefined ? name : "(invalid name)";
}

function checkIdentifier(name: string, what: string, pos: Pos, report: Report): boolean {
  const problem = identifierProblem(name);
  if (problem === undefined) return true;
  report(`Invalid ${what}: it ${problem}`, pos);
  return false;
}

function lowerFirst(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** Collects attributes by name, reporting unknown, disallowed and duplicate ones. */
function collectAttributes(
  attributes: readonly AttributeNode[],
  allowed: ReadonlySet<string>,
  report: Report,
): Map<string, AttributeNode> {
  const found = new Map<string, AttributeNode>();
  for (const attr of attributes) {
    if (!allowed.has(attr.name)) {
      report(`Attribute ${show(attr.name)} is not allowed here`, attr.pos);
    } else if (found.has(attr.name)) {
      report(`Duplicate attribute ${show(attr.name)}`, attr.pos);
    } else {
      found.set(attr.name, attr);
    }
  }
  return found;
}

/** Returns the single positional argument of an attribute, or reports why there is not exactly one. */
function singleArg(attr: AttributeNode, report: Report): Expr | undefined {
  const first = attr.args[0];
  if (attr.args.length !== 1 || first === undefined || first.name !== undefined) {
    report(`Attribute ${show(attr.name)} expects exactly one argument`, attr.pos);
    return undefined;
  }
  return first.value;
}

function mappedName(attr: AttributeNode, what: string, report: Report): string | undefined {
  const arg = singleArg(attr, report);
  if (arg === undefined) return undefined;
  if (arg.kind !== "string") {
    report(`Attribute ${show(attr.name)} expects a string`, arg.pos);
    return undefined;
  }
  return checkIdentifier(arg.value, what, arg.pos, report) ? arg.value : undefined;
}

/** Reads `[a, b]` as a list of identifiers; reports and returns undefined otherwise. */
function identList(expr: Expr, report: Report): string[] | undefined {
  if (expr.kind !== "array") {
    report("Expected a list of field names", expr.pos);
    return undefined;
  }
  const names: string[] = [];
  for (const item of expr.items) {
    if (item.kind !== "ident") {
      report("Expected a list of field names", item.pos);
      return undefined;
    }
    names.push(item.name);
  }
  if (names.length === 0) {
    report("Field list must not be empty", expr.pos);
    return undefined;
  }
  return names;
}

interface DatasourceInfo {
  provider: "sqlite" | "postgresql";
  urlEnv: string;
}

function validateDatasource(node: DatasourceNode, report: Report): DatasourceInfo | undefined {
  let provider: DatasourceInfo["provider"] | undefined;
  let urlEnv: string | undefined;
  const seen = new Set<string>();
  for (const prop of node.properties) {
    if (seen.has(prop.key)) {
      report(`Duplicate datasource property ${show(prop.key)}`, prop.pos);
      continue;
    }
    seen.add(prop.key);
    if (prop.key === "provider") {
      if (prop.value.kind === "string" && PROVIDERS.has(prop.value.value)) {
        provider = prop.value.value as DatasourceInfo["provider"];
      } else {
        report('Datasource provider must be "sqlite" or "postgresql"', prop.value.pos);
      }
    } else if (prop.key === "url") {
      const v = prop.value;
      const first = v.kind === "call" ? v.args[0] : undefined;
      if (v.kind === "call" && v.name === "env" && v.args.length === 1 && first?.kind === "string") {
        if (checkIdentifier(first.value, "environment variable name", first.pos, report)) urlEnv = first.value;
      } else {
        report('Datasource url must use env("NAME"); literal urls are not allowed', v.pos);
      }
    } else {
      report(`Unknown datasource property ${show(prop.key)}`, prop.pos);
    }
  }
  if (provider === undefined && !seen.has("provider")) report("Datasource is missing a provider", node.pos);
  if (urlEnv === undefined && !seen.has("url")) report("Datasource is missing a url", node.pos);
  return provider !== undefined && urlEnv !== undefined ? { provider, urlEnv } : undefined;
}

function validateEnum(node: EnumNode, report: Report): EnumIR {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const v of node.values) {
    if (!checkIdentifier(v.name, "enum value", v.pos, report)) continue;
    if (seen.has(v.name)) {
      report(`Duplicate enum value ${v.name}`, v.pos);
      continue;
    }
    seen.add(v.name);
    values.push(v.name);
  }
  if (node.values.length === 0) report("Enum must have at least one value", node.pos);
  return { name: node.name, values };
}

/** Per-model working state shared by the validation passes. */
interface ModelDraft {
  node: ModelNode;
  ir: ModelIR;
  fields: Map<string, FieldIR>;
}

interface RelationDraft {
  model: ModelDraft;
  node: FieldNode;
  field: RelationField;
  attribute: AttributeNode | undefined;
}

interface Context {
  report: Report;
  enums: ReadonlyMap<string, EnumIR>;
  modelNames: ReadonlySet<string>;
  relations: RelationDraft[];
}

function parseDefault(
  attr: AttributeNode,
  field: { type: ScalarType | undefined; enumName: string | undefined; isId: boolean },
  ctx: Context,
): DefaultValue | undefined {
  const { report } = ctx;
  const arg = singleArg(attr, report);
  if (arg === undefined) return undefined;
  const bad = (message: string): DefaultValue | undefined => {
    report(message, arg.pos);
    return undefined;
  };
  const { type, enumName } = field;

  switch (arg.kind) {
    case "call": {
      if (arg.args.length !== 0) return bad("Default function takes no arguments");
      if (arg.name === "autoincrement") {
        return type === "Int" && field.isId ? { kind: "autoincrement" } : bad("autoincrement() is only allowed on an Int @id");
      }
      if (arg.name === "now") return type === "DateTime" ? { kind: "now" } : bad("now() is only allowed on DateTime");
      if (arg.name === "uuid") return type === "String" ? { kind: "uuid" } : bad("uuid() is only allowed on String");
      return bad("Unknown default function");
    }
    case "string": {
      if (arg.value.includes("\0")) return bad("String default must not contain NUL");
      if (type === "String") return { kind: "literal", value: arg.value };
      if (type === "Decimal" && DECIMAL_LITERAL.test(arg.value)) return { kind: "literal", value: arg.value };
      return bad("Default value does not match the field type");
    }
    case "number": {
      if (type === "Int" || type === "BigInt") {
        return Number.isSafeInteger(arg.value)
          ? { kind: "literal", value: arg.value }
          : bad("Integer default must be a safe integer");
      }
      if (type === "Float") {
        return Number.isFinite(arg.value) ? { kind: "literal", value: arg.value } : bad("Float default must be finite");
      }
      return bad("Default value does not match the field type");
    }
    case "ident": {
      if (type === "Boolean" && (arg.name === "true" || arg.name === "false")) {
        return { kind: "literal", value: arg.name === "true" };
      }
      if (enumName !== undefined) {
        const values = ctx.enums.get(enumName)?.values ?? [];
        return values.includes(arg.name) ? { kind: "literal", value: arg.name } : bad("Default is not a value of the enum");
      }
      return bad("Default value does not match the field type");
    }
    default:
      return bad("Default value does not match the field type");
  }
}

/** Builds the field IR for one non-relation field. Returns undefined when the type is unusable. */
function buildValueField(
  node: FieldNode,
  attrs: ReadonlyMap<string, AttributeNode>,
  ctx: Context,
): ScalarField | EnumField | undefined {
  const { report } = ctx;
  const isEnum = ctx.enums.has(node.type);
  const type = SCALAR_TYPES.has(node.type) ? (node.type as ScalarType) : undefined;
  if (node.list) report("Only relation fields can be lists", node.pos);

  const mapAttr = attrs.get("map");
  const column = (mapAttr !== undefined ? mappedName(mapAttr, "column name", report) : undefined) ?? node.name;
  const isUnique = attrs.has("unique");
  const idAttr = attrs.get("id");
  const isId = idAttr !== undefined;
  const defaultAttr = attrs.get("default");

  if (isUnique && type !== undefined && UNINDEXABLE_TYPES.has(type)) {
    report("Json and Bytes fields cannot be unique", attrs.get("unique")?.pos ?? node.pos);
  }
  if (idAttr !== undefined) {
    if (node.optional) report("An @id field cannot be optional", idAttr.pos);
    if (type === undefined || !ID_TYPES.has(type)) report("An @id field must be Int, BigInt or String", idAttr.pos);
  }

  if (isEnum) {
    const field: EnumField = {
      kind: "enum",
      name: node.name,
      column,
      enumName: node.type,
      nullable: node.optional,
      isUnique,
    };
    if (defaultAttr !== undefined) {
      const d = parseDefault(defaultAttr, { type: undefined, enumName: node.type, isId }, ctx);
      if (d?.kind === "literal" && typeof d.value === "string") field.default = { kind: "literal", value: d.value };
    }
    return field;
  }

  if (type === undefined) return undefined;
  const field: ScalarField = {
    kind: "scalar",
    name: node.name,
    column,
    type,
    nullable: node.optional,
    isId,
    isUnique,
    updatedAt: false,
  };
  if (defaultAttr !== undefined) {
    if (type === "Json" || type === "Bytes") {
      report("Json and Bytes fields cannot have a default", defaultAttr.pos);
    } else {
      const d = parseDefault(defaultAttr, { type, enumName: undefined, isId }, ctx);
      if (d !== undefined) field.default = d;
    }
  }
  const updatedAt = attrs.get("updatedAt");
  if (updatedAt !== undefined) {
    if (type === "DateTime") field.updatedAt = true;
    else report("@updatedAt is only allowed on DateTime", updatedAt.pos);
  }
  return field;
}

function buildFields(draft: ModelDraft, ctx: Context): void {
  const { report } = ctx;
  const columns = new Set<string>();
  let ids = 0;

  for (const node of draft.node.fields) {
    const nameOk = checkIdentifier(node.name, "field name", node.pos, report);
    if (draft.fields.has(node.name)) {
      report(`Duplicate field ${show(node.name)}`, node.pos);
      continue;
    }

    if (ctx.modelNames.has(node.type)) {
      const attrs = collectAttributes(node.attributes, RELATION_FIELD_ATTRIBUTES, report);
      if (node.list && node.optional) report("A list relation cannot be optional", node.pos);
      const field: RelationField = {
        kind: "relation",
        name: node.name,
        target: node.type,
        list: node.list,
        nullable: node.optional,
        fields: [],
        references: [],
        onDelete: node.optional ? "SetNull" : "Restrict",
      };
      draft.fields.set(node.name, field);
      draft.ir.fields.push(field);
      ctx.relations.push({ model: draft, node, field, attribute: attrs.get("relation") });
      continue;
    }

    const isEnum = ctx.enums.has(node.type);
    if (!isEnum && !SCALAR_TYPES.has(node.type)) {
      report(`Unknown type ${show(node.type)}`, node.pos);
      continue;
    }
    const attrs = collectAttributes(
      node.attributes,
      isEnum ? ENUM_FIELD_ATTRIBUTES : SCALAR_FIELD_ATTRIBUTES,
      report,
    );
    const field = buildValueField(node, attrs, ctx);
    if (field === undefined) continue;
    if (nameOk) {
      if (columns.has(field.column)) report(`Duplicate column ${show(field.column)}`, node.pos);
      columns.add(field.column);
    }
    if (field.kind === "scalar" && field.isId) {
      ids++;
      if (ids === 1) draft.ir.primaryKey = field.name;
    }
    if (field.isUnique) draft.ir.uniques.push([field.name]);
    draft.fields.set(node.name, field);
    draft.ir.fields.push(field);
  }

  if (ids === 0) report("Model must have exactly one @id field", draft.node.pos);
  else if (ids > 1) report("Model must have exactly one @id field, found several", draft.node.pos);
}

function buildModelAttributes(draft: ModelDraft, ctx: Context): void {
  const { report } = ctx;
  for (const attr of draft.node.attributes) {
    if (!MODEL_ATTRIBUTES.has(attr.name)) {
      report(`Attribute ${show(attr.name)} is not allowed here`, attr.pos);
      continue;
    }
    if (attr.name === "id") {
      report("Composite primary keys (@@id) are not supported", attr.pos);
    } else if (attr.name === "map") {
      const table = mappedName(attr, "table name", report);
      if (table !== undefined) draft.ir.table = table;
    } else {
      const first = attr.args[0];
      if (attr.args.length !== 1 || first === undefined || (first.name !== undefined && first.name !== "fields")) {
        report(`Attribute ${show(attr.name)} expects a list of fields`, attr.pos);
        continue;
      }
      const names = identList(first.value, report);
      if (names === undefined) continue;
      let ok = true;
      for (const name of names) {
        const field = draft.fields.get(name);
        if (field === undefined || field.kind === "relation") {
          report("Unknown scalar field in field list", first.value.pos);
          ok = false;
        } else if (field.kind === "scalar" && UNINDEXABLE_TYPES.has(field.type)) {
          report("Json and Bytes fields cannot be indexed", first.value.pos);
          ok = false;
        }
      }
      if (new Set(names).size !== names.length) {
        report("Field list contains duplicates", first.value.pos);
        ok = false;
      }
      if (ok) (attr.name === "unique" ? draft.ir.uniques : draft.ir.indexes).push(names);
    }
  }
}

/** True when `names` identify at most one row: the primary key or a declared unique. */
function isUniqueSet(ir: ModelIR, names: readonly string[]): boolean {
  if (names.length === 1 && names[0] === ir.primaryKey) return true;
  return ir.uniques.some((u) => sameSet(u, names));
}

function resolveOwner(rel: RelationDraft, drafts: ReadonlyMap<string, ModelDraft>, report: Report): void {
  const attr = rel.attribute;
  if (attr === undefined) return;
  const target = drafts.get(rel.field.target);
  if (target === undefined) return;
  if (rel.field.list) report("A relation with @relation(fields, references) cannot be a list", rel.node.pos);

  let fkNames: string[] | undefined;
  let refNames: string[] | undefined;
  let onDelete: OnDelete | undefined;
  for (const arg of attr.args) {
    if (arg.name === "fields") fkNames = identList(arg.value, report);
    else if (arg.name === "references") refNames = identList(arg.value, report);
    else if (arg.name === "onDelete") {
      if (arg.value.kind === "ident" && ON_DELETE.has(arg.value.name)) onDelete = arg.value.name as OnDelete;
      else report("onDelete must be Cascade, Restrict or SetNull", arg.value.pos);
    } else if (arg.name === "name") {
      report("Named relations are not supported", attr.pos);
    } else {
      report("Unexpected @relation argument", attr.pos);
    }
  }
  if (fkNames === undefined || refNames === undefined) {
    if (!attr.args.some((a) => a.name === "fields") || !attr.args.some((a) => a.name === "references")) {
      report("@relation requires fields and references", attr.pos);
    }
    return;
  }
  const fks = fkNames;
  const refs = refNames;
  if (fks.length !== refs.length) {
    report("fields and references must have the same length", attr.pos);
    return;
  }

  let ok = true;
  for (const [i, fkName] of fks.entries()) {
    const fk = rel.model.fields.get(fkName);
    const refName = refs[i];
    const ref = refName === undefined ? undefined : target.fields.get(refName);
    if (fk === undefined || fk.kind === "relation") {
      report("Foreign key must be a scalar or enum field of this model", attr.pos);
      ok = false;
      continue;
    }
    if (ref === undefined || ref.kind === "relation") {
      report("Referenced field must be a scalar or enum field of the target model", attr.pos);
      ok = false;
      continue;
    }
    const sameType =
      fk.kind === "scalar" ? ref.kind === "scalar" && ref.type === fk.type : ref.kind === "enum" && ref.enumName === fk.enumName;
    if (!sameType) {
      report("Foreign key type must match the referenced field type", attr.pos);
      ok = false;
    }
    if (fk.nullable !== rel.field.nullable) {
      report("Foreign key nullability must match the relation", attr.pos);
      ok = false;
    }
  }
  if (!ok) return;
  if (!isUniqueSet(target.ir, refs)) {
    report("Referenced fields must be the @id or a unique constraint of the target model", attr.pos);
    return;
  }
  if (onDelete === "SetNull" && !rel.field.nullable) {
    report("onDelete: SetNull requires an optional relation", attr.pos);
  }
  rel.field.fields = fks;
  rel.field.references = refs;
  if (onDelete !== undefined) rel.field.onDelete = onDelete;
}

function pairRelations(relations: readonly RelationDraft[], drafts: ReadonlyMap<string, ModelDraft>, report: Report): void {
  const groups = new Map<string, RelationDraft[]>();
  for (const rel of relations) {
    const key = [rel.model.node.name, rel.field.target].sort().join("\n");
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [rel]);
    else group.push(rel);
  }
  for (const group of groups.values()) {
    const [a, b] = group;
    if (a === undefined) continue;
    if (b === undefined) {
      report("Relation has no opposite field on the target model", a.node.pos);
      continue;
    }
    for (const extra of group.slice(2)) {
      report("Only one relation between two models is supported", extra.node.pos);
    }
    if (group.length > 2) continue;
    if (a.model === b.model) {
      report("Only one relation between two models is supported", b.node.pos);
      continue;
    }
    const owners = group.filter((r) => r.attribute !== undefined);
    const owner = owners[0];
    const inverse = group.find((r) => r.attribute === undefined);
    if (owners.length !== 1 || owner === undefined || inverse === undefined) {
      report("Exactly one side of a relation must have @relation(fields, references)", b.node.pos);
      continue;
    }
    inverse.field.onDelete = owner.field.onDelete;
    if (!inverse.field.list) {
      if (!inverse.field.nullable) report("A one-to-one inverse relation must be optional", inverse.node.pos);
      const ownerModel = drafts.get(owner.model.node.name);
      if (ownerModel !== undefined && owner.field.fields.length > 0 && !isUniqueSet(ownerModel.ir, owner.field.fields)) {
        report("A one-to-one relation requires a unique foreign key", owner.node.pos);
      }
    }
  }
}

/** Validates the AST and builds the schema IR. Throws one SchemaError holding every diagnostic. */
export function buildSchema(ast: SchemaAst, file?: string): SchemaIR {
  const diagnostics: SchemaDiagnostic[] = [];
  const report: Report = (message, pos) => {
    diagnostics.push({ message, line: pos.line, column: pos.column });
  };

  let datasource: DatasourceInfo | undefined;
  let datasourceCount = 0;
  const enums: EnumIR[] = [];
  const enumMap = new Map<string, EnumIR>();
  const modelNodes: ModelNode[] = [];

  for (const block of ast.blocks) {
    if (block.kind === "datasource") {
      datasourceCount++;
      if (datasourceCount > 1) report("Only one datasource block is allowed", block.pos);
      else datasource = validateDatasource(block, report);
    } else if (block.kind === "enum") {
      const ok = checkIdentifier(block.name, "enum name", block.pos, report);
      const ir = validateEnum(block, report);
      if (!ok) continue;
      if (enumMap.has(block.name)) {
        report(`Duplicate enum ${show(block.name)}`, block.pos);
        continue;
      }
      if (SCALAR_TYPES.has(block.name)) {
        report(`Enum name ${show(block.name)} conflicts with a built-in type`, block.pos);
        continue;
      }
      enumMap.set(block.name, ir);
      enums.push(ir);
    } else if (block.kind === "model") {
      modelNodes.push(block);
    }
  }
  if (datasourceCount === 0) report("A datasource block is required", { line: 1, column: 1 });

  // Model names, delegates and tables.
  const drafts = new Map<string, ModelDraft>();
  const delegates = new Set<string>();
  const tables = new Set<string>();
  const ordered: ModelDraft[] = [];
  for (const node of modelNodes) {
    if (!checkIdentifier(node.name, "model name", node.pos, report)) continue;
    if (drafts.has(node.name)) {
      report(`Duplicate model ${show(node.name)}`, node.pos);
      continue;
    }
    if (SCALAR_TYPES.has(node.name) || enumMap.has(node.name)) {
      report(`Model name ${show(node.name)} conflicts with another type`, node.pos);
      continue;
    }
    const delegate = lowerFirst(node.name);
    if (!checkIdentifier(delegate, "model delegate name", node.pos, report)) continue;
    if (delegates.has(delegate)) {
      report(`Model delegate ${show(delegate)} is already used`, node.pos);
      continue;
    }
    delegates.add(delegate);
    const draft: ModelDraft = {
      node,
      fields: new Map(),
      ir: { name: node.name, delegate, table: node.name, fields: [], primaryKey: "", uniques: [], indexes: [] },
    };
    drafts.set(node.name, draft);
    ordered.push(draft);
  }

  const ctx: Context = { report, enums: enumMap, modelNames: new Set(drafts.keys()), relations: [] };
  for (const draft of ordered) buildFields(draft, ctx);
  for (const draft of ordered) buildModelAttributes(draft, ctx);
  for (const draft of ordered) {
    if (tables.has(draft.ir.table)) report(`Table ${show(draft.ir.table)} is already used`, draft.node.pos);
    tables.add(draft.ir.table);
  }
  const relations = ctx.relations;
  for (const rel of relations) {
    if (rel.field.target === rel.model.node.name) {
      report("Self-relations are not supported", rel.node.pos);
    } else {
      resolveOwner(rel, drafts, report);
    }
  }
  pairRelations(
    relations.filter((r) => r.field.target !== r.model.node.name),
    drafts,
    report,
  );

  if (diagnostics.length > 0 || datasource === undefined) throw new SchemaError(diagnostics, file);
  return {
    provider: datasource.provider,
    urlEnv: datasource.urlEnv,
    models: ordered.map((d) => d.ir),
    enums,
  };
}
