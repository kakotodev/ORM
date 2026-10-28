/* eslint-disable security/detect-non-literal-fs-filename --
   Paths are built with `join(dir, name)`, where `name` comes only from `migrationName` or from a
   directory entry that matched MIGRATION_FILE; the directory is chosen by the developer. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MigrationError } from "../errors.js";
import type { SchemaIR } from "../schema/ir.js";

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
  snapshot: SchemaIR;
}

export const STATEMENT_BREAKPOINT = "-- statement-breakpoint";
/** Matches the files this tool owns inside a migrations directory. */
export const MIGRATION_FILE = /^\d{14}_[a-z0-9_]+\.(sql|snapshot\.json)$/;

const LABEL = /^[a-z0-9_]{1,40}$/;
const NAME = /^\d{14}_[a-z0-9_]+$/;
const SQL_SUFFIX = ".sql";
const SNAPSHOT_SUFFIX = ".snapshot.json";

function normalize(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

/** SHA-256 hex of the content with CRLF normalised to LF. */
export function checksum(sql: string): string {
  return createHash("sha256").update(normalize(sql), "utf8").digest("hex");
}

export function migrationName(now: Date, label: string): string {
  if (typeof label !== "string" || !LABEL.test(label)) throw new MigrationError("Invalid migration name");
  if (Number.isNaN(now.getTime())) throw new MigrationError("Invalid migration date");
  const p = (n: number, width = 2): string => String(n).padStart(width, "0");
  const stamp =
    p(now.getUTCFullYear(), 4) +
    p(now.getUTCMonth() + 1) +
    p(now.getUTCDate()) +
    p(now.getUTCHours()) +
    p(now.getUTCMinutes()) +
    p(now.getUTCSeconds());
  return `${stamp}_${label}`;
}

/** Splits migration SQL on breakpoint lines (never on `;`), trimming and dropping empty parts. */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current: string[] = [];
  for (const line of normalize(sql).split("\n")) {
    if (line === STATEMENT_BREAKPOINT) {
      statements.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  statements.push(current.join("\n"));
  return statements.map((s) => s.trim()).filter((s) => s.length > 0);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSnapshot(text: string, name: string): SchemaIR {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new MigrationError(`Migration ${name} has an invalid snapshot`);
  }
  const models = isObject(value) ? value["models"] : undefined;
  const enums = isObject(value) ? value["enums"] : undefined;
  const valid =
    Array.isArray(models) &&
    Array.isArray(enums) &&
    models.every(
      (m: unknown) =>
        isObject(m) && typeof m["name"] === "string" && typeof m["table"] === "string" && Array.isArray(m["fields"]),
    );
  if (!valid) throw new MigrationError(`Migration ${name} has an invalid snapshot`);
  return value as SchemaIR;
}

/** Reads every migration in `dir`, sorted by name. A missing directory means no migrations. */
export function readMigrations(dir: string): MigrationFile[] {
  if (!existsSync(dir)) return [];
  const sqlNames = new Set<string>();
  const snapshotNames = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !MIGRATION_FILE.test(entry.name)) continue;
    if (entry.name.endsWith(SQL_SUFFIX)) sqlNames.add(entry.name.slice(0, -SQL_SUFFIX.length));
    else snapshotNames.add(entry.name.slice(0, -SNAPSHOT_SUFFIX.length));
  }
  for (const name of [...sqlNames, ...snapshotNames]) {
    if (!sqlNames.has(name) || !snapshotNames.has(name)) {
      throw new MigrationError(`Migration ${name} is missing its ${sqlNames.has(name) ? "snapshot" : "sql"} file`);
    }
  }
  return [...sqlNames].sort().map((name) => {
    const sql = normalize(readFileSync(join(dir, name + SQL_SUFFIX), "utf8"));
    const snapshot = parseSnapshot(readFileSync(join(dir, name + SNAPSHOT_SUFFIX), "utf8"), name);
    return { name, sql, checksum: checksum(sql), snapshot };
  });
}

/** Writes `<name>.sql` and `<name>.snapshot.json` (LF); refuses to overwrite existing files. */
export function writeMigration(dir: string, name: string, sql: string, snapshot: SchemaIR): MigrationFile {
  if (!NAME.test(name)) throw new MigrationError("Invalid migration name");
  const content = normalize(sql);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, name + SQL_SUFFIX), content, { flag: "wx" });
    writeFileSync(join(dir, name + SNAPSHOT_SUFFIX), `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" });
  } catch {
    throw new MigrationError(`Unable to write migration ${name}`);
  }
  return { name, sql: content, checksum: checksum(content), snapshot };
}
