import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bootstrap.ts", "src/engine.ts"],
  format: "esm",
  dts: false,
  clean: true,
  platform: "node",
  deps: {
    skipNodeModulesBundle: true
  }
});
