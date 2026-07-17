import mdx from "@mdx-js/rollup";
import { createScribeMdxOptions } from "@scribe/mdx";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    { ...mdx(createScribeMdxOptions()), enforce: "pre" },
    react({ include: /\.(?:js|jsx|md|mdx|ts|tsx)$/u })
  ]
});
