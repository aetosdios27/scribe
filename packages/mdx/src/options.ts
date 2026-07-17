import type { CompileOptions } from "@mdx-js/mdx";

import rehypeScribe from "./rehype.js";
import remarkScribe from "./remark.js";
import type { ScribeMdxOptions } from "./types.js";

export function createScribeMdxOptions(
  options: ScribeMdxOptions = {}
): Pick<CompileOptions, "remarkPlugins" | "rehypePlugins"> {
  return {
    remarkPlugins: [remarkScribe],
    rehypePlugins: [[rehypeScribe, options]]
  };
}

