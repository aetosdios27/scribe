import { expect, it } from "vitest";

import { renderScribeLogo } from "./brand.js";

it("renders the detailed Scribe mark and wordmark", () => {
  const logo = renderScribeLogo("0.1.0-beta", { color: false, detailed: true });

  expect(logo).toBe([
    "╭──────────╮  ",
    "│          │  S C R I B E",
    "│   {S}    │  Publishing SDK · 0.1.0-beta",
    "│          │  ",
    "╰──────────╯  ",
    ""
  ].join("\n"));
});

it("renders a compact mark for narrow or non-interactive output", () => {
  expect(renderScribeLogo("0.1.0-beta", { color: false, detailed: false }))
    .toBe("{S} Scribe · 0.1.0-beta\n");
});

it("colors only the Scribe mark", () => {
  const logo = renderScribeLogo("0.1.0-beta", { color: true, detailed: false });

  expect(logo).toBe("\u001B[94m{S}\u001B[0m Scribe · 0.1.0-beta\n");
});
