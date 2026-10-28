import type { FieldIR } from "../schema/ir.js";
import type { SchemaIndex } from "../schema/ir.js";
import type { CompiledQuery, SqlQuery, SqlValue } from "./sql-ast.js";

export interface Dialect {
  readonly name: "sqlite" | "postgresql";
  /** Renders a query with `?` placeholders; values only ever travel in `params`. */
  compile(query: SqlQuery): CompiledQuery;
  /** Throws when `id` is not a plain identifier. */
  quoteIdentifier(id: string): string;
  /** For DDL only (defaults, CHECK lists). */
  quoteLiteral(value: string | number | boolean): string;
  /** Already-validated JS value to storage value. */
  encode(field: FieldIR, value: unknown): SqlValue;
  /** Storage value to JS value. */
  decode(field: FieldIR, raw: unknown): unknown;
  /** One CREATE TABLE / CREATE INDEX statement per element, tables in FK order. */
  createTables(index: SchemaIndex, models?: readonly string[]): string[];
  dropTables(tables: readonly string[]): string[];
}
