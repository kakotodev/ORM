import { readFileSync } from "node:fs";

// The path is a fixed fixture URL, not user input.
const raw = readFileSync(new URL("../fixtures/blog.orm", import.meta.url), "utf8");

export const BLOG_SCHEMA: string = raw.replace(/\r\n/g, "\n");

/** Prepends a sqlite datasource block to the given model declarations. */
export function minimalSchema(models: string): string {
  return `datasource db {\n  provider = "sqlite"\n  url      = env("DATABASE_URL")\n}\n\n${models}`;
}
