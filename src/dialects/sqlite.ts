import { OrmError } from "../errors.js";
import type { EnumField, FieldIR, ModelIndex, RelationField, ScalarField, ScalarType, SchemaIndex } from "../schema/ir.js";
import type { Dialect } from "./dialect.js";
import type { CompiledQuery, SelectQuery, SqlExpr, SqlQuery, SqlValue } from "./sql-ast.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_IDENTIFIER_LENGTH = 63;
const COMPARE_OPS: ReadonlySet<string> = new Set(["=", "<>", "<", "<=", ">", ">="]);

function fail(message: string): never {
  throw new OrmError("VALIDATION", message);
}

function quoteIdentifier(id: string): string {
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_IDENTIFIER_LENGTH || !IDENTIFIER.test(id)) {
    return fail("Invalid SQL identifier");
  }
  return `"${id}"`;
}

function quoteLiteral(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fail("Invalid numeric literal");
    return String(value);
  }
  if (typeof value !== "string" || value.includes("\0")) return fail("Invalid string literal");
  return `'${value.replaceAll("'", "''")}'`;
}

/** GLOB pattern for a case-sensitive text match; metacharacters in `value` are neutralised. */
export function globPattern(mode: "contains" | "startsWith" | "endsWith", value: string): string {
  // Single pass so brackets added by the escaping are never escaped again.
  const pattern = value.replace(/[*?[]/g, (c) => `[${c}]`);
  if (mode === "contains") return `*${pattern}*`;
  return mode === "startsWith" ? `${pattern}*` : `*${pattern}`;
}

// ---------------------------------------------------------------- compiler

class Compiler {
  readonly params: SqlValue[] = [];

  param(value: SqlValue): string {
    this.params.push(value);
    return "?";
  }

  select(q: SelectQuery): string {
    const alias = quoteIdentifier(q.alias);
    let columns: string;
    if (q.columns === "count") columns = 'COUNT(*) AS "count"';
    else if (q.columns.length === 0) columns = "1";
    else columns = q.columns.map((c) => `${alias}.${quoteIdentifier(c.column)} AS ${quoteIdentifier(c.as)}`).join(", ");
    let text = `SELECT ${columns} FROM ${quoteIdentifier(q.table)} AS ${alias}`;
    text += this.where(q.where);
    if (q.orderBy.length > 0) {
      // Direction is re-derived from a literal so no caller-supplied string reaches the text.
      const items = q.orderBy.map((o) => `${alias}.${quoteIdentifier(o.column)} ${o.direction === "DESC" ? "DESC" : "ASC"}`);
      text += ` ORDER BY ${items.join(", ")}`;
    }
    if (q.limit !== undefined) text += ` LIMIT ${this.param(q.limit)}`;
    else if (q.offset !== undefined) text += " LIMIT -1"; // SQLite requires LIMIT before OFFSET
    if (q.offset !== undefined) text += ` OFFSET ${this.param(q.offset)}`;
    return text;
  }

  where(expr: SqlExpr | undefined): string {
    if (expr === undefined) return "";
    const text = this.expr(expr, false);
    return text === "" ? "" : ` WHERE ${text}`;
  }

  returning(columns: readonly string[]): string {
    if (columns.length === 0) return "";
    return ` RETURNING ${columns.map((c) => `${quoteIdentifier(c)} AS ${quoteIdentifier(c)}`).join(", ")}`;
  }

  insert(q: Extract<SqlQuery, { kind: "insert" }>): string {
    if (q.rows.length === 0) return fail("Insert needs at least one row");
    const head = `INSERT INTO ${quoteIdentifier(q.table)}`;
    if (q.columns.length === 0) {
      if (q.rows.length !== 1 || (q.rows[0]?.length ?? 0) !== 0) return fail("Insert row does not match columns");
      return `${head} DEFAULT VALUES${this.returning(q.returning)}`;
    }
    const columns = q.columns.map(quoteIdentifier).join(", ");
    const rows = q.rows.map((row) => {
      if (row.length !== q.columns.length) return fail("Insert row does not match columns");
      return `(${row.map((v) => this.param(v)).join(", ")})`;
    });
    return `${head} (${columns}) VALUES ${rows.join(", ")}${this.returning(q.returning)}`;
  }

  update(q: Extract<SqlQuery, { kind: "update" }>): string {
    if (q.set.length === 0) return fail("Update needs at least one column");
    const head = `UPDATE ${quoteIdentifier(q.table)} AS ${quoteIdentifier(q.alias)}`;
    const set = q.set.map((s) => `${quoteIdentifier(s.column)} = ${this.param(s.value)}`).join(", ");
    return `${head} SET ${set}${this.where(q.where)}${this.returning(q.returning)}`;
  }

  delete(q: Extract<SqlQuery, { kind: "delete" }>): string {
    const head = `DELETE FROM ${quoteIdentifier(q.table)} AS ${quoteIdentifier(q.alias)}`;
    return `${head}${this.where(q.where)}${this.returning(q.returning)}`;
  }

  /** `nested` is true when the expression sits inside another one (groups then need parentheses). */
  expr(e: SqlExpr, nested: boolean): string {
    switch (e.kind) {
      case "column":
        return `${quoteIdentifier(e.alias)}.${quoteIdentifier(e.column)}`;
      case "param":
        return this.param(e.value);
      case "compare": {
        if (!COMPARE_OPS.has(e.op)) return fail("Invalid comparison operator");
        const left = this.expr(e.left, true);
        return `${left} ${e.op} ${this.expr(e.right, true)}`;
      }
      case "isNull":
        return `${this.expr(e.expr, true)} IS ${e.negated ? "NOT " : ""}NULL`;
      case "in": {
        if (e.values.length === 0) return e.negated ? "1" : "0";
        const target = this.expr(e.expr, true);
        const marks = e.values.map((v) => this.param(v)).join(", ");
        return `${target} ${e.negated ? "NOT " : ""}IN (${marks})`;
      }
      case "textMatch": {
        const target = this.expr(e.expr, true);
        return `${target} GLOB ${this.param(globPattern(e.mode, e.value))}`;
      }
      case "and":
      case "or": {
        const [only, ...rest] = e.items;
        if (only === undefined) return nested ? (e.kind === "and" ? "1" : "0") : e.kind === "and" ? "" : "0";
        if (rest.length === 0) return this.expr(only, nested);
        const joined = e.items.map((i) => this.expr(i, true)).join(e.kind === "and" ? " AND " : " OR ");
        return nested ? `(${joined})` : joined;
      }
      case "not":
        return `NOT (${this.expr(e.expr, false)})`;
      case "exists":
        return `${e.negated ? "NOT " : ""}EXISTS (${this.select(e.query)})`;
      case "true":
        return "1";
      case "false":
        return "0";
    }
  }
}

function compile(query: SqlQuery): CompiledQuery {
  const c = new Compiler();
  let text: string;
  switch (query.kind) {
    case "select":
      text = c.select(query);
      break;
    case "insert":
      text = c.insert(query);
      break;
    case "update":
      text = c.update(query);
      break;
    case "delete":
      text = c.delete(query);
      break;
  }
  return { text, params: c.params };
}

// ---------------------------------------------------------------- codec

function wrongType(): never {
  return fail("Value has the wrong type for its column");
}

function encode(field: FieldIR, value: unknown): SqlValue {
  if (field.kind === "relation") return fail("Relation fields have no column value");
  if (value === null) return null;
  if (field.kind === "enum") return typeof value === "string" ? value : wrongType();
  switch (field.type) {
    case "Int":
      return typeof value === "number" && Number.isInteger(value) ? value : wrongType();
    case "Float":
      return typeof value === "number" && Number.isFinite(value) ? value : wrongType();
    case "BigInt":
      return typeof value === "bigint" ? value : wrongType();
    case "Decimal":
    case "String":
      return typeof value === "string" ? value : wrongType();
    case "Boolean":
      return typeof value === "boolean" ? (value ? 1 : 0) : wrongType();
    case "DateTime":
      return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : wrongType();
    case "Json": {
      const text: unknown = JSON.stringify(value);
      return typeof text === "string" ? text : wrongType();
    }
    case "Bytes":
      return value instanceof Uint8Array ? value : wrongType();
  }
}

function badStored(): never {
  throw new OrmError("DATABASE", "Stored value could not be decoded");
}

function decodeScalar(type: ScalarType, raw: unknown): unknown {
  switch (type) {
    case "Int":
      if (typeof raw === "number") return raw;
      return typeof raw === "bigint" && raw >= BigInt(Number.MIN_SAFE_INTEGER) && raw <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(raw)
        : badStored();
    case "Float":
      if (typeof raw === "number") return raw;
      return typeof raw === "bigint" ? Number(raw) : badStored();
    case "BigInt":
      if (typeof raw === "bigint") return raw;
      return typeof raw === "number" && Number.isInteger(raw) ? BigInt(raw) : badStored();
    case "Decimal":
    case "String":
      return typeof raw === "string" ? raw : badStored();
    case "Boolean":
      if (raw === 1 || raw === 1n || raw === true) return true;
      return raw === 0 || raw === 0n || raw === false ? false : badStored();
    case "DateTime": {
      if (typeof raw !== "string") return badStored();
      const date = new Date(raw);
      return Number.isNaN(date.getTime()) ? badStored() : date;
    }
    case "Json":
      if (typeof raw !== "string") return badStored();
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return badStored();
      }
    case "Bytes":
      return raw instanceof Uint8Array ? raw : badStored();
  }
}

