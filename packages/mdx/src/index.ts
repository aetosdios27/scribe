import { compile } from "@mdx-js/mdx";

import { parseCodeMetadata } from "./code-meta.js";
import { createScribeMdxOptions } from "./options.js";
import type { ScribeMdxOptions } from "./types.js";

export { parseCodeMetadata } from "./code-meta.js";
export type {
  LineRange,
  MetadataIssue,
  ParsedCodeMetadata,
  ScribeCodeMetadata
} from "./code-meta.js";
export { createScribeMdxOptions } from "./options.js";
export type { ScribeMdxOptions, SerializableMdxOptions } from "./types.js";

export function compileScribeMdx(
  file: Parameters<typeof compile>[0],
  options: ScribeMdxOptions = {}
) {
  return compile(file, {
    ...createScribeMdxOptions(options),
    outputFormat: "program"
  });
}

void parseCodeMetadata;
