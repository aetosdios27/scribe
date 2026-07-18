import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { isMainModule, main, version } from "./index.js";

afterEach(() => vi.restoreAllMocks());

it("prints the packaged prerelease version", async () => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  expect(await main(["--version"])).toBe(0);
  expect(write).toHaveBeenCalledWith(`${version}\n`);
});

it("prints readable help and succeeds", async () => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  expect(await main(["--help"])).toBe(0);
  expect(write.mock.calls.join("\n")).toContain("scb validate <article.mdx> [--strict]");
  expect(write.mock.calls.join("\n")).toContain("scb init [--dry-run]");
  expect(write.mock.calls.join("\n")).toContain("scb studio <article.mdx>");
  expect(write.mock.calls.join("\n")).toContain("public alpha");
  expect(write.mock.calls.join("\n")).not.toContain("beta");
  expect(write.mock.calls.join("\n")).toContain("host-owned React site");
});

it("uses status 2 when no command is supplied", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  expect(await main([])).toBe(2);
  expect(stderr.mock.calls.join("\n")).toContain("Expected a command");
});

it("validates a file and reports unsupported languages as non-fatal warnings", async () => {
  const path = await fixture("```not-a-real-language\nhello\n```\n");
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  expect(await main(["validate", path])).toBe(0);
  expect(stderr.mock.calls.join("\n")).toContain('[warning SCB1003] Unsupported code language "not-a-real-language"; falling back to plaintext.');
  expect(stdout.mock.calls.join("\n")).toContain(`Validated ${path} with 1 warning.`);
});

it("fails strict validation for unsupported languages without a stack trace", async () => {
  const path = await fixture("```not-a-real-language\nhello\n```\n");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  expect(await main(["validate", path, "--strict"])).toBe(1);
  const output = stderr.mock.calls.join("\n");
  expect(output).toContain("[error SCB1003]");
  expect(output).not.toContain("at async");
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

it("uses status 2 for invalid command usage", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  expect(await main(["inspect", "article.mdx"])).toBe(2);
  expect(stderr.mock.calls.join("\n")).toContain('Unknown command "inspect".');
});

it("prints command-specific init help", async () => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  expect(await main(["init", "--help"])).toBe(0);
  expect(write.mock.calls.join("\n")).toContain("scb init --mode foundation");
});

it("recognizes a symlinked installed binary as the entrypoint", () => {
  const realpath = vi.fn((path: string) =>
    path.endsWith("/scb") ? "/package/dist/index.mjs" : path
  );

  expect(
    isMainModule(
      "file:///package/dist/index.mjs",
      "/consumer/node_modules/.bin/scb",
      realpath
    )
  ).toBe(true);
});

async function fixture(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "scribe-cli-test-"));
  const path = join(directory, "article.mdx");
  await writeFile(path, source);
  return path;
}
