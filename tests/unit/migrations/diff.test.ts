import { diffSchemas } from "../../../src/migrations/diff.js";
import { checksum, migrationName } from "../../../src/migrations/files.js";
import { loadSchema } from "../../../src/schema/index.js";
import { BLOG_SCHEMA } from "../../helpers/schemas.js";

const base = loadSchema(BLOG_SCHEMA);
const withTag = loadSchema(BLOG_SCHEMA.replace("model Post {", "model Tag {\n id Int @id\n label String\n}\nmodel Post {"));

describe("diffSchemas", () => {
  it("detects no change", () => {
    expect(diffSchemas(base, base)).toEqual({ kind: "none" });
  });

  it("treats a first run as adding every model", () => {
    expect(diffSchemas(null, base)).toEqual({ kind: "additive", newModels: ["User", "Post"] });
  });

  it("accepts new models", () => {
    expect(diffSchemas(base, withTag)).toEqual({ kind: "additive", newModels: ["Tag"] });
  });

  it("allows new enums but needs no migration for them alone", () => {
    const next = loadSchema(`${BLOG_SCHEMA}\nenum Color {\n  RED\n}\n`);
    expect(diffSchemas(base, next)).toEqual({ kind: "none" });
  });

  it("accepts a back-relation list added to an existing model", () => {
    const next = loadSchema(
      BLOG_SCHEMA.replace("  posts     Post[]", "  posts     Post[]\n  comments  Comment[]") +
        "\nmodel Comment {\n  id Int @id\n  author User @relation(fields: [authorId], references: [id], onDelete: Cascade)\n  authorId Int\n}\n",
    );
    expect(diffSchemas(base, next)).toEqual({ kind: "additive", newModels: ["Comment"] });
  });

  it("refuses a new column on an existing model", () => {
    const changed = loadSchema(BLOG_SCHEMA.replace("name      String?", "name      String?\n  bio String?"));
    expect(diffSchemas(base, changed)).toMatchObject({ kind: "unsupported" });
  });

  it("refuses removed models and changed enums", () => {
    const noPost = loadSchema(BLOG_SCHEMA.replace(/model Post \{[\s\S]*$/, "").replace("  posts     Post[]\n", ""));
    expect(diffSchemas(base, noPost)).toMatchObject({ kind: "unsupported" });
    const enumChanged = loadSchema(BLOG_SCHEMA.replace("  ADMIN", "  ADMIN\n  GUEST"));
    expect(diffSchemas(base, enumChanged)).toMatchObject({ kind: "unsupported" });
  });
});

describe("migration files helpers", () => {
  it("checksum ignores CRLF vs LF", () => {
    expect(checksum("a\r\nb")).toBe(checksum("a\nb"));
    expect(checksum("a\nb")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("validates migration labels", () => {
    expect(() => migrationName(new Date(), "../evil")).toThrow();
    expect(() => migrationName(new Date(), "")).toThrow();
    expect(() => migrationName(new Date(), "A")).toThrow();
    expect(migrationName(new Date("2026-10-28T12:00:00Z"), "init")).toBe("20261028120000_init");
  });
});
