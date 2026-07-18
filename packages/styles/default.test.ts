import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const defaultCss = readFileSync(new URL("./default.css", import.meta.url), "utf8");
const foundationCss = readFileSync(new URL("./foundation.css", import.meta.url), "utf8");
const tailwindCss = readFileSync(new URL("./tailwind.css", import.meta.url), "utf8");

describe("published CSS contract", () => {
  it("ships the scoped cascade and host-adaptive token surface", () => {
    expect(defaultCss).toContain('@import "./foundation.css";');
    expect(defaultCss).toContain("@layer scribe.reset, scribe.base, scribe.components, scribe.utilities;");
    expect(defaultCss).toContain("--scribe-font-body: var(--font-body, inherit)");
    expect(defaultCss).toContain("--scribe-background: var(--background, transparent)");
    expect(defaultCss).toContain("--scribe-content-width: 70ch");
    expect(defaultCss).toContain("container-type: inline-size");
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
    ]) expect(defaultCss).toContain(marker);
  });

  it("does not introduce obvious global element selectors", () => {
    for (const css of [foundationCss, defaultCss, tailwindCss]) {
      expect(css).not.toMatch(/^\s*(?:html|body|pre|table|button|img)\s*[{,]/gmu);
    }
  });

  it("keeps foundation structural without taking over host typography or width", () => {
    for (const marker of [
      ".scribe-table-scroll",
      ".scribe-code-frame",
      ".scribe-copy-button",
      ".scribe-heading-anchor",
      ".scribe-figure",
      "prefers-reduced-motion: reduce",
      "@media print"
    ]) expect(foundationCss).toContain(marker);

    expect(foundationCss).toContain("--scribe-body-size: inherit");
    expect(foundationCss).toContain("--scribe-leading: inherit");
    expect(foundationCss).toContain("--scribe-paragraph-spacing: inherit");
    expect(foundationCss).not.toMatch(/:where\(\.scribe\)\s*\{[^}]*grid-template-columns:/su);
    expect(foundationCss).not.toMatch(/:where\(\.scribe\)\s*\{[^}]*font-size:\s*clamp/su);
    expect(foundationCss).not.toMatch(/:where\(\.scribe p\)\s*\{[^}]*margin-block:/su);
    expect(foundationCss).not.toMatch(/:where\(\.scribe h1\)\s*\{[^}]*font-size:/su);
  });

  it("keeps Tailwind compatibility mechanical and host-typography neutral", () => {
    expect(tailwindCss).toContain('@import "./foundation.css";');
    expect(tailwindCss).toContain("Tailwind Typography owns prose typography");
    expect(tailwindCss).not.toMatch(/:where\(\.scribe\)\s*\{[^}]*font-size:/su);
    expect(tailwindCss).not.toMatch(/:where\(\.scribe p\)\s*\{[^}]*margin-block:/su);
  });
});
