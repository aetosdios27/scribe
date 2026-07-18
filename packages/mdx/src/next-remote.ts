import { createScribeMdxOptions } from "./options.js";
import type { ScribeMdxOptions, ScribeMdxPipelineOptions } from "./types.js";
import type * as React from "react";

// next-mdx-remote@6 currently resolves @types/mdx through its global JSX
// contract. React 19 moved that contract to React.JSX, so this adapter bridges
// only the remote-MDX entry point without weakening consumer type checking.
declare global {
  namespace JSX {
    interface Element extends React.JSX.Element {}
    interface ElementClass extends React.JSX.ElementClass {}
    interface IntrinsicElements extends React.JSX.IntrinsicElements {}
  }
}

/** The framework-neutral subset consumed by next-mdx-remote/rsc's `options` prop. */
export interface ScribeRemoteMdxOptions {
  readonly mdxOptions: ScribeMdxPipelineOptions;
}

export function createScribeRemoteMdxOptions(
  options: ScribeMdxOptions = {}
): ScribeRemoteMdxOptions {
  return { mdxOptions: createScribeMdxOptions(options) };
}
