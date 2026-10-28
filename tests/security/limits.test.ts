import { LimitExceededError } from "../../src/errors.js";
import { createTestClient } from "../helpers/db.js";

describe("denial-of-service limits", () => {
  it("caps take, skip, in-list sizes, createMany and nesting by default", async () => {
    const db = await createTestClient();
    await expect(db.user.findMany({ take: 1001 })).rejects.toBeInstanceOf(LimitExceededError);
    await expect(db.user.findMany({ take: Number.MAX_SAFE_INTEGER })).rejects.toBeInstanceOf(LimitExceededError);
    await expect(db.user.findMany({ skip: 1_000_001 })).rejects.toBeInstanceOf(LimitExceededError);
    const big = Array.from({ length: 1001 }, (_, i) => i);
    await expect(db.user.findMany({ where: { id: { in: big } } })).rejects.toBeInstanceOf(LimitExceededError);
    await expect(db.user.findMany({ where: { id: { notIn: big } } })).rejects.toBeInstanceOf(LimitExceededError);
    const rows = Array.from({ length: 1001 }, (_, i) => ({ email: `u${String(i)}` }));
    await expect(db.user.createMany({ data: rows })).rejects.toBeInstanceOf(LimitExceededError);
    expect(await db.user.count()).toBe(0);
  });

  it("caps where depth and include depth", async () => {
    const db = await createTestClient();
    let where: Record<string, unknown> = { id: 1 };
    for (let i = 0; i < 6; i++) where = { NOT: where };
    await expect(db.user.findMany({ where })).rejects.toBeInstanceOf(LimitExceededError);
    let deep: Record<string, unknown> = { id: 1 };
    for (let i = 0; i < 1000; i++) deep = { AND: deep };
    await expect(db.user.findMany({ where: deep })).rejects.toBeInstanceOf(LimitExceededError);
    const include = { posts: { include: { author: { include: { posts: { include: { author: true } } } } } } };
    await expect(db.user.findMany({ include })).rejects.toBeInstanceOf(LimitExceededError);
  });

  it("caps string length, orderBy entries and total where terms", async () => {
    const db = await createTestClient(undefined, { limits: { maxStringLength: 10, maxOrderBy: 2, maxWhereTerms: 5 } });
    await expect(db.user.create({ data: { email: "x".repeat(11) } })).rejects.toThrow(/too long/);
    await expect(db.user.findMany({ where: { email: { contains: "x".repeat(11) } } })).rejects.toThrow(/too long/);
    await expect(db.user.findMany({ orderBy: [{ id: "asc" }, { id: "asc" }, { id: "asc" }] })).rejects.toBeInstanceOf(LimitExceededError);
    await expect(db.user.findMany({ where: { id: { in: [1, 2, 3, 4, 5, 6] } } })).rejects.toBeInstanceOf(LimitExceededError);
  });

  it("caps the rows a single read may return", async () => {
    const db = await createTestClient(undefined, { limits: { maxRows: 3 } });
    await db.user.createMany({ data: [{ email: "1" }, { email: "2" }, { email: "3" }, { email: "4" }] });
    await expect(db.user.findMany()).rejects.toBeInstanceOf(LimitExceededError);
    expect(await db.user.findMany({ take: 3 })).toHaveLength(3);
  });

  it("refuses limit overrides that would disable a limit", async () => {
    for (const bad of [Number.NaN, 0, -1, Infinity, 1.5, "10"]) {
      await expect(createTestClient(undefined, { limits: { maxTake: bad as number } })).rejects.toThrow(/positive integer/);
    }
    const db = await createTestClient(undefined, { limits: { maxTake: undefined } });
    await expect(db.user.findMany({ take: 1001 })).rejects.toBeInstanceOf(LimitExceededError);
  });
});
