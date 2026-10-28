import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConfigError, DatabaseError, TransactionError } from "../errors.js";
import { sqliteDialect } from "../dialects/sqlite.js";
import type { CompiledQuery } from "../dialects/sql-ast.js";
import { Mutex } from "../runtime/mutex.js";
import { ConstraintViolation, type Adapter, type Queryable } from "./adapter.js";

// node:sqlite errors carry `code: "ERR_SQLITE_ERROR"`, a numeric extended `errcode`
// and a generic `errstr` ("constraint failed"); the detail is only in `message`.
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

const UNIQUE_PREFIX = "UNIQUE constraint failed: ";

function parseUnique(message: string): { table?: string; columns: string[] } {
  const at = message.indexOf(UNIQUE_PREFIX);
  if (at < 0) return { columns: [] };
  let table: string | undefined;
  const columns: string[] = [];
  for (const part of message.slice(at + UNIQUE_PREFIX.length).split(", ")) {
    const dot = part.indexOf(".");
    if (dot < 0) continue; // expression index: no column name available
    table ??= part.slice(0, dot);
    columns.push(part.slice(dot + 1));
  }
  return table === undefined ? { columns } : { table, columns };
}

function errcodeOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { errcode?: unknown }).errcode;
  return typeof code === "number" ? code : undefined;
}

function mapError(err: unknown, q: CompiledQuery | undefined): Error {
  if (err instanceof ConstraintViolation) return err;
  const code = errcodeOf(err);
  const message = err instanceof Error ? err.message : "";
  if (code === SQLITE_CONSTRAINT_UNIQUE || code === SQLITE_CONSTRAINT_PRIMARYKEY) {
    const { table, columns } = parseUnique(message);
    return new ConstraintViolation("unique", table, columns, q);
  }
  if (code === SQLITE_CONSTRAINT_FOREIGNKEY) {
    return new ConstraintViolation("foreignKey", undefined, [], q);
  }
  return new DatabaseError({
    ...(q === undefined ? {} : { sql: q.text, params: q.params }),
    cause: err,
  });
}

function parseUrl(url: string): { memory: boolean; path: string } {
  if (url === "file::memory:") return { memory: true, path: ":memory:" };
  if (url.startsWith("file:") && !url.startsWith("file::")) {
    const rest = url.slice("file:".length);
    if (rest.length > 0 && !rest.includes("\0")) {
      return { memory: false, path: resolve(process.cwd(), rest) };
    }
  }
  throw new ConfigError("Unsupported SQLite URL");
}

const DEFAULT_TRANSACTION_TIMEOUT_MS = 5000;

export function createSqliteAdapter(options: {
  url: string;
  /** Interactive transaction timeout in ms (positive safe integer, default 5000). */
  transactionTimeoutMs?: number;
}): Adapter {
  const { memory, path } = parseUrl(options.url);
  const timeoutMs = options.transactionTimeoutMs ?? DEFAULT_TRANSACTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError("Invalid transaction timeout");
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON");
    if (!memory) db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
  } catch (cause) {
    throw new ConfigError("Unable to open SQLite database", { cause });
  }

  const mutex = new Mutex();
  let closed = false;

  const assertOpen = (): DatabaseSync => {
    if (closed) throw new DatabaseError();
    return db;
  };

  const runQuery = (q: CompiledQuery): Record<string, unknown>[] => {
    try {
      const stmt = assertOpen().prepare(q.text);
      stmt.setReadBigInts(true);
      return stmt.all(...q.params);
    } catch (err) {
      throw mapError(err, q);
    }
  };

  const runExecute = (q: CompiledQuery): { changes: number } => {
    try {
      const stmt = assertOpen().prepare(q.text);
      stmt.setReadBigInts(true);
      return { changes: Number(stmt.run(...q.params).changes) };
    } catch (err) {
      throw mapError(err, q);
    }
  };

  const rollback = (): void => {
    try {
      if (!closed) db.exec("ROLLBACK");
    } catch {
      // Nothing left to roll back (e.g. SQLite already ended the transaction).
    }
  };

  return {
    dialect: sqliteDialect,

    query: (q) => mutex.run(() => Promise.resolve().then(() => runQuery(q))),

    execute: (q) => mutex.run(() => Promise.resolve().then(() => runExecute(q))),

    executeScript: (statements) =>
      mutex.run(() => {
        const conn = assertOpen();
        let current: string | undefined;
        try {
          conn.exec("BEGIN");
          for (const sql of statements) {
            current = sql;
            conn.exec(sql);
          }
          current = undefined;
          conn.exec("COMMIT");
        } catch (err) {
          rollback();
          throw new DatabaseError({ ...(current === undefined ? {} : { sql: current }), cause: err });
        }
        return Promise.resolve();
      }),

    transaction: <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> =>
      mutex.run(async () => {
        const conn = assertOpen();
        try {
          conn.exec(memory ? "BEGIN" : "BEGIN IMMEDIATE");
        } catch (cause) {
          throw new TransactionError("Could not start transaction", { cause });
        }
        let active = true;
        const guard = (): void => {
          if (!active) throw new TransactionError("Transaction is no longer active");
        };
        // Runs directly: the mutex is already held for the whole transaction.
        const tx: Queryable = {
          query: (q) => Promise.resolve().then(() => (guard(), runQuery(q))),
          execute: (q) => Promise.resolve().then(() => (guard(), runExecute(q))),
        };
        let timer: NodeJS.Timeout | undefined;
        const timedOut = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new TransactionError("Transaction timed out"));
          }, timeoutMs);
        });
        let result: T;
        try {
          result = await Promise.race([fn(tx), timedOut]);
        } catch (err) {
          active = false;
          rollback();
          throw err;
        } finally {
          clearTimeout(timer);
        }
        active = false;
        try {
          conn.exec("COMMIT");
        } catch (err) {
          rollback();
          throw mapError(err, undefined);
        }
        return result;
      }),

    close: () =>
      mutex.run(() => {
        if (closed) return Promise.resolve();
        closed = true;
        try {
          db.close();
        } catch (cause) {
          return Promise.reject(new DatabaseError({ cause }));
        }
        return Promise.resolve();
      }),
  };
}
