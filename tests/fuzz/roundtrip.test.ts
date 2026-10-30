import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestClient, type TestClient } from "../helpers/db.js";
import { arbBigInt, arbDate, arbDecimal, arbHostileString, arbJson, numRuns } from "./arbitraries.js";

describe("round-trip through SQLite", () => {
  let db: TestClient;
  beforeAll(async () => {
    db = await createTestClient();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("values read back equal the values written", async () => {
    let counter = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          email: arbHostileString,
          name: fc.option(arbHostileString, { nil: null }),
          title: arbHostileString,
          views: arbBigInt,
          rating: arbDecimal,
          meta: arbJson,
          cover: fc.uint8Array({ maxLength: 256 }),
          updatedAt: arbDate,
          published: fc.boolean(),
        }),
        async ({ email, name, ...fields }) => {
          counter += 1;
          const uniqueEmail = `${String(counter)}:${email}`;
          const user = (await db.user.create({ data: { email: uniqueEmail, name } })) as { id: number };
          expect(await db.user.findUnique({ where: { id: user.id } })).toEqual({
            id: user.id,
            email: uniqueEmail,
            name,
            role: "USER",
            createdAt: expect.any(Date) as unknown,
          });
          const post = (await db.post.create({
            data: { ...fields, author: { connect: { id: user.id } } },
          })) as { id: number };
          expect(await db.post.findUnique({ where: { id: post.id } })).toEqual({
            id: post.id,
            ...fields,
            authorId: user.id,
          });
        },
      ),
      { numRuns: numRuns() },
    );
  });
});
