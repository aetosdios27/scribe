import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import * as ts from "typescript";

const root = process.cwd();
const packages = ["react", "styles", "mdx", "cli"] as const;

describe("release documentation", () => {
  it("ships the required public positioning and copyable integration path", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    expect(readme).toContain("Scribe is an open-source publishing SDK that turns ordinary Markdown, MDX, semantic HTML, and JSX into beautiful technical articles on websites you already own.");
    expect(readme).toContain("Just write. Scribe handles the rest.");
    expect(readme).toContain("developers who already own a React website built with Next.js or Vite");
    expect(readme).toContain("The first prerelease is tested against React 19.2.7, Next.js 16.2.10, Vite 8.1.3, and MDX 3.1.1.");
    expect(readme).toContain("bun add @scribe-sdk/react@alpha @scribe-sdk/styles@alpha @scribe-sdk/mdx@alpha");
    expect(readme).toContain('import "@scribe-sdk/styles/default.css"');
    expect(readme).toContain("createScribeNextMdxOptions");
    expect(readme).toContain("createScribeComponents");
    expect(readme).toContain("scb validate");
    expect(readme).toContain("SKILL.md");
    expect(readme).toContain("Licensed under Apache-2.0");
    expect(readme).toContain("https://github.com/aetosdios27/scribe/blob/main/examples/starter-article.mdx");
    expect(readme).toContain("https://github.com/aetosdios27/scribe/blob/main/examples/starter-diagram.svg");
    expect(readme).toContain("return <Publication>{children}</Publication>");
    expect(readme).toContain("npx scb validate ./content/article.mdx --strict");
    expect(readme).toContain("`0 1.25rem 3rem color-mix(in oklab, #000 12%, transparent)`");
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
    expect(skill).toContain("bunx scb validate path/to/article.mdx");
    expect(skill).toContain("bunx scb validate path/to/article.mdx --strict");
    expect(skill).toContain("npx scb validate path/to/article.mdx");
    expect(skill).not.toMatch(/^scb validate /mu);
    expect(skill.trim().split(/\s+/u).length).toBeGreaterThan(500);
    expect(skill.trim().split(/\s+/u).length).toBeLessThan(2_500);
    expect(skill.split("\n").length).toBeLessThan(500);
  });

  it("documents every supported publication token", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    for (const token of [
      "font-body", "font-heading", "font-code", "background", "foreground", "muted",
      "border", "accent", "surface", "surface-strong", "selection", "content-width",
      "wide-width", "radius", "gutter", "rule", "leading", "code-size", "shadow"
    ]) {
      expect(readme).toContain(`--scribe-${token}`);
    }
  });

  it("keeps JavaScript and TypeScript README examples syntactically valid", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    const blocks = [...readme.matchAll(/^```(js|ts|tsx)\n([\s\S]*?)^```$/gmu)];
    expect(blocks.length).toBeGreaterThan(5);

    for (const [index, match] of blocks.entries()) {
      const language = match[1];
      const source = match[2] ?? "";
      const result = ts.transpileModule(source, {
        fileName: `readme-${index}.${language}`,
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022
        },
        reportDiagnostics: true
      });
      const errors = result.diagnostics?.filter(({ category }) => category === ts.DiagnosticCategory.Error) ?? [];
      expect(errors.map(({ messageText }) => ts.flattenDiagnosticMessageText(messageText, "\n"))).toEqual([]);
    }
  });
});
