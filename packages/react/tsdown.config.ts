import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.tsx"],
  format: "esm",
  unbundle: true,
  dts: true,
  clean: true,
  deps: {
    skipNodeModulesBundle: true
  }
});
