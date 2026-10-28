import { inspect } from "node:util";
import { ValidationError, LimitExceededError, DatabaseError, safePath } from "../../src/errors.js";

it("never exposes debug info through message, JSON or inspect", () => {
  const err = new ValidationError("Unknown field", "where.passwrd", { sql: "SELECT secret", params: ["hunter2"] });
  expect(err.code).toBe("VALIDATION");
  expect(err.message).toBe("Unknown field (at where.passwrd)");
  for (const s of [err.message, JSON.stringify(err), inspect(err)]) {
    expect(s).not.toContain("hunter2");
    expect(s).not.toContain("SELECT");
  }
  expect(err.debug?.params).toEqual(["hunter2"]);
});
it("LimitExceededError is a ValidationError with its own code", () => {
  const err = new LimitExceededError("maxTake", "take");
  expect(err).toBeInstanceOf(ValidationError);
  expect(err.code).toBe("LIMIT_EXCEEDED");
});
it("DatabaseError uses a generic message", () => {
  expect(new DatabaseError().message).toBe("Database operation failed");
});
it("safePath strips control characters and truncates", () => {
  expect(safePath("a\u0000b\nc")).toBe("abc");
  expect(safePath("x".repeat(100))).toBe("x".repeat(63) + "…");
});
