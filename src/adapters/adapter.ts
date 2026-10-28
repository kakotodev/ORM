import type { CompiledQuery } from "../dialects/sql-ast.js";
import type { Dialect } from "../dialects/dialect.js";

export type ConstraintKind = "unique" | "foreignKey";

/** Internal signal from an adapter; the client translates it into a public error. Never shown to users. */
export class ConstraintViolation extends Error {
  readonly kind: ConstraintKind;
  readonly table?: string;
  readonly columns: readonly string[];
  /** The query that failed, for the client to attach in debug mode. Non-enumerable. */
  declare readonly query?: CompiledQuery;

  constructor(
    kind: ConstraintKind,
    table?: string,
    columns: readonly string[] = [],
    query?: CompiledQuery,
  ) {
    super(`Constraint violation: ${kind}`);
    this.name = "ConstraintViolation";
    this.kind = kind;
    if (table !== undefined) this.table = table;
    this.columns = columns;
    if (query !== undefined) {
      Object.defineProperty(this, "query", {
        value: query,
        enumerable: false,
        writable: false,
        configurable: true,
      });
    }
  }
}

export interface Queryable {
  query(q: CompiledQuery): Promise<Record<string, unknown>[]>;
  execute(q: CompiledQuery): Promise<{ changes: number }>;
}

export interface Adapter extends Queryable {
  readonly dialect: Dialect;
  /** Runs DDL statements in order inside one transaction. */
  executeScript(statements: readonly string[]): Promise<void>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
