import { expect, it } from "vitest";

import {
  renderPanel,
  renderReceipt,
  renderReport,
  terminalPresentation
} from "./terminal-ui.js";

const plain = { color: false, columns: 80 } as const;

it("renders one stable Scribe panel without ANSI for noninteractive output", () => {
  expect(renderPanel({
    title: "Scribe Update",
    description: "0.1.0-alpha.10 → 0.1.0-beta",
    rows: [
      { label: "Manager", value: "bun" },
      { label: "Packages", value: "4 aligned", tone: "success" }
    ],
    footer: "No package files will be changed."
  }, plain)).toBe([
    "╭─ Scribe Update",
    "│ 0.1.0-alpha.10 → 0.1.0-beta",
    "│",
    "│ Manager   bun",
    "│ Packages  4 aligned",
    "│",
    "│ No package files will be changed.",
    "╰─",
    ""
  ].join("\n"));
});

it("stacks labels and values in narrow terminals", () => {
  const output = renderPanel({
    title: "Scribe Studio · New article",
    rows: [{ label: "Path", value: "content/blog/the-smallest-honest-redis-clone.mdx" }]
  }, { color: false, columns: 40 });

  expect(output).toContain("│ Path\n│   content/blog/the-smallest-honest-redis-clone.mdx");
});

it("renders sectioned reports and receipts with stable plain-text content", () => {
  const report = renderReport({
    title: "Scribe Integrate · Dry run",
    sections: [
      { title: "Detected", lines: ["Stack  Next.js, React"] },
      { title: "Warnings", lines: ["none"] }
    ],
    footer: "Review this plan."
  }, plain);

  expect(report).toContain("├─ Detected\n│ Stack  Next.js, React");
  expect(report).toContain("╰─ Review this plan.");
  expect(renderReceipt("success", "Article created", ["content/article.mdx"], plain))
    .toBe("✓ Article created\n  content/article.mdx\n");
});

it("honors NO_COLOR while retaining layout", () => {
  expect(terminalPresentation(true, { TERM: "xterm-256color", NO_COLOR: "1" }, 72))
    .toEqual({ color: false, columns: 72 });
  expect(renderReceipt("error", "Failed", [], { color: true, columns: 80 }))
    .toContain("\u001B[31m×\u001B[0m");
});
