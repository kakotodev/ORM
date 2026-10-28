import { ValidationError } from "../../src/errors.js";
import { createTestClient } from "../helpers/db.js";

/** Values a JSON client (or untyped JS) could send where a scalar is expected. */
const OBJECT_VALUES: Record<string, unknown> = {
  "mongo-style operator": { $ne: null },
  "mongo-style where": { $where: "1==1" },
  "nested operator object": { equals: { $ne: null } },
  "array": ["a@x", "b@x"],
  "empty object": {},
  "function": () => "a@x",
  "symbol": Symbol("x"),
  "class instance": new (class Evil { email = "a@x"; })(),
  "object with toString": { toString: () => "a@x" },
  "boxed string": Object.assign(Object.create(String.prototype) as object, { valueOf: () => "a@x" }),
  "Map": new Map([["email", "a@x"]]),
};

describe.each(Object.entries(OBJECT_VALUES))("%s where a scalar is expected", (_name, value) => {
  it("is rejected in where, in create data and in update data", async () => {
    const db = await createTestClient();
    await db.user.create({ data: { email: "a@x" } });
    await expect(db.user.findMany({ where: { email: value } })).rejects.toBeInstanceOf(ValidationError);
    await expect(db.user.findUnique({ where: { email: value } })).rejects.toBeInstanceOf(ValidationError);
    await expect(db.user.create({ data: { email: value } })).rejects.toBeInstanceOf(ValidationError);
    await expect(db.user.update({ where: { id: 1 }, data: { email: value } })).rejects.toBeInstanceOf(ValidationError);
    await expect(db.user.deleteMany({ where: { email: { in: [value] } } })).rejects.toBeInstanceOf(ValidationError);
    expect(await db.user.count()).toBe(1); // nothing was matched, created or deleted
  });
});

describe("type confusion on other field types", () => {
  it("never coerces values", async () => {
    const db = await createTestClient();
    const bad: [string, Record<string, unknown>][] = [
      ["number as string", { email: 5 }],
      ["boolean as string", { email: true }],
      ["null on a required field", { email: null }],
      ["string as boolean", { email: "x", name: "n", role: "USER", createdAt: "2020-01-01" }],
      ["NaN date", { email: "x", createdAt: new Date(Number.NaN) }],
      ["string as enum", { email: "x", role: "ROOT" }],
    ];
    for (const [, data] of bad) await expect(db.user.create({ data })).rejects.toBeInstanceOf(ValidationError);
    const user = (await db.user.create({ data: { email: "ok" } })) as { id: number };
    const post = { title: "t", authorId: user.id };
    for (const extra of [{ published: "true" }, { published: 1 }, { views: 1.5 }, { views: "5" }, { rating: 1.5 }, { cover: [1, 2] }, { meta: new Date() }, { meta: () => 1 }]) {
      await expect(db.post.create({ data: { ...post, ...extra } })).rejects.toBeInstanceOf(ValidationError);
    }
    for (const where of [{ id: "1" }, { id: 1.5 }, { id: Number.NaN }, { id: Infinity }, { id: true }, { id: [1] }]) {
      await expect(db.user.findMany({ where })).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(db.user.findMany({ where: { email: undefined } })).rejects.toBeInstanceOf(ValidationError);
    expect(await db.post.count()).toBe(0);
  });

  it("rejects accessor properties without invoking them", async () => {
    const db = await createTestClient();
    let called = false;
    const where = {
      get email(): string {
        called = true;
        return "a@x";
      },
    };
    await expect(db.user.findMany({ where })).rejects.toBeInstanceOf(ValidationError);
    expect(called).toBe(false);
  });
});
