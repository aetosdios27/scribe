import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/next.ts", "src/remark.ts", "src/rehype.ts"],
  format: "esm",
  dts: true,
  clean: true,
  deps: {
    skipNodeModulesBundle: true
  }
});

