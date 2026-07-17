import { createScribeComponents } from "@scribe/react";
import type { ScribeComponents } from "@scribe/react";

export function useMDXComponents(): ScribeComponents {
  return createScribeComponents();
}
