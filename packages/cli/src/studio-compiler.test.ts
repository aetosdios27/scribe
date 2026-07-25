import { afterEach, expect, it } from "vitest";

import { StudioCompiler } from "./studio-compiler.js";

const compilers: StudioCompiler[] = [];
afterEach(async () => Promise.all(compilers.splice(0).map((compiler) => compiler.close())));

it("validates MDX in an isolated reusable worker", async () => {
  const compiler = new StudioCompiler();
  compilers.push(compiler);

  await expect(compiler.compile("/tmp/article.mdx", "# Valid\n")).resolves.toEqual([]);
  await expect(compiler.compile("/tmp/article.mdx", "<Callout>unfinished")).resolves.toEqual([
    expect.objectContaining({ severity: "error", line: 1 })
  ]);
});

it("keeps the caller event loop responsive while compilation runs", async () => {
  const compiler = new StudioCompiler();
  compilers.push(compiler);
  const compilation = compiler.compile("/tmp/long.mdx", `${"# Heading\n\nParagraph.\n\n".repeat(2_000)}`);
  let timerRan = false;
  await new Promise<void>((resolve) => setTimeout(() => {
    timerRan = true;
    resolve();
  }, 0));

  expect(timerRan).toBe(true);
  await expect(compilation).resolves.toEqual([]);
});

it("restarts after a worker failure without leaving requests pending", async () => {
  const compiler = new StudioCompiler("file:///definitely-missing-scribe-mdx.mjs");
  compilers.push(compiler);

  await expect(compiler.compile("/tmp/article.mdx", "# First\n")).rejects.toThrow();
  await expect(compiler.compile("/tmp/article.mdx", "# Second\n")).rejects.toThrow();
});

it("times out a stuck compiler worker instead of hanging the Studio transaction queue", async () => {
  const hangingModule = `data:text/javascript,${encodeURIComponent("export async function compileScribeMdx(){return new Promise(()=>{})}")}`;
  const compiler = new StudioCompiler(hangingModule, 25);
  compilers.push(compiler);

  await expect(compiler.compile("/tmp/article.mdx", "# Never returns\n")).rejects.toThrow("exceeded 25ms");
});
