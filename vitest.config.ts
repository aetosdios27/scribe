import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@scribe-sdk/mdx": fileURLToPath(new URL("./packages/mdx/src/index.ts", import.meta.url))
    }
  },
  test: {
    exclude: [...configDefaults.exclude, "tests/browser/**", "tests/studio-browser/**", "tests/visual/**"]
  }
});
