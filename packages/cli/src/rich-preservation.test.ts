import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, it } from "vitest";

import { acceptRichCandidate, createRichProjection } from "./rich-preservation.js";

const fixturePath = resolve("tests/fixtures/rich-preservation.mdx");

it("classifies unsafe MDX as ordered protected islands", async () => {
  const source = await readFile(fixturePath, "utf8");
  const projection = await createRichProjection(source);

  expect(projection.islands.map(({ kind }) => kind)).toEqual([
    "frontmatter",
    "mdxjsEsm",
    "mdxjsEsm",
    "mdxTextExpression",
    "mdxJsxTextElement",
    "mdxJsxFlowElement",
    "mdxJsxFlowElement",
    "mdxFlowExpression",
    "directive",
    "codeMetadata",
    "mdxJsxFlowElement"
  ]);
  expect(projection.islands.map(({ start, end }) => source.slice(start, end))).toEqual(
    projection.islands.map(({ raw }) => raw)
  );
  expect(projection.projectionMarkdown).toContain("Editable paragraph.");
  expect(projection.projectionMarkdown).toContain("| ready | editable GFM table |");
  expect(projection.projectionMarkdown).not.toContain("BenchmarkChart");
  expect(projection.projectionMarkdown.match(/<ScribeStudioProtectedIsland /gu)).toHaveLength(projection.islands.length);
});

it("accepts a safe paragraph edit and restores protected source byte-for-byte", async () => {
  const source = await readFile(fixturePath, "utf8");
  const projection = await createRichProjection(source);
  const candidate = projection.projectionMarkdown.replace("Editable paragraph.", "Edited **safely**.");
  const result = await acceptRichCandidate(projection, candidate, fixturePath);

  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.message);
  expect(result.markdown).toContain("Edited **safely**.");
  for (const island of projection.islands) {
    expect(result.markdown.slice(result.markdown.indexOf(island.raw), result.markdown.indexOf(island.raw) + island.raw.length)).toBe(island.raw);
  }
  const offsets = projection.islands.map(({ raw }) => result.markdown.indexOf(raw));
  expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
  expect(result.markdown).not.toContain("ScribeProtectedIsland");
});

it.each([
  ["missing", (value: string) => value.replace(/<ScribeStudioProtectedIsland[^>]+\/>\n*/u, "")],
  ["duplicated", (value: string) => {
    const marker = value.match(/<ScribeStudioProtectedIsland[^>]+\/>/u)?.[0] ?? "";
    return `${marker}\n${value}`;
  }],
  ["reordered", (value: string) => {
    const markers = [...value.matchAll(/<ScribeStudioProtectedIsland[^>]+\/>/gu)].map(([marker]) => marker);
    return value.replace(markers[0]!, "__FIRST__").replace(markers[1]!, markers[0]!).replace("__FIRST__", markers[1]!);
  }],
  ["modified", (value: string) => value.replace("scribe-protected-0001", "scribe-protected-tampered")]
])("rejects a %s protected placeholder without changing canonical Markdown", async (_case, mutate) => {
  const source = await readFile(fixturePath, "utf8");
  const projection = await createRichProjection(source);
  const result = await acceptRichCandidate(projection, mutate(projection.projectionMarkdown), fixturePath);

  expect(result).toMatchObject({ ok: false, markdown: source });
});

it("rejects a candidate that cannot compile and retains canonical Markdown", async () => {
  const source = await readFile(fixturePath, "utf8");
  const projection = await createRichProjection(source);
  const candidate = projection.projectionMarkdown.replace("Editable paragraph.", "Edited safely before compilation.");
  const result = await acceptRichCandidate(projection, candidate, fixturePath, async () => {
    throw new Error("forced compiler rejection");
  });

  expect(result).toMatchObject({
    ok: false,
    code: "SCB_RICH_COMPILE_FAILED",
    markdown: source
  });
});
