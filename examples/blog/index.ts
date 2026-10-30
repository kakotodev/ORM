import { createClient } from "./generated/index.js";

const db = createClient();

try {
  const author = await db.user.create({ data: { email: `ada-${String(Date.now())}@example.com`, name: "Ada" } });
  await db.post.create({ data: { title: "Hello", author: { connect: { id: author.id } } } });
  await db.post.create({ data: { title: "Second post", author: { connect: { id: author.id } } } });

  const users = await db.user.findMany({
    where: { id: author.id },
    include: { posts: { orderBy: { id: "asc" } } },
  });
  console.log("user with posts:", JSON.stringify(users, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2));

  const updated = await db.user.update({ where: { id: author.id }, data: { name: "Ada Lovelace" } });
  console.log("updated name:", updated.name);

  const count = await db.$transaction(async (tx) => {
    await tx.post.updateMany({ where: { authorId: author.id }, data: { published: true } });
    return tx.post.count({ where: { authorId: author.id, published: true } });
  });
  console.log("published posts (transaction):", count);

  const injected = await db.user.findMany({ where: { email: "' OR 1=1 --" } });
  console.log("injection attempt returned", injected.length, "rows");
} finally {
  await db.$disconnect();
}
