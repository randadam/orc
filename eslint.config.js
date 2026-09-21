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
    rules: {
      ...vitest.configs.recommended.rules,
      // vitest's expect takes a message as its second argument; the plugin defaults to jest's one.
      "vitest/valid-expect": ["error", { maxArgs: 2 }],
    },
  },
  prettier,
);
