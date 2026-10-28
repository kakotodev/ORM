export type ErrorCode =
  | "VALIDATION"
  | "LIMIT_EXCEEDED"
  | "NOT_FOUND"
  | "UNIQUE_CONSTRAINT"
  | "FOREIGN_KEY"
  | "DATABASE"
  | "TRANSACTION"
  | "SCHEMA"
  | "MIGRATION"
  | "CONFIG";

/** Sensitive diagnostic data; never part of message, JSON or inspect output. */
export interface DebugInfo {
  sql?: string;
  params?: readonly unknown[];
  cause?: unknown;
}

const MAX_PATH_LENGTH = 63;

/** Strips control characters and truncates a key path so it is safe to put in a message. */
export function safePath(path: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = path.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return clean.length > MAX_PATH_LENGTH ? clean.slice(0, MAX_PATH_LENGTH) + "…" : clean;
}

export class OrmError extends Error {
  readonly code: ErrorCode;
  declare readonly debug?: DebugInfo;

  constructor(code: ErrorCode, message: string, debug?: DebugInfo) {
    super(message); // never pass the native `cause` option
    this.name = new.target.name;
    this.code = code;
    if (debug !== undefined) {
      Object.defineProperty(this, "debug", {
        value: debug,
        enumerable: false,
        writable: false,
        configurable: true,
      });
    }
  }

  toJSON(): { name: string; code: ErrorCode; message: string } {
    return { name: this.name, code: this.code, message: this.message };
  }
}

export class ValidationError extends OrmError {
  readonly path: string;

  constructor(message: string, path: string, debug?: DebugInfo, code: ErrorCode = "VALIDATION") {
    const shown = safePath(path);
    super(code, `${message} (at ${shown})`, debug);
    this.path = shown;
  }
}

export class LimitExceededError extends ValidationError {
  readonly limit: string;

  constructor(limit: string, path: string) {
    super(`Limit exceeded: ${safePath(limit)}`, path, undefined, "LIMIT_EXCEEDED");
    this.limit = limit;
  }
}

export class NotFoundError extends OrmError {
  readonly model: string;

  constructor(model: string, debug?: DebugInfo) {
    super("NOT_FOUND", `${safePath(model)} record not found`, debug);
    this.model = model;
  }
}

export class UniqueConstraintError extends OrmError {
  readonly model: string;
  readonly fields: readonly string[];

  constructor(model: string, fields: readonly string[], debug?: DebugInfo) {
    super("UNIQUE_CONSTRAINT", `Unique constraint violated on ${safePath(model)}`, debug);
    this.model = model;
    this.fields = fields;
  }
}

export class ForeignKeyError extends OrmError {
  readonly model: string;

  constructor(model: string, debug?: DebugInfo) {
    super("FOREIGN_KEY", `Foreign key constraint violated on ${safePath(model)}`, debug);
    this.model = model;
  }
}

export class DatabaseError extends OrmError {
  constructor(debug?: DebugInfo) {
    super("DATABASE", "Database operation failed", debug);
  }
}

export class TransactionError extends OrmError {
  constructor(message = "Transaction failed", debug?: DebugInfo) {
    super("TRANSACTION", message, debug);
  }
}

export class ConfigError extends OrmError {
  constructor(message: string, debug?: DebugInfo) {
    super("CONFIG", message, debug);
  }
}

export class MigrationError extends OrmError {
  constructor(message: string, debug?: DebugInfo) {
    super("MIGRATION", message, debug);
  }
}

export interface SchemaDiagnostic {
  message: string;
  line: number;
  column: number;
}

export class SchemaError extends OrmError {
  readonly diagnostics: readonly SchemaDiagnostic[];

  constructor(diagnostics: readonly SchemaDiagnostic[], file?: string) {
    const count = diagnostics.length;
    const where = file === undefined ? "" : ` in ${safePath(file.split(/[\\/]/).pop() ?? "")}`;
    super("SCHEMA", `Schema is invalid${where}: ${String(count)} error${count === 1 ? "" : "s"}`);
    this.diagnostics = diagnostics;
  }
}
