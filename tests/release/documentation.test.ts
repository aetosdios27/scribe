import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const packages = ["react", "styles", "mdx", "cli"] as const;

describe("release documentation", () => {
  it("ships the required public positioning and copyable integration path", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    expect(readme).toContain("Scribe is an open-source publishing SDK that turns ordinary Markdown, MDX, semantic HTML, and JSX into beautiful technical articles on websites you already own.");
    expect(readme).toContain("Just write. Scribe handles the rest.");
    expect(readme).toContain("developers who already own a React website built with Next.js or Vite");
    expect(readme).toContain("Scribe is not a hosted blogging platform, CMS, website builder, rich-text editor, proprietary content format, collaboration service, or replacement for React, Next.js, MDX, routing, deployment, analytics, or content storage.");
    expect(readme).toContain("bunx @scribe-sdk/cli@beta integrate");
    expect(readme).toContain("npx @scribe-sdk/cli@beta integrate");
    expect(readme).toContain("SKILL.md");
    expect(readme).toContain("Licensed under Apache-2.0");
    expect(readme).not.toMatch(/\bnpx scribe\b/u);
    expect(readme).not.toContain("@latest");
    expect(readme).toContain("scribeit.dev/docs");
  });

  it("keeps every packaged skill and README generated from the canonical files", async () => {
    const canonicalReadme = await readFile(join(root, "README.md"), "utf8");
    const canonicalSkill = await readFile(join(root, "SKILL.md"), "utf8");
    for (const directory of packages) {
      expect(await readFile(join(root, "packages", directory, "README.md"), "utf8")).toBe(canonicalReadme);
      expect(await readFile(join(root, "packages", directory, "SKILL.md"), "utf8")).toBe(canonicalSkill);
    }
  });

  it("keeps the agent instructions concise and explicit about integration defects", async () => {
    const skill = await readFile(join(root, "SKILL.md"), "utf8");
    expect(skill).toContain("description: Use when integrating, authoring, converting, validating, or troubleshooting Scribe technical articles in React websites using Next.js or Vite, with content authored in Markdown, MDX, JSX, or semantic HTML.");
    expect(skill).toContain("Prefer ordinary Markdown and semantic HTML. Use Scribe-specific components only when richer semantics or metadata are genuinely required.");
    expect(skill).toContain("Treat unexpected integration workarounds as possible Scribe defects. Do not silently patch around them in the host application.");
    expect(skill).toContain("node_modules/@scribe-sdk/react/README.md");
    expect(skill).toContain("node_modules/@scribe-sdk/react/SKILL.md");
    expect(skill).toContain("Preserve the host’s existing MDX options and plugins.");
    expect(skill).toContain("Do not create a second MDX compilation pipeline.");
    expect(skill).toContain("Do not wrap an MDX article in a second `Publication`; the Scribe MDX component map already supplies the article boundary.");
    expect(skill).toContain("bunx scribe validate path/to/article.mdx");
    expect(skill).toContain("bunx scribe validate path/to/article.mdx --strict");
    expect(skill).toContain("npx --no-install scribe validate path/to/article.mdx");
    expect(skill).toContain("bunx scribe import <medium-export.zip> --dry-run");
    expect(skill).toContain("Use `scribe update` to resolve the aligned beta");
    expect(skill).toContain("There is no `scribe upgrade` command");
    expect(skill).not.toMatch(/^scribe validate /mu);
    expect(skill).not.toMatch(/\bscb\b/u);
    expect(skill.trim().split(/\s+/u).length).toBeGreaterThan(500);
    expect(skill.trim().split(/\s+/u).length).toBeLessThan(2_500);
    expect(skill.split("\n").length).toBeLessThan(500);
  });
});
