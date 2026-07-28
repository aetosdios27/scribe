import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import * as cli from "./index.js";

const { isMainModule, main, version } = cli;

afterEach(() => vi.restoreAllMocks());

it("prints the packaged prerelease version", async () => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  expect(await main(["--version"])).toBe(0);
  expect(write).toHaveBeenCalledWith(`${version}\n`);
});

it("contains unexpected command failures without exposing an internal stack", async () => {
  const stderr = vi.fn();
  const runCliEntry = (cli as typeof cli & {
    runCliEntry?: (
      args: readonly string[],
      dependencies: { readonly stderr: (value: string) => void },
      execute: () => Promise<number>
    ) => Promise<number>;
  }).runCliEntry;

  expect(runCliEntry).toBeTypeOf("function");
  expect(await runCliEntry?.([], { stderr }, async () => {
    throw new Error("unexpected worker collapse");
  })).toBe(1);
  const output = stderr.mock.calls.join("\n");
  expect(output).toContain("unexpected worker collapse");
  expect(output).not.toContain("at ");
});

it("keeps heavyweight commands behind dynamic import boundaries", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");

  expect(source).not.toMatch(/^import .* from ["']\.\/studio\.js["'];$/mu);
  expect(source).not.toMatch(/^import .* from ["']\.\/init\.js["'];$/mu);
  expect(source).not.toMatch(/^import .* from ["']\.\/integrate\.js["'];$/mu);
  expect(source).not.toMatch(/^import .* from ["']@scribe-sdk\/mdx["'];$/mu);
  expect(source).toContain('await import("./studio.js")');
  expect(source).toContain('await import("./init.js")');
  expect(source).toContain('await import("./integrate.js")');
  expect(source).toContain('await import("@scribe-sdk/mdx")');
  expect(source).toMatch(/if \(command === "studio"\) \{\s+if \(rest\.includes\("--help"\).*?\}\s+const \{ runStudio \} = await import\("\.\/studio\.js"\)/su);
  expect(source).toMatch(/if \(command === "init"\) \{\s+if \(rest\.includes\("--help"\).*?\}\s+const \{ runInit \} = await import\("\.\/init\.js"\)/su);
  expect(source).toMatch(/if \(command === "integrate"\) \{\s+if \(rest\.includes\("--help"\).*?\}\s+const \{ runIntegrate \} = await import\("\.\/integrate\.js"\)/su);
});

it("prints readable help and succeeds", async () => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  expect(await main(["--help"])).toBe(0);
  const output = write.mock.calls.join("\n");
  expect(output).toContain("scribe <command> [options]");
  expect(output).toContain("init");
  expect(output).toContain("integrate");
  expect(output).toContain("validate");
  expect(output).toContain("studio");
  expect(output).toContain("scribe init --dry-run");
  expect(output).toContain("scribe validate ./content/article.mdx");
  expect(output).toContain("scribe studio ./content/article.mdx");
  expect(output).toContain("public alpha");
  expect(output).not.toContain("beta");
  expect(output).toContain("host-owned React site");
  expect(output).not.toContain("--host-css <file>] [--port 4317]");
});

it("prints focused help for every public command", async () => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  expect(await main(["validate", "--help"])).toBe(0);
  expect(write.mock.calls.join("\n")).toContain("scribe validate <article.mdx> [--strict]");
  expect(write.mock.calls.join("\n")).toContain("Examples");
  expect(write.mock.calls.join("\n")).not.toContain("scribe studio");

  write.mockClear();
  expect(await main(["init", "--help"])).toBe(0);
  expect(write.mock.calls.join("\n")).toContain("scribe init --with-assets");

  write.mockClear();
  expect(await main(["integrate", "--help"])).toBe(0);
  expect(write.mock.calls.join("\n")).toContain("scribe integrate --mode foundation");

  write.mockClear();
  expect(await main(["studio", "--help"])).toBe(0);
  expect(write.mock.calls.join("\n")).toContain("scribe studio <article.mdx> [options]");
});

it("uses status 2 when no command is supplied", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  expect(await main([])).toBe(2);
  expect(stderr.mock.calls.join("\n")).toContain("Run `scribe --help`");
  expect(stderr.mock.calls.join("\n")).not.toContain("three supported actions");
});

it("validates a file and reports unsupported languages as non-fatal warnings", async () => {
  const path = await fixture("```not-a-real-language\nhello\n```\n");
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  expect(await main(["validate", path])).toBe(0);
  expect(stderr.mock.calls.join("\n")).toContain('[warning SCB1003] Unsupported code language "not-a-real-language"; falling back to plaintext.');
  expect(stdout.mock.calls.join("\n")).toContain("Validation passed");
  expect(stdout.mock.calls.join("\n")).toContain("1 warning");
});

it("fails strict validation for unsupported languages without a stack trace", async () => {
  const path = await fixture("```not-a-real-language\nhello\n```\n");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  expect(await main(["validate", path, "--strict"])).toBe(1);
  const output = stderr.mock.calls.join("\n");
  expect(output).toContain("[error SCB1003]");
  expect(output).toContain("Validation failed");
  expect(output).toContain("Next");
  expect(output).toContain(`scribe validate ${JSON.stringify(path)} --strict`);
  expect(output).not.toContain("at async");
  expect(output).not.toMatch(/\u001b\[/u);
});

it("returns a nonzero status with actionable component diagnostics", async () => {
  const path = await fixture('<Callout variant="warnng">Typo</Callout>\n');
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  expect(await main(["validate", path])).toBe(1);
  expect(stderr.mock.calls.join("\n")).toContain(
    '[error SCB1101] Unknown Callout variant "warnng". Expected one of: note, insight, warning.'
  );
});

it("reports MDX syntax failures with a file position and no internal stack", async () => {
  const path = await fixture("<Callout>unfinished\n");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  expect(await main(["validate", path])).toBe(1);
  const output = stderr.mock.calls.join("\n");
  expect(output).toMatch(new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:1:\\d+ \\[error `, "u"));
  expect(output).toContain("Expected a closing tag");
  expect(output).not.toContain("node_modules");
});

it("reports unreadable input without exposing a stack", async () => {
  const path = join(tmpdir(), "scribe-missing-article.mdx");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  expect(await main(["validate", path])).toBe(1);
  const output = stderr.mock.calls.join("\n");
  expect(output).toContain(`${path} [error SCB0001]`);
  expect(output).not.toContain("at async");
});

it("explains the accepted syntax for malformed code metadata", async () => {
  const path = await fixture('```ts highlight=2\nconst ready = true\n```\n');
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  expect(await main(["validate", path])).toBe(1);
  expect(stderr.mock.calls.join("\n")).toContain(
    'Expected: filename="...", lineNumbers, highlight="1,3-5", focus="1,3-5", add="1,3-5", remove="1,3-5".'
  );
});

it("suggests the nearest valid command for invalid usage", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  expect(await main(["validte", "article.mdx"])).toBe(2);
  expect(stderr.mock.calls.join("\n")).toContain('Unknown command "validte". Did you mean "validate"?');
});

it("suggests the nearest valid option and keeps usage failures on status 2", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  expect(await main(["validate", "article.mdx", "--strct"])).toBe(2);
  expect(stderr.mock.calls.join("\n")).toContain('Unknown option "--strct". Did you mean "--strict"?');
  expect(stderr.mock.calls.join("\n")).toContain("scribe validate --help");
});

it("prefers project-relative paths in validation output", async () => {
  const path = await fixture("# Relative diagnostics\n");
  const stdout = vi.fn();

  expect(await main(["validate", "article.mdx"], { cwd: dirname(path), stdout })).toBe(0);
  expect(stdout.mock.calls.join("\n")).toContain("article.mdx");
  expect(stdout.mock.calls.join("\n")).not.toContain(path);
});

it("uses restrained ANSI only for an interactive terminal and respects NO_COLOR", async () => {
  const path = await fixture("# Color contract\n");
  const interactive = vi.fn();
  const noColor = vi.fn();

  expect(await main(["validate", path], { cwd: dirname(path), stdout: interactive, isTTY: true, env: {} })).toBe(0);
  expect(interactive.mock.calls.join("\n")).toMatch(/\u001b\[/u);

  expect(await main(["validate", path], { cwd: dirname(path), stdout: noColor, isTTY: true, env: { NO_COLOR: "1" } })).toBe(0);
  expect(noColor.mock.calls.join("\n")).not.toMatch(/\u001b\[/u);
});

it.each(["scribe", "scb"])("recognizes the symlinked %s binary as the entrypoint", (binary) => {
  const realpath = vi.fn((path: string) =>
    path.endsWith(`/${binary}`) ? "/package/dist/index.mjs" : path
  );

  expect(
    isMainModule(
      "file:///package/dist/index.mjs",
      `/consumer/node_modules/.bin/${binary}`,
      realpath
    )
  ).toBe(true);
});

async function fixture(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "scribe cli test "));
  const path = join(directory, "article.mdx");
  await writeFile(path, source);
  return path;
}
