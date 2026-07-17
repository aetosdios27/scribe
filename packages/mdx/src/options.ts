import rehypeScribe from "./rehype.js";
import remarkScribe from "./remark.js";
import type { ScribeMdxOptions, ScribeMdxPipelineOptions } from "./types.js";

export function createScribeMdxOptions(
  options: ScribeMdxOptions = {}
): ScribeMdxPipelineOptions {
  return {
    remarkPlugins: [remarkScribe],
    rehypePlugins: [[rehypeScribe, options]]
  };
}
