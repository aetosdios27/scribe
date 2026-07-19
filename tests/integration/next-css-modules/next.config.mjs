import createMDX from "@next/mdx";
import { createScribeNextMdxOptions } from "@scribe-sdk/mdx/next";

const withMDX = createMDX({ options: createScribeNextMdxOptions() });

export default withMDX({
  output: "export",
  pageExtensions: ["js", "jsx", "md", "mdx", "ts", "tsx"]
});
