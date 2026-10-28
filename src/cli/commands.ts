import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createSqliteAdapter } from "../adapters/sqlite.js";
import { ConfigError, OrmError, SchemaError, safePath } from "../errors.js";
import { generateClient } from "../generator/client.js";
import { migrate, resetDatabase, type MigrateResult } from "../migrations/runner.js";
import { loadSchema } from "../schema/index.js";
import type { SchemaIR } from "../schema/ir.js";

export interface CliIO {
  stdout(line: string): void;
  stderr(line: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
}

const HELP = [
  "Usage: mini-orm <command> [options]",
  "",
  "Commands:",
  "  generate [--schema ./schema.orm] [--out ./generated] [--runtime-import mini-orm]",
  "  migrate [--schema ./schema.orm] [--dir ./migrations] [--name <label>]",
  "  migrate reset --force [--schema ./schema.orm] [--dir ./migrations]",
  "",
  "Options:",
  "  --debug     print diagnostic details of failures",
  "  --help      show this help",
  "  --version   show the version",
];

const OPTIONS = {
  schema: { type: "string" },
  out: { type: "string" },
  dir: { type: "string" },
  name: { type: "string" },
  "runtime-import": { type: "string" },
  force: { type: "boolean" },
  debug: { type: "boolean" },
  help: { type: "boolean" },
  version: { type: "boolean" },
} as const;

/** Options each command accepts besides the global ones. */
const COMMAND_OPTIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ["generate", ["schema", "out", "runtime-import"]],
  ["migrate", ["schema", "dir", "name"]],
  ["migrate reset", ["schema", "dir", "force"]],
]);
const GLOBAL_OPTIONS = ["debug", "help", "version"];

type Values = Partial<Record<keyof typeof OPTIONS, string | boolean>>;

function text(values: Values, key: "schema" | "out" | "dir" | "name" | "runtime-import", fallback?: string): string {
  const value = values[key];
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw new ConfigError(`Missing --${key}`);
}

function readSchema(values: Values, io: CliIO): SchemaIR {
  const typed = text(values, "schema", "./schema.orm");
  let source: string;
  try {
    source = readFileSync(resolve(io.cwd, typed), "utf8");
  } catch (cause) {
    throw new ConfigError("Unable to read the schema file", { cause });
  }
  return loadSchema(source, { file: typed });
}

function generate(values: Values, io: CliIO): void {
  const schema = readSchema(values, io);
  const out = text(values, "out", "./generated");
  const runtimeImport = text(values, "runtime-import", "mini-orm");
  const files = generateClient(schema, { runtimeImport });
  const target = resolve(io.cwd, out);
  try {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "index.js"), files["index.js"]);
    writeFileSync(join(target, "index.d.ts"), files["index.d.ts"]);
  } catch (cause) {
    throw new ConfigError("Unable to write the generated files", { cause });
  }
  io.stdout(`generated 2 files in ${out}`);
}

function report(result: MigrateResult, io: CliIO): void {
  if (result.created !== null) io.stdout(`created ${result.created}`);
  if (result.applied.length > 0) io.stdout(`applied ${result.applied.join(", ")}`);
  if (result.upToDate) io.stdout("database is up to date");
}

async function migrateCommand(values: Values, reset: boolean, io: CliIO): Promise<void> {
  if (reset && values.force !== true) throw new ConfigError("Refusing to reset without --force");
  const schema = readSchema(values, io);
  if (schema.provider !== "sqlite") throw new ConfigError(`Provider ${schema.provider} is not supported yet`);
  const url = Object.hasOwn(io.env, schema.urlEnv) ? io.env[schema.urlEnv] : undefined;
  if (url === undefined || url === "") throw new ConfigError(`Missing database URL (set ${safePath(schema.urlEnv)})`);
  const dir = resolve(io.cwd, text(values, "dir", "./migrations"));
  const adapter = createSqliteAdapter({ url });
  try {
    if (reset) {
      report(await resetDatabase({ schema, adapter, dir, force: true, env: io.env }), io);
    } else {
      const name = typeof values.name === "string" ? values.name : undefined;
      report(await migrate(name === undefined ? { schema, adapter, dir } : { schema, adapter, dir, name }), io);
    }
  } finally {
    await adapter.close();
  }
}

function version(): string {
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

function printError(err: unknown, file: string, debug: boolean, io: CliIO): number {
  if (err instanceof OrmError) {
    io.stderr(`error: ${err.message}`);
    if (err instanceof SchemaError) {
      for (const d of err.diagnostics) io.stderr(`${file}:${String(d.line)}:${String(d.column)} ${d.message}`);
    }
    if (debug && err.debug !== undefined) {
      const { cause } = err.debug;
      if (cause instanceof Error) io.stderr(`debug: ${cause.name}: ${cause.message}`);
    }
    return 1;
  }
  io.stderr("error: unexpected failure (re-run with --debug)");
  if (debug && err instanceof Error) io.stderr(`debug: ${err.name}: ${err.message}`);
  return 2;
}

/** Runs the CLI and returns the exit code; never exits the process itself. */
export async function run(argv: readonly string[], io: CliIO): Promise<number> {
  let debug = argv.includes("--debug");
  let file = "";
  try {
    const parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
    const values: Values = parsed.values;
    debug = values.debug === true;
    file = typeof values.schema === "string" ? values.schema : "./schema.orm";
    if (values.help === true) {
      for (const line of HELP) io.stdout(line);
      return 0;
    }
    if (values.version === true) {
      io.stdout(version());
      return 0;
    }
    const command = parsed.positionals.join(" ");
    const allowed = COMMAND_OPTIONS.get(command);
    if (allowed === undefined) {
      for (const line of HELP) io.stderr(line);
      return 1;
    }
    for (const key of Object.keys(values)) {
      if (!allowed.includes(key) && !GLOBAL_OPTIONS.includes(key)) {
        throw new ConfigError(`Option --${safePath(key)} is not valid for ${command}`);
      }
    }
    if (command === "generate") generate(values, io);
    else await migrateCommand(values, command === "migrate reset", io);
    return 0;
  } catch (err) {
    if (err instanceof Error && "code" in err && String(err.code).startsWith("ERR_PARSE_ARGS")) {
      io.stderr("error: invalid arguments");
      for (const line of HELP) io.stderr(line);
      return 1;
    }
    return printError(err, file, debug, io);
  }
}
