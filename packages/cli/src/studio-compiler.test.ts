import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { StudioCompiler } from "./studio-compiler.js";

const articlePath = join(tmpdir(), "article.mdx");
const longArticlePath = join(tmpdir(), "long.mdx");

const compilers: StudioCompiler[] = [];
afterEach(async () => Promise.all(compilers.splice(0).map((compiler) => compiler.close())));

it("validates MDX in an isolated reusable worker", async () => {
  const compiler = new StudioCompiler();
  compilers.push(compiler);

  await expect(compiler.compile(articlePath, "# Valid\n")).resolves.toEqual([]);
  await expect(compiler.compile(articlePath, "<Callout>unfinished")).resolves.toEqual([
    expect.objectContaining({ severity: "error", line: 1 })
  ]);
});

it("keeps the caller event loop responsive while compilation runs", async () => {
  const compiler = new StudioCompiler();
  compilers.push(compiler);
  const compilation = compiler.compile(longArticlePath, `${"# Heading\n\nParagraph.\n\n".repeat(2_000)}`);
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

  await expect(compiler.compile(articlePath, "# First\n")).rejects.toThrow();
  await expect(compiler.compile(articlePath, "# Second\n")).rejects.toThrow();
});

it("opens a cooldown circuit after repeated worker failures", async () => {
  const compiler = new StudioCompiler("file:///definitely-missing-scribe-mdx.mjs");
  compilers.push(compiler);

  await expect(compiler.compile(articlePath, "# First\n")).rejects.toThrow();
  await expect(compiler.compile(articlePath, "# Second\n")).rejects.toThrow();
  await expect(compiler.compile(articlePath, "# Third\n")).rejects.toThrow();
  await expect(compiler.compile(articlePath, "# Circuit open\n")).rejects.toThrow(
    "temporarily unavailable after repeated worker failures"
  );
});

it("starts with a fresh failure budget after the worker cooldown elapses", async () => {
  const compiler = new StudioCompiler("file:///definitely-missing-scribe-mdx.mjs");
  compilers.push(compiler);

  await expect(compiler.compile(articlePath, "# First\n")).rejects.toThrow();
  await expect(compiler.compile(articlePath, "# Second\n")).rejects.toThrow();
  await expect(compiler.compile(articlePath, "# Third\n")).rejects.toThrow();
  await new Promise((resolve) => setTimeout(resolve, StudioCompiler.failureCooldownMilliseconds + 25));
  await expect(compiler.compile(articlePath, "# Recovery attempt\n")).rejects.not.toThrow(
    "temporarily unavailable"
  );
  await expect(compiler.compile(articlePath, "# Fresh budget\n")).rejects.not.toThrow(
    "temporarily unavailable"
  );
});

it("maps fatal compiler messages to errors and non-fatal messages to warnings", async () => {
  const module = `data:text/javascript,${encodeURIComponent(`
    export async function compileScribeMdx() {
      return { messages: [
        { fatal: true, ruleId: "fatal-rule", reason: "Fatal message", line: 2, column: 3 },
        { fatal: false, ruleId: "warning-rule", reason: "Warning message", line: 4 }
      ] };
    }
  `)}`;
  const compiler = new StudioCompiler(module);
  compilers.push(compiler);

  await expect(compiler.compile(articlePath, "# Diagnostics\n")).resolves.toEqual([
    { severity: "error", code: "fatal-rule", message: "Fatal message", line: 2, column: 3 },
    { severity: "warning", code: "warning-rule", message: "Warning message", line: 4 }
  ]);
});

it.each([null, "primitive failure", 42])("normalizes a primitive compiler throw: %j", async (thrown) => {
  const module = `data:text/javascript,${encodeURIComponent(`
    export async function compileScribeMdx() {
      throw ${JSON.stringify(thrown)};
    }
  `)}`;
  const compiler = new StudioCompiler(module);
  compilers.push(compiler);

  await expect(compiler.compile(articlePath, "# Failure\n")).resolves.toEqual([
    {
      severity: "error",
      code: "SCB0001",
      message: String(thrown)
    }
  ]);
});

it("times out a stuck compiler worker instead of hanging the Studio transaction queue", async () => {
  const hangingModule = `data:text/javascript,${encodeURIComponent("export async function compileScribeMdx(){return new Promise(()=>{})}")}`;
  const compiler = new StudioCompiler(hangingModule, 25);
  compilers.push(compiler);

  await expect(compiler.compile(articlePath, "# Never returns\n")).rejects.toThrow("exceeded 25ms");
});
