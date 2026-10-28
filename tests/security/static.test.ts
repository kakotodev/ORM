import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";

const root = join(import.meta.dirname, "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("dynamic code", () => {
  it("never appears in src/", () => {
    const files = sources(join(root, "src"));
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const text = code(file);
      expect(text, file).not.toMatch(/\beval\s*\(/);
      expect(text, file).not.toMatch(/\bnew\s+Function\b/);
      expect(text, file).not.toMatch(/\bFunction\s*\(/);
      expect(text, file).not.toMatch(/\b(setTimeout|setInterval)\s*\(\s*["'`]/);
      expect(text, file).not.toMatch(/\bnode:vm\b|\bnode:child_process\b/);
    }
  });

  it("is forbidden by the lint configuration (checked on src/runtime/client.ts)", async () => {
    const eslint = new ESLint({ cwd: root });
    const config = (await eslint.calculateConfigForFile(join(root, "src", "runtime", "client.ts"))) as {
      rules: Record<string, unknown>;
    };
    for (const rule of ["no-eval", "no-implied-eval", "no-new-func"]) {
      const setting = config.rules[rule] as unknown[];
      expect(setting[0], rule).toBe(2); // "error"
    }
  });
});

describe("supply chain", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;

  it("has no runtime dependency", () => {
    expect(pkg["dependencies"] ?? {}).toEqual({});
    expect(pkg["peerDependencies"] ?? {}).toEqual({});
    expect(pkg["optionalDependencies"] ?? {}).toEqual({});
  });

  it("is not publishable and targets Node versions with node:sqlite", () => {
    expect(pkg["private"]).toBe(true);
    expect(pkg["engines"]).toEqual({ node: ">=22.13" });
  });

  it("audits dependencies in CI and updates them with Dependabot", () => {
    const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toContain("npm audit --audit-level=high");
    expect(readFileSync(join(root, ".github", "dependabot.yml"), "utf8")).toContain("package-ecosystem: npm");
  });
});
