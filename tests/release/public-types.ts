import { createScribeComponents, type ScribeComponents } from "../../packages/react/src/index.js";

declare const existing: Readonly<Record<string, unknown>>;

const mapped: ScribeComponents = createScribeComponents({ components: existing });
void mapped;
