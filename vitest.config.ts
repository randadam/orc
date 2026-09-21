import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts"],
  },
  // Tests run against source, not dist, so `pnpm test` needs no prior `pnpm build`.
  resolve: {
    alias: {
      "@orc/sdk": pkg("sdk"),
      "@orc/runner": pkg("runner"),
      "@orc/pi": pkg("pi"),
    },
  },
});
