import type { MDXComponents } from "mdx/types";
import { createScribeComponents } from "@scribe/react";

export function useMDXComponents(): MDXComponents {
  return createScribeComponents();
}

