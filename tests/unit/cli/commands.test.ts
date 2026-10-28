import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type CliIO } from "../../../src/cli/commands.js";

const SCHEMA = `datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model User {
  id    Int    @id @default(autoincrement())
  email String @unique
}
`;

let tmp: string;
let schemaPath: string;
let io: CliIO & { out: string[]; err: string[] };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mini-orm-cli-"));
  schemaPath = join(tmp, "schema.orm");
  writeFileSync(schemaPath, SCHEMA);
  const out: string[] = [];
  const err: string[] = [];
  io = { out, err, stdout: (l) => out.push(l), stderr: (l) => err.push(l), env: {}, cwd: tmp };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const all = (): string => [...io.out, ...io.err].join("\n");

describe("mini-orm CLI", () => {
  it("generates the client files", async () => {
    expect(await run(["generate", "--schema", schemaPath, "--out", "gen"], io)).toBe(0);
    expect(existsSync(join(tmp, "gen", "index.d.ts"))).toBe(true);
    expect(existsSync(join(tmp, "gen", "index.js"))).toBe(true);
    expect(io.out.join("\n")).toContain("generated 2 files in gen");
  });

  it("honours --runtime-import", async () => {
    expect(await run(["generate", "--schema", schemaPath, "--out", "gen", "--runtime-import", "../rt.js"], io)).toBe(0);
    expect(readFileSync(join(tmp, "gen", "index.js"), "utf8")).toContain('"../rt.js"');
  });

  it("resolves default paths from io.cwd", async () => {
    expect(await run(["generate"], io)).toBe(0);
    expect(existsSync(join(tmp, "generated", "index.js"))).toBe(true);
  });

  it("prints schema diagnostics with positions and exits 1", async () => {
    writeFileSync(schemaPath, "model A { }");
    expect(await run(["generate", "--schema", schemaPath], io)).toBe(1);
    expect(io.err.join("\n")).toMatch(/schema\.orm:1:\d+ /);
    expect(io.err[0]).toMatch(/^error: /);
  });

  it("reports an unreadable schema without the absolute path", async () => {
    expect(await run(["generate", "--schema", "missing.orm"], io)).toBe(1);
    expect(all()).not.toContain(tmp);
  });

  it("migrates using the env URL and never prints it", async () => {
    io.env["DATABASE_URL"] = `file:${join(tmp, "dev.db")}`;
    expect(await run(["migrate", "--schema", schemaPath, "--dir", "migrations"], io)).toBe(0);
    expect(all()).not.toContain("dev.db");
    expect(all()).toMatch(/created \d{14}_init/);
    expect(readdirSync(join(tmp, "migrations")).length).toBeGreaterThan(0);
    io.out.length = 0;
    expect(await run(["migrate", "--schema", schemaPath, "--dir", "migrations"], io)).toBe(0);
    expect(io.out.join("\n")).toContain("database is up to date");
  });

  it("fails when the URL variable is not set", async () => {
    expect(await run(["migrate", "--schema", schemaPath, "--dir", "migrations"], io)).toBe(1);
    expect(io.err.join("\n")).toContain("DATABASE_URL");
  });

  it("refuses reset without --force", async () => {
    expect(await run(["migrate", "reset"], io)).toBe(1);
  });

  it("resets with --force", async () => {
    io.env["DATABASE_URL"] = `file:${join(tmp, "dev.db")}`;
    const args = ["--schema", schemaPath, "--dir", "migrations"];
    expect(await run(["migrate", ...args], io)).toBe(0);
    expect(await run(["migrate", "reset", "--force", ...args], io)).toBe(0);
    expect(all()).not.toContain("dev.db");
  });

  it("rejects unknown options", async () => {
    expect(await run(["generate", "--evil"], io)).toBe(1);
  });

  it("rejects options that do not belong to the command", async () => {
    expect(await run(["generate", "--force"], io)).toBe(1);
  });

  it("prints help on stderr for an unknown command", async () => {
    expect(await run(["nope"], io)).toBe(1);
    expect(io.err.join("\n")).toContain("Usage");
  });

  it("prints help and version", async () => {
    expect(await run(["--help"], io)).toBe(0);
    expect(io.out.join("\n")).toContain("Usage");
    io.out.length = 0;
    expect(await run(["--version"], io)).toBe(0);
    expect(io.out[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("hides debug details unless --debug is given", async () => {
    io.env["DATABASE_URL"] = `file:${join(tmp, "nodir", "x.db")}`;
    expect(await run(["migrate", "--schema", schemaPath, "--dir", "migrations"], io)).toBe(1);
    expect(io.err).toHaveLength(1);
    expect(all()).not.toContain("nodir");
  });
});
