import type { Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import type { VFile } from "vfile";

import { applyScribeFrontmatter } from "./frontmatter.js";

const remarkScribe: Plugin = function remarkScribe() {
  remarkGfm.call(this);
  remarkFrontmatter.call(this, ["yaml"]);

  return (tree, file) => {
    applyScribeFrontmatter(tree as Root, file as VFile);
  };
};

export default remarkScribe;
