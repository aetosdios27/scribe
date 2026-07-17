import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.tsx"],
  format: "esm",
  dts: true,
  clean: true,
  deps: {
    skipNodeModulesBundle: true
  }
});

