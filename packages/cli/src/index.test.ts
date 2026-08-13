import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import * as cli from "./index.js";

const { isMainModule, main, version } = cli;

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("./studio.js");
  vi.doUnmock("./init.js");
  vi.doUnmock("./integrate.js");
  vi.doUnmock("./medium-import.js");
  vi.doUnmock("@scribe-sdk/mdx");
});

it("prints the packaged prerelease version", async () => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  expect(await main(["--version"])).toBe(0);
  expect(write).toHaveBeenCalledWith(`${version}\n`);
});

it("opens interactive Scribe surfaces with the inline {S} logo", async () => {
  const stdout = vi.fn();
  const cwd = await project({
    "package.json": JSON.stringify({ name: "plain-dir", private: true })
  });

  expect(await main([], {
    cwd,
    stdout,
    isTTY: true,
    env: { TERM: "xterm-256color" }
  })).toBe(0);
  expect(stdout.mock.calls.join("")).toContain("\u001B[94m╭──────────╮\u001B[0m");
  expect(stdout.mock.calls.join("")).toContain("\u001B[94m│   {S}    │\u001B[0m  Publishing SDK");
  expect(stdout.mock.calls.join("")).toContain("S C R I B E");

  stdout.mockClear();
  expect(await main(["studio", "--help"], {
    cwd,
    stdout,
    isTTY: true,
    env: { TERM: "xterm-256color" }
  })).toBe(0);
  expect(stdout.mock.calls.join("")).toContain("\u001B[94m│   {S}    │\u001B[0m  Publishing SDK");
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
  const loaded = new Set<string>();
  vi.resetModules();
  vi.doMock("./studio.js", () => {
    loaded.add("studio");
    return { runStudio: vi.fn() };
  });
  vi.doMock("./init.js", () => {
    loaded.add("init");
    return { runInit: vi.fn() };
  });
  vi.doMock("./studio-init.js", () => {
    loaded.add("studio-init");
    return { runStudioInit: vi.fn() };
  });
  vi.doMock("./integrate.js", () => {
    loaded.add("integrate");
    return { runIntegrate: vi.fn() };
  });
  vi.doMock("./medium-import.js", () => {
    loaded.add("import");
    return { runMediumImport: vi.fn() };
  });
  vi.doMock("./update.js", () => {
    loaded.add("update");
    return { runUpdate: vi.fn() };
  });
  vi.doMock("@scribe-sdk/mdx", () => {
    loaded.add("mdx");
    return { compileScribeMdx: vi.fn() };
  });

  await import("./index.js");
  expect(loaded).toEqual(new Set());

  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  expect(source).toContain('await import("./studio.js")');
  expect(source).toContain('await import("./init.js")');
  expect(source).toContain('await import("./studio-init.js")');
  expect(source).toContain('await import("./integrate.js")');
  expect(source).toContain('await import("./medium-import.js")');
  expect(source).toContain('await import("@scribe-sdk/mdx")');
  expect(source).toContain('await import("./update.js")');
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
  expect(output).toContain("import");
  expect(output).toContain("scribe init --dry-run");
  expect(output).toContain("scribe validate ./content/article.mdx");
  expect(output).toContain("scribe studio ./content/article.mdx");
  expect(output).toContain("scribe import ~/Downloads/medium-export.zip");
  expect(output).toContain("public beta");
  expect(output).toContain("@scribe-sdk/cli@beta");
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
  expect(await main(["import", "--help"])).toBe(0);
  expect(write.mock.calls.join("\n")).toContain("scribe import <medium-export.zip> [options]");

  write.mockClear();
  expect(await main(["studio", "--help"])).toBe(0);
  expect(write.mock.calls.join("\n")).toContain("scribe studio <article.mdx> [options]");

  write.mockClear();
  expect(await main(["studio", "init", "--help"])).toBe(0);
  expect(write.mock.calls.join("\n")).toContain("scribe studio init [options]");

  write.mockClear();
  expect(await main(["update", "--help"])).toBe(0);
  expect(write.mock.calls.join("\n")).toContain("scribe update [options]");
});

