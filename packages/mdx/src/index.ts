import { compile } from "@mdx-js/mdx";
import type * as React from "react";

import { createScribeMdxOptions } from "./options.js";
import type { ScribeCompiledMdx, ScribeMdxOptions, ScribeMdxSource } from "./types.js";

// @types/mdx currently resolves JSX through the pre-React-19 global
// namespace. Scribe is React-specific, so importing the generic MDX entry
// supplies the same type-only bridge as the next-mdx-remote adapter.
declare global {
  namespace JSX {
    interface Element extends React.JSX.Element {}
    interface ElementClass extends React.JSX.ElementClass {}
    interface IntrinsicElements extends React.JSX.IntrinsicElements {}
  }
}

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