function decode(field: FieldIR, raw: unknown): unknown {
  if (field.kind === "relation") return fail("Relation fields have no column value");
  if (raw === null) return null;
  if (field.kind === "enum") return typeof raw === "string" ? raw : badStored();
  return decodeScalar(field.type, raw);
}

// ---------------------------------------------------------------- DDL

const SQL_TYPE: Readonly<Record<ScalarType, string>> = {
  Int: "INTEGER",
  BigInt: "INTEGER",
  Boolean: "INTEGER",
  Float: "REAL",
  Bytes: "BLOB",
  Decimal: "TEXT",
  String: "TEXT",
  DateTime: "TEXT",
  Json: "TEXT",
};

function columnDefinition(model: ModelIndex, field: ScalarField | EnumField, index: SchemaIndex): string {
  const name = quoteIdentifier(field.column);
  const isPrimary = field.name === model.ir.primaryKey;
  if (field.kind === "scalar") {
    if (isPrimary && field.type === "Int" && field.default?.kind === "autoincrement") {
      return `${name} INTEGER PRIMARY KEY AUTOINCREMENT`;
    }
  }
  const parts = [name, field.kind === "scalar" ? SQL_TYPE[field.type] : "TEXT"];
  if (!field.nullable || isPrimary) parts.push("NOT NULL");
  if (isPrimary) parts.push("PRIMARY KEY");
  else if (field.isUnique) parts.push("UNIQUE");
  if (field.default?.kind === "literal") parts.push(`DEFAULT ${quoteLiteral(field.default.value)}`);
  if (field.kind === "enum") {
    const values = index.enums.get(field.enumName)?.values;
    if (values === undefined) return fail("Unknown enum in schema");
    parts.push(`CHECK (${name} IN (${values.map(quoteLiteral).join(", ")}))`);
  }
  return parts.join(" ");
}

