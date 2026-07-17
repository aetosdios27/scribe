import { compile } from "@mdx-js/mdx";

import { createScribeMdxOptions } from "./options.js";
import type { ScribeCompiledMdx, ScribeMdxOptions, ScribeMdxSource } from "./types.js";

export { createScribeMdxOptions } from "./options.js";
export type { ScribeMdxOptions } from "./types.js";

export function compileScribeMdx(
  file: ScribeMdxSource,
  options: ScribeMdxOptions = {}
): Promise<ScribeCompiledMdx> {
  return compile(file as Parameters<typeof compile>[0], {
    ...createScribeMdxOptions(options),
    outputFormat: "program"
  });
}
