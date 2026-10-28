import { sqliteDialect } from "../../src/dialects/sqlite.js";
import type { CompiledQuery } from "../../src/dialects/sql-ast.js";
import { DEFAULT_RUNTIME_LIMITS } from "../../src/runtime/limits.js";
import { buildFind, createBuildContext, type BuildContext } from "../../src/runtime/query-builder.js";
import { validateArgs, type Operation, type ValidatedArgs } from "../../src/runtime/validation.js";
import { loadSchema } from "../../src/schema/index.js";
import { indexSchema } from "../../src/schema/ir.js";
import { BLOG_SCHEMA } from "./schemas.js";

export const idx = indexSchema(loadSchema(BLOG_SCHEMA));

/** A fresh context (aliases restart at t0) over the blog schema and the SQLite dialect. */
export function ctx(): BuildContext {
  return createBuildContext(idx, sqliteDialect, DEFAULT_RUNTIME_LIMITS);
}

export function validated(model: string, op: Operation, args: unknown): ValidatedArgs {
  return validateArgs(idx, model, op, args, DEFAULT_RUNTIME_LIMITS);
}

export function compileFind(model: string, args: unknown, mode: "many" | "first" | "unique"): CompiledQuery {
  const v = validated(model, "findMany", args);
  if (v.op !== "findMany") throw new Error("not a find result");
  return sqliteDialect.compile(buildFind(ctx(), model, v, mode));
}
