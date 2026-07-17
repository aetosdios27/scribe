import { readFile } from "node:fs/promises";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import * as mdxApi from "../../packages/mdx/src/index.js";
import * as nextApi from "../../packages/mdx/src/next.js";
import * as reactApi from "../../packages/react/src/index.js";

const root = process.cwd();

describe("published runtime exports", () => {
  it("freezes the React package runtime surface", () => {
    expect(Object.keys(reactApi).sort()).toEqual([
      "Banner",
      "Callout",
      "CodeFrame",
      "Figure",
      "Publication",
      "ScribeImage",
      "createScribeComponents"
    ]);
  });

  it("keeps compiler internals out of the MDX package root", () => {
    expect(Object.keys(mdxApi).sort()).toEqual([
      "compileScribeMdx",
      "createScribeMdxOptions"
    ]);
    expect(Object.keys(nextApi)).toEqual(["createScribeNextMdxOptions"]);
  });
});

describe("published type exports", () => {
  it("freezes the named React types", async () => {
    expect(await exportedTypeNames("packages/react/src/index.tsx")).toEqual([
      "BannerProps",
      "CalloutProps",
      "CalloutVariant",
      "CodeFrameProps",
      "CreateScribeComponentsOptions",
      "FigureProps",
      "PublicationProps",
      "ScribeComponents"
    ]);
  });

  it("keeps the MDX root type surface structural and small", async () => {
    expect(await exportedTypeNames("packages/mdx/src/index.ts")).toEqual([
      "ScribeMdxOptions"
    ]);
  });
});

async function exportedTypeNames(relativePath: string): Promise<string[]> {
  const sourceText = await readFile(join(root, relativePath), "utf8");
  const source = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.add(element.name.text);
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
    if (!exported) continue;
    if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name) {
      names.add(statement.name.text);
    }
  }

  return [...names].sort();
}
