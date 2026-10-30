import { createSqliteAdapter } from "../../src/adapters/sqlite.js";
import { sqliteDialect } from "../../src/dialects/sqlite.js";
import { createRuntimeClient, type ClientOptions, type RuntimeClient, type RuntimeDelegate } from "../../src/runtime/client.js";
import { loadSchema } from "../../src/schema/index.js";
import { indexSchema } from "../../src/schema/ir.js";
import { BLOG_SCHEMA } from "./schemas.js";

/** A client typed with the given delegate names (the blog schema's by default). */
export type TestClient<D extends string = "user" | "post"> = RuntimeClient & Readonly<Record<D, RuntimeDelegate>>;

/** A client over a fresh in-memory SQLite database with the schema's tables already created. */
export async function createTestClient<D extends string = "user" | "post">(
  schemaSource: string = BLOG_SCHEMA,
  options: ClientOptions = {},
): Promise<TestClient<D>> {
  const schema = loadSchema(schemaSource);
  const adapter = createSqliteAdapter({ url: "file::memory:" });
  await adapter.executeScript(sqliteDialect.createTables(indexSchema(schema)));
  return createRuntimeClient(schema, { adapter, ...options }) as TestClient<D>;
}
