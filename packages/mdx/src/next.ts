import type { ScribeMdxOptions, SerializableMdxOptions } from "./types.js";

export function createScribeNextMdxOptions(
  options: ScribeMdxOptions = {}
): SerializableMdxOptions {
  return {
    remarkPlugins: ["@scribe-sdk/mdx/remark"],
    rehypePlugins: [["@scribe-sdk/mdx/rehype", { strict: options.strict === true }]]
  };
}

