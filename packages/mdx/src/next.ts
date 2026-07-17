import type { ScribeMdxOptions, SerializableMdxOptions } from "./types.js";

export function createScribeNextMdxOptions(
  options: ScribeMdxOptions = {}
): SerializableMdxOptions {
  return {
    remarkPlugins: ["@scribe/mdx/remark"],
    rehypePlugins: [["@scribe/mdx/rehype", { strict: options.strict === true }]]
  };
}

