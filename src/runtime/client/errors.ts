import { ConstraintViolation } from "../../adapters/adapter.js";
import { ConfigError, DatabaseError, type DebugInfo, ForeignKeyError, TransactionError, UniqueConstraintError } from "../../errors.js";
import type { Engine } from "./engine.js";

function violationDebug(engine: Engine, err: ConstraintViolation): DebugInfo | undefined {
  if (!engine.debug) return undefined;
  const query = err.query;
  return query === undefined ? { cause: err } : { sql: query.text, params: query.params, cause: err };
}

/**
 * Translates adapter signals into public errors. SQL, parameters and driver causes only survive in `debug`,
 * and only when the client runs with `debug: true`. Anything else (validation errors, user errors) is returned as is.
 */
export function mapClientError(engine: Engine, model: string | undefined, err: unknown): unknown {
  if (err instanceof ConstraintViolation) {
    const debug = violationDebug(engine, err);
    if (err.kind === "foreignKey") return new ForeignKeyError(model ?? "Unknown", debug);
    const owner = (err.table === undefined ? undefined : engine.index.byTable.get(err.table)) ??
      (model === undefined ? undefined : engine.index.models.get(model));
    const fields: string[] = [];
    for (const column of err.columns) {
      const field = owner?.byColumn.get(column);
      if (field !== undefined) fields.push(field.name);
    }
    return new UniqueConstraintError(owner?.ir.name ?? model ?? "Unknown", fields, debug);
  }
  if (engine.debug) return err;
  if (err instanceof DatabaseError && err.debug !== undefined) return new DatabaseError();
  if (err instanceof TransactionError && err.debug !== undefined) return new TransactionError(err.message);
  if (err instanceof ConfigError && err.debug !== undefined) return new ConfigError(err.message);
  return err;
}
