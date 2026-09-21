import js from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "spikes/**", "coverage/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["packages/*/test/**/*.ts"],
    ...vitest.configs.recommended,
  },
  prettier,
);
