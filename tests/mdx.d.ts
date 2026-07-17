declare module "*.mdx" {
  import type { ComponentType } from "react";

  const MDXContent: ComponentType<{ components?: object }>;

  export default MDXContent;
}