function columnsOf(model: ModelIndex, names: readonly string[]): string {
  return names
    .map((n) => {
      const f = model.fields.get(n);
      return f === undefined || f.kind === "relation" ? fail("Unknown column in schema") : quoteIdentifier(f.column);
    })
    .join(", ");
}

const ON_DELETE: Readonly<Record<RelationField["onDelete"], string>> = {
  Cascade: "CASCADE",
  Restrict: "RESTRICT",
  SetNull: "SET NULL",
};

function ownedRelations(model: ModelIndex): RelationField[] {
  const out: RelationField[] = [];
  for (const f of model.ir.fields) if (f.kind === "relation" && f.fields.length > 0) out.push(f);
  return out;
}

function createTable(model: ModelIndex, index: SchemaIndex): string[] {
  const lines: string[] = [];
  for (const f of model.ir.fields) if (f.kind !== "relation") lines.push(columnDefinition(model, f, index));
  for (const u of model.ir.uniques) if (u.length > 1) lines.push(`UNIQUE (${columnsOf(model, u)})`);
  for (const rel of ownedRelations(model)) {
    const target = index.models.get(rel.target);
    if (target === undefined) return fail("Unknown relation target in schema");
    lines.push(
      `FOREIGN KEY (${columnsOf(model, rel.fields)}) REFERENCES ${quoteIdentifier(target.ir.table)} (${columnsOf(target, rel.references)}) ON DELETE ${ON_DELETE[rel.onDelete]}`,
    );
  }
  const statements = [`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(model.ir.table)} (\n  ${lines.join(",\n  ")}\n)`];
  for (const cols of model.ir.indexes) {
    const names = cols.map((n) => {
      const f = model.fields.get(n);
      return f === undefined || f.kind === "relation" ? fail("Unknown column in schema") : f.column;
    });
    const indexName = quoteIdentifier(`${model.ir.table}_${names.join("_")}_idx`);
    statements.push(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${quoteIdentifier(model.ir.table)} (${columnsOf(model, cols)})`);
  }
  return statements;
}

/** Orders models so every FK target precedes its referrers; cycles fall back to declaration order. */
function sortByDependency(models: readonly ModelIndex[]): ModelIndex[] {
  const names = new Set(models.map((m) => m.ir.name));
  const remaining = [...models];
  const placed = new Set<string>();
  const out: ModelIndex[] = [];
  while (remaining.length > 0) {
    let pick = remaining.findIndex((m) =>
      ownedRelations(m).every((r) => r.target === m.ir.name || !names.has(r.target) || placed.has(r.target)),
    );
    if (pick === -1) pick = 0;
    const [model] = remaining.splice(pick, 1);
    if (model === undefined) break;
    placed.add(model.ir.name);
    out.push(model);
  }
  return out;
}

function createTables(index: SchemaIndex, models?: readonly string[]): string[] {
  const selected: ModelIndex[] = [];
  if (models === undefined) {
    for (const m of index.ir.models) {
      const entry = index.models.get(m.name);
      if (entry !== undefined) selected.push(entry);
    }
  } else {
    for (const name of models) {
      const entry = index.models.get(name);
      if (entry === undefined) return fail("Unknown model in schema");
      selected.push(entry);
    }
  }
  return sortByDependency(selected).flatMap((m) => createTable(m, index));
}

function dropTables(tables: readonly string[]): string[] {
  return tables.map((t) => `DROP TABLE IF EXISTS ${quoteIdentifier(t)}`);
}

export const sqliteDialect: Dialect = {
  name: "sqlite",
  compile,
  quoteIdentifier,
  quoteLiteral,
  encode,
  decode,
  createTables,
  dropTables,
};
