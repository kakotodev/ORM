import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateClient } from "../src/generator/client.js";
import { loadSchema } from "../src/schema/index.js";

// Regenerates the committed client fixtures from tests/fixtures/blog.orm. Paths are fixed, not user input.
/* eslint-disable security/detect-non-literal-fs-filename */
const fixtures = new URL("../tests/fixtures/", import.meta.url);
const outDir = new URL("generated/blog/", fixtures);
const source = readFileSync(new URL("blog.orm", fixtures), "utf8").replace(/\r\n/g, "\n");
const out = generateClient(loadSchema(source), { runtimeImport: "../../../../src/index.js" });

mkdirSync(outDir, { recursive: true });
for (const name of ["index.js", "index.d.ts"] as const) {
  writeFileSync(new URL(name, outDir), out[name], "utf8");
}
/* eslint-enable security/detect-non-literal-fs-filename */
console.log("Updated tests/fixtures/generated/blog");
