export type SqlValue = string | number | bigint | null | Uint8Array;

export type SqlExpr =
  | { kind: "column"; alias: string; column: string }
  | { kind: "param"; value: SqlValue }
  | { kind: "compare"; op: "=" | "<>" | "<" | "<=" | ">" | ">="; left: SqlExpr; right: SqlExpr }
  | { kind: "isNull"; expr: SqlExpr; negated: boolean }
  | { kind: "in"; expr: SqlExpr; values: SqlValue[]; negated: boolean }
  | { kind: "textMatch"; mode: "contains" | "startsWith" | "endsWith"; expr: SqlExpr; value: string }
  | { kind: "and" | "or"; items: SqlExpr[] }
  | { kind: "not"; expr: SqlExpr }
  | { kind: "exists"; query: SelectQuery; negated: boolean }
  | { kind: "true" }
  | { kind: "false" };

export interface SelectQuery {
  kind: "select";
  table: string;
  alias: string;
  /** `[]` renders `SELECT 1` (EXISTS subqueries); `"count"` renders `COUNT(*) AS "count"`. */
  columns: { column: string; as: string }[] | "count";
  where?: SqlExpr;
  orderBy: { column: string; direction: "ASC" | "DESC" }[];
  limit?: number;
  offset?: number;
}

/** `column` is the database column, `as` the field name it is returned under. */
export interface ReturningColumn {
  column: string;
  as: string;
}

export interface InsertQuery {
  kind: "insert";
  table: string;
  columns: string[];
  rows: SqlValue[][];
  returning: ReturningColumn[];
}

export interface UpdateQuery {
  kind: "update";
  table: string;
  alias: string;
  set: { column: string; value: SqlValue }[];
  where?: SqlExpr;
  returning: ReturningColumn[];
}

export interface DeleteQuery {
  kind: "delete";
  table: string;
  alias: string;
  where?: SqlExpr;
  returning: ReturningColumn[];
}

export type SqlQuery = SelectQuery | InsertQuery | UpdateQuery | DeleteQuery;

export interface CompiledQuery {
  text: string;
  params: SqlValue[];
}
