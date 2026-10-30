import { expectTypeOf } from "vitest";
import type { JsonValue } from "../../src/index.js";
import type { DbClient, Role, UserScalars } from "../fixtures/generated/blog/index.js";

declare const db: DbClient;

// Type tests are only type-checked, never run: these stand in for `[0]!` and `!`.
declare function first<T>(rows: readonly T[]): T;
declare function present<T>(value: T | null): T;

it("infers select payloads", async () => {
  const users = await db.user.findMany({ select: { id: true, email: true } });
  expectTypeOf(users).toEqualTypeOf<{ id: number; email: string }[]>();
});

it("infers include payloads", async () => {
  const u = await db.user.findUnique({ where: { email: "a" }, include: { posts: true } });
  expectTypeOf(u).toExtend<{
    email: string;
    role: Role;
    posts: { title: string; views: bigint; rating: string | null; updatedAt: Date }[];
  } | null>();
  const p = await db.post.findFirst({ include: { author: true } });
  expectTypeOf(present(p).author.email).toEqualTypeOf<string>();
});

it("infers nested include and select payloads", async () => {
  const posts = await db.post.findMany({ include: { author: { select: { email: true } } } });
  expectTypeOf(first(posts).author).toEqualTypeOf<{ email: string }>();
  const users = await db.user.findMany({
    select: { id: true },
  });
  expectTypeOf(first(users)).not.toHaveProperty("email");
  const withPosts = await db.user.findMany({
    include: { posts: { where: { published: true }, orderBy: { id: "desc" }, include: { author: true } } },
  });
  expectTypeOf(first(first(withPosts).posts).author.role).toEqualTypeOf<Role>();
});

it("maps scalar types", async () => {
  const p = first(await db.post.findMany());
  expectTypeOf(p.meta).toEqualTypeOf<JsonValue | null>();
  expectTypeOf(p.cover).toEqualTypeOf<Uint8Array | null>();
  expectTypeOf(p.views).toEqualTypeOf<bigint>();
  expectTypeOf(p.rating).toEqualTypeOf<string | null>();
  expectTypeOf(p.updatedAt).toEqualTypeOf<Date>();
  expectTypeOf(p.published).toEqualTypeOf<boolean>();
  const u = first(await db.user.findMany());
  expectTypeOf(u.role).toEqualTypeOf<"USER" | "ADMIN">();
  expectTypeOf(u.name).toEqualTypeOf<string | null>();
  expectTypeOf(u).not.toHaveProperty("posts");
});

it("accepts valid arguments", () => {
  void db.user.findMany({
    where: { email: { contains: "a" }, name: null, role: { in: ["USER"] }, OR: [{ id: { gt: 1 } }, { NOT: { id: 2 } }] },
    orderBy: [{ id: "asc" }, { email: "desc" }],
    take: 10,
    skip: 0,
  });
  void db.user.findMany({ where: { posts: { some: { views: { gte: 1n } } } } });
  void db.post.findMany({ where: { author: { is: { email: "a" } }, AND: { published: false } } });
  void db.post.create({ data: { title: "t", authorId: 1, views: 2, meta: { a: [1, "x", null] } } });
  void db.post.create({ data: { title: "t", author: { connect: { email: "a" } } }, select: { id: true } });
  void db.post.createMany({ data: [{ title: "t", authorId: 1 }] });
  void db.post.update({ where: { id: 1 }, data: { author: { connect: { id: 2 } } } });
  void db.post.updateMany({ where: {}, data: { published: true } });
  void db.user.upsert({ where: { email: "a" }, create: { email: "a" }, update: { name: null } });
  void db.user.delete({ where: { id: 1 }, include: { posts: true } });
  void db.user.count({ where: { role: "ADMIN" }, orderBy: { id: "asc" }, take: 1, skip: 1 });
});

it("rejects invalid arguments at compile time", () => {
  // @ts-expect-error unknown field
  void db.user.findMany({ where: { passwrd: "x" } });
  // @ts-expect-error unknown field next to a valid one
  void db.user.findMany({ where: { id: 1, passwrd: "x" } });
  // @ts-expect-error wrong type
  void db.user.findMany({ where: { id: "1" } });
  // @ts-expect-error findUnique needs a unique field
  void db.user.findUnique({ where: { name: "x" } });
  // @ts-expect-error findUnique takes exactly one criterion
  void db.user.findUnique({ where: { id: 1, email: "a" } });
  // @ts-expect-error select and include together
  void db.user.findMany({ select: { id: true }, include: { posts: true } });
  // @ts-expect-error missing required relation
  void db.post.create({ data: { title: "t" } });
  // @ts-expect-error foreign key and connect together
  void db.post.create({ data: { title: "t", authorId: 1, author: { connect: { id: 1 } } } });
  // @ts-expect-error connect is not supported in createMany
  void db.post.createMany({ data: [{ title: "t", author: { connect: { id: 1 } } }] });
  // @ts-expect-error autoincrement ids cannot be set
  void db.user.create({ data: { id: 1, email: "a" } });
  // @ts-expect-error the id cannot be modified
  void db.user.update({ where: { id: 1 }, data: { id: 2 } });
  // @ts-expect-error contains only applies to strings
  void db.user.findMany({ where: { id: { contains: 1 } } });
  // @ts-expect-error lt does not apply to enums
  void db.user.findMany({ where: { role: { lt: "USER" } } });
  // @ts-expect-error Json fields cannot be filtered
  void db.post.findMany({ where: { meta: { equals: 1 } } });
  // @ts-expect-error Decimal fields cannot be ordered by
  void db.post.findMany({ orderBy: { rating: "asc" } });
  // @ts-expect-error orderBy objects take exactly one key
  void db.post.findMany({ orderBy: { id: "asc", title: "desc" } });
  // @ts-expect-error relations cannot be selected
  void db.user.findMany({ select: { posts: true } });
  // @ts-expect-error where only applies to to-many includes
  void db.post.findMany({ include: { author: { where: { id: 1 } } } });
  // @ts-expect-error count does not take select
  void db.user.count({ select: { id: true } });
  // @ts-expect-error non-nullable field
  void db.user.create({ data: { email: null } });
  // @ts-expect-error deleteMany requires where
  void db.user.deleteMany({});
  // @ts-expect-error updateMany requires where
  void db.user.updateMany({ data: { name: "x" } });
});

it("types count and batch results", async () => {
  expectTypeOf(await db.user.count()).toEqualTypeOf<number>();
  expectTypeOf(await db.user.deleteMany({ where: {} })).toEqualTypeOf<{ count: number }>();
  expectTypeOf(await db.post.createMany({ data: [{ title: "t", authorId: 1 }] })).toEqualTypeOf<{ count: number }>();
  expectTypeOf(await db.user.findFirst()).toEqualTypeOf<UserScalars | null>();
});

it("types transactions with delegates only", async () => {
  const n = await db.$transaction(async (tx) => {
    expectTypeOf(tx).not.toHaveProperty("$transaction");
    expectTypeOf(tx).not.toHaveProperty("$disconnect");
    return tx.user.count();
  });
  expectTypeOf(n).toEqualTypeOf<number>();
});
