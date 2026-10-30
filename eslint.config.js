import js from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";

export default tseslint.config(
  {
    ignores: ["dist/", "coverage/", "node_modules/", "tests/fixtures/generated/", "examples/**/generated/"],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  security.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "security/detect-object-injection": "off",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  {
    // Paths in the CLI, the migration files layer, scripts and tests come from flags or temp dirs by design.
    files: ["src/cli/**", "src/migrations/**", "scripts/**", "tests/**"],
    rules: { "security/detect-non-literal-fs-filename": "off" },
  },
  {
    // The example imports a generated client that is absent on a clean checkout; it is type-checked
    // by examples/tsconfig.json after generation (npm run example), not by the type-aware lint.
    files: ["examples/**/*.ts"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
