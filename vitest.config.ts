import { defineConfig } from "vitest/config";

const strict = { lines: 90, functions: 90, branches: 90, statements: 90 };

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: true,
    pool: "forks",
    typecheck: { include: ["tests/types/**/*.test-d.ts"] },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The shebang entry point only forwards to src/cli/commands.ts, which is covered.
      exclude: ["src/cli/index.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        "src/runtime/**": strict,
        "src/dialects/**": strict,
      },
    },
  },
});
