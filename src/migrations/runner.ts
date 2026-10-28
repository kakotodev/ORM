/* eslint-disable security/detect-non-literal-fs-filename --
   Only entries of `dir` that match MIGRATION_FILE are removed; names never come from snapshots. */
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, Queryable } from "../adapters/adapter.js";
import { MigrationError, safePath } from "../errors.js";
import type { ModelIR, SchemaIR } from "../schema/ir.js";
import { indexSchema } from "../schema/ir.js";
import { diffSchemas } from "./diff.js";
import {
  MIGRATION_FILE,
  STATEMENT_BREAKPOINT,
  migrationName,
  readMigrations,
  splitStatements,
  writeMigration,
  type MigrationFile,
} from "./files.js";

export interface MigrateOptions {
  schema: SchemaIR;
  adapter: Adapter;
  dir: string;
  /** Label of a newly created migration (default `init` for the first one, `update` after). */
  name?: string;
  now?: () => Date;
}

export interface MigrateResult {
  /** Names of the migrations applied by this call, in order. */
  applied: string[];
  /** Name of the migration file written by this call, if any. */
  created: string | null;
  /** True when nothing had to be created or applied. */
  upToDate: boolean;
}

const TRACKING_TABLE = "_mini_orm_migrations";
const CREATE_TRACKING =
  'CREATE TABLE IF NOT EXISTS "_mini_orm_migrations" ("name" TEXT PRIMARY KEY, "checksum" TEXT NOT NULL, "applied_at" TEXT NOT NULL)';
const INSERT_TRACKING = 'INSERT INTO "_mini_orm_migrations" ("name", "checksum", "applied_at") VALUES (?, ?, ?)';

async function applyMigration(adapter: Adapter, file: MigrationFile, now: () => Date): Promise<void> {
  try {
    await adapter.transaction(async (tx: Queryable) => {
      for (const text of splitStatements(file.sql)) await tx.execute({ text, params: [] });
      await tx.execute({ text: INSERT_TRACKING, params: [file.name, file.checksum, now().toISOString()] });
    });
  } catch (cause) {
    throw new MigrationError(`Migration ${file.name} failed to apply`, { cause });
  }
}

/** Picks a name later than every existing migration, bumping the timestamp second by second. */
function nextName(existing: readonly MigrationFile[], label: string, now: Date): string {
  const latest = existing.at(-1)?.name.slice(0, 14) ?? "";
  let date = now;
  let name = migrationName(date, label);
  while (name.slice(0, 14) <= latest || existing.some((f) => f.name === name)) {
    date = new Date(date.getTime() + 1000);
    name = migrationName(date, label);
  }
  return name;
}

export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const { schema, adapter, dir } = options;
  const now = options.now ?? ((): Date => new Date());
  await adapter.executeScript([CREATE_TRACKING]);

  const files = readMigrations(dir);
  const rows = await adapter.query({ text: `SELECT "name", "checksum" FROM "${TRACKING_TABLE}" ORDER BY "name"`, params: [] });
  const byName = new Map(files.map((f) => [f.name, f]));
  const applied = new Set<string>();
  for (const row of rows) {
    const name = String(row["name"]);
    const file = byName.get(name);
    if (file === undefined) throw new MigrationError(`Applied migration ${safePath(name)} is missing`);
    if (file.checksum !== row["checksum"]) throw new MigrationError(`Migration ${name} was modified after being applied`);
    applied.add(name);
  }

  const appliedNow: string[] = [];
  for (const file of files) {
    if (applied.has(file.name)) continue;
    await applyMigration(adapter, file, now);
    appliedNow.push(file.name);
  }

  const diff = diffSchemas(files.at(-1)?.snapshot ?? null, schema);
  if (diff.kind === "unsupported") {
    throw new MigrationError(
      `Schema changes are not supported by additive migrations: ${diff.reasons.join("; ")}. ` +
        "Run `mini-orm migrate reset --force` to rebuild the development database.",
    );
  }
  if (diff.kind === "none") return { applied: appliedNow, created: null, upToDate: appliedNow.length === 0 };

  const label = options.name ?? (files.length === 0 ? "init" : "update");
  const name = nextName(files, label, now());
  const statements = adapter.dialect.createTables(indexSchema(schema), diff.newModels);
  const sql = `${statements.join(`\n${STATEMENT_BREAKPOINT}\n`)}\n`;
  const file = writeMigration(dir, name, sql, schema);
  await applyMigration(adapter, file, now);
  return { applied: [...appliedNow, name], created: name, upToDate: false };
}

/** Table names ordered so that referencing tables (children) come before the tables they reference. */
function dropOrder(snapshots: readonly SchemaIR[]): string[] {
  const models = new Map<string, ModelIR>();
  for (const snapshot of snapshots) for (const m of snapshot.models) models.set(m.name, m);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (model: ModelIR): void => {
    if (seen.has(model.name)) return;
    seen.add(model.name);
    for (const field of model.fields) {
      if (field.kind !== "relation" || field.fields.length === 0) continue;
      const parent = models.get(field.target);
      if (parent !== undefined) visit(parent);
    }
    ordered.push(model.table); // parents are pushed before this model
  };
  for (const model of models.values()) visit(model);
  return ordered.reverse();
}

export async function resetDatabase(
  options: MigrateOptions & { force: boolean; env?: Record<string, string | undefined> },
): Promise<MigrateResult> {
  const env = options.env ?? process.env;
  if (!options.force) throw new MigrationError("Refusing to reset without --force");
  if (env["NODE_ENV"] === "production") throw new MigrationError("Refusing to reset a production database");

  const { adapter, dir } = options;
  const snapshots = readMigrations(dir).map((f) => f.snapshot);
  // SQLite ignores PRAGMA foreign_keys inside a transaction, so tables go children first instead.
  const statements = adapter.dialect.dropTables([...dropOrder(snapshots), TRACKING_TABLE]);
  try {
    await adapter.executeScript(statements);
  } catch (cause) {
    throw new MigrationError("Unable to reset the database", { cause });
  }

  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && MIGRATION_FILE.test(entry.name)) unlinkSync(join(dir, entry.name));
    }
  }
  return migrate({ ...options, name: "init" });
}
