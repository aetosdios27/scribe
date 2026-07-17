import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./default.css", import.meta.url), "utf8");

describe("published CSS contract", () => {
  it("ships the scoped cascade and host-adaptive token surface", () => {
    expect(css).toContain("@layer scribe.reset, scribe.base, scribe.components, scribe.utilities;");
    expect(css).toContain("--scribe-font-body: var(--font-body, inherit)");
    expect(css).toContain("--scribe-background: var(--background, transparent)");
    expect(css).toContain("--scribe-content-width: 70ch");
    expect(css).toContain("container-type: inline-size");
  });

  it("covers flagship behavior and environment preferences", () => {
    for (const marker of [
      ".scribe-table-scroll",
      ".scribe-code-frame",
      ".scribe-banner",
      ".scribe-callout",
      ".scribe-figure",
      "prefers-color-scheme: dark",
      "prefers-reduced-motion: reduce",
      "@media print"
    ]) expect(css).toContain(marker);
  });

  it("does not introduce obvious global element selectors", () => {
    expect(css).not.toMatch(/^\s*(?:html|body|pre|table|button|img)\s*[{,]/gmu);
  });
});
