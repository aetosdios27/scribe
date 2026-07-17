import { createScribeComponents } from "@scribe-sdk/react";
import type { ScribeComponents } from "@scribe-sdk/react";

export function useMDXComponents(): ScribeComponents {
  return createScribeComponents();
}