it("prints state-aware output and exits 0 when no command is supplied", async () => {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  const unsupported = await project({
    "package.json": JSON.stringify({ name: "plain-dir", private: true })
  });
  expect(await main([], { cwd: unsupported })).toBe(0);
  expect(stdout.mock.calls.join("\n")).toContain("No supported React project was found.");
  expect(stderr.mock.calls.join("\n")).not.toContain("Expected a command");

  stdout.mockClear();
  const unintegrated = await project({
    "package.json": JSON.stringify({ dependencies: { react: "19.2.7", next: "16.2.11" } })
  });
  expect(await main([], { cwd: unintegrated })).toBe(0);
  expect(stdout.mock.calls.join("\n")).toContain("Scribe is not integrated here.");
  expect(stdout.mock.calls.join("\n")).toContain("scribe integrate --dry-run");

  stdout.mockClear();
  const integrated = await project({
    "package.json": JSON.stringify({
      dependencies: {
        react: "19.2.7",
        next: "16.2.11",
        "@scribe-sdk/react": "0.1.0-alpha.2",
        "@scribe-sdk/styles": "0.1.0-alpha.2",
        "@scribe-sdk/mdx": "0.1.0-alpha.2"
      },
      devDependencies: { "@scribe-sdk/cli": "0.1.0-alpha.2" }
    }),
    "app/globals.css": "body { margin: 0; }\n@import \"@scribe-sdk/styles/default.css\";\n",
    "app/page.tsx": "export const page = () => <article className=\"prose\" />;\nimport { createScribeComponents } from \"@scribe-sdk/react\";\nexport const c = createScribeComponents;\n"
  });
  expect(await main([], { cwd: integrated })).toBe(0);
  expect(stdout.mock.calls.join("\n")).toContain("Project");
  expect(stdout.mock.calls.join("\n")).toContain("scribe validate <article>");
  expect(stdout.mock.calls.join("\n")).toContain("scribe studio <article>");
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
    '[error SCB1101] Unknown Callout variant "warnng". Expected one of: note, insight, warning, success, error.'
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

it("prints the scb deprecation notice only for scb command invocations", async () => {
  const scbStderr = vi.fn();
  expect(await cli.runCliMain(["init", "--help"], { cwd: await project({ "package.json": "{}" }), argv1: "/bin/scb", stderr: scbStderr, stdout: vi.fn() })).toBe(0);
  expect(scbStderr.mock.calls.join("\n")).toContain("prerelease compatibility alias");

  const scribeStderr = vi.fn();
  await cli.runCliMain(["init", "--help"], { cwd: await project({ "package.json": "{}" }), argv1: "/bin/scribe", stderr: scribeStderr, stdout: vi.fn() });
  expect(scribeStderr.mock.calls.join("\n")).not.toContain("compatibility alias");

  const versionStderr = vi.fn();
  await cli.runCliMain(["--version"], { cwd: await project({ "package.json": "{}" }), argv1: "/bin/scb", stderr: versionStderr, stdout: vi.fn() });
  expect(versionStderr.mock.calls.join("\n")).not.toContain("compatibility alias");

  const delegatedStderr = vi.fn();
  await cli.runCliMain(["--help"], { cwd: await project({ "package.json": "{}" }), argv1: "/bin/scb", env: { SCRIBE_DELEGATED: "1" }, stderr: delegatedStderr, stdout: vi.fn() });
  expect(delegatedStderr.mock.calls.join("\n")).not.toContain("compatibility alias");
});

it("delegates the full invocation from the global entry to the project-local CLI", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ dependencies: { react: "19.2.7", next: "16.2.11" } })
  });
  const localDirectory = join(cwd, "node_modules", "@scribe-sdk", "cli");
  await mkdir(join(localDirectory, "dist"), { recursive: true });
  await writeFile(join(localDirectory, "package.json"), JSON.stringify({
    name: "@scribe-sdk/cli",
    version: "7.7.7",
    bin: { scribe: "./dist/index.mjs" }
  }));
  const entry = join(localDirectory, "dist", "index.mjs");
  await writeFile(entry, [
    'import { writeFileSync } from "node:fs";',
    'import { resolve } from "node:path";',
    'writeFileSync(resolve(process.cwd(), "delegated.json"), JSON.stringify({',
    "  args: process.argv.slice(2),",
    "  marker: process.env.SCRIBE_DELEGATED_TO ?? null",
    "}));",
    ""
  ].join("\n"));

  const result = await cli.runCliMain(["--version"], { cwd, argv1: "/global/bin/scribe", stdout: vi.fn(), stderr: vi.fn() });
  expect(result).toBe(0);
  const record = JSON.parse(await readFile(join(cwd, "delegated.json"), "utf8")) as { args: string[]; marker: string | null };
  expect(record.args).toEqual(["--version"]);
  expect(record.marker).toBe(localDirectory);
});

it("reports a global and project-local CLI mismatch before using the local CLI", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ dependencies: { react: "19.2.7", next: "16.2.11" } })
  });
  const localDirectory = join(cwd, "node_modules", "@scribe-sdk", "cli");
  await mkdir(join(localDirectory, "dist"), { recursive: true });
  await writeFile(join(localDirectory, "package.json"), JSON.stringify({
    name: "@scribe-sdk/cli",
    version: "0.1.0-alpha.9",
    bin: { scribe: "./dist/index.mjs" }
  }));
  await writeFile(join(localDirectory, "dist", "index.mjs"), "");
  const stdout = vi.fn();

  expect(await cli.runCliMain([], {
    cwd,
    argv1: "/global/bin/scribe",
    stdout,
    stderr: vi.fn()
  })).toBe(0);

  const output = stdout.mock.calls.join("\n");
  expect(output).toContain("Scribe CLI resolution");
  expect(output).toContain(`${version}`);
  expect(output).toContain("0.1.0-alpha.9 (used)");
  expect(output).toContain("project-local CLI handles commands");
});

async function fixture(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "scribe cli test "));
  const path = join(directory, "article.mdx");
  await writeFile(path, source);
  return path;
}

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scribe cli project "));
  for (const [name, value] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), value);
  }
  return root;
}
