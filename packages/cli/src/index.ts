#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compileScribeMdx } from "@scribe-sdk/mdx";

import { colorize, commandArgument, displayPath, suggestClosest, supportsColor } from "./cli-output.js";
import { initHelp, runInit } from "./init.js";
import { runStudio, studioHelp } from "./studio.js";

export const version = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version as string;

const help = `Scribe ${version} · public alpha

Technical-publishing structure and behavior for a host-owned React site.

Usage
  scribe <command> [options]

Commands
  init       Inspect and deliberately configure Scribe in the current React project.
  validate   Compile and validate one Markdown or MDX article.
  studio     Open the local, source-authoritative authoring Studio.

Examples
  scribe init --dry-run
  scribe validate ./content/article.mdx
  scribe studio ./content/article.mdx

Global options
  -h, --help       Show this help.
  -v, --version    Show the installed Scribe version.

Run \`scribe <command> --help\` for command options.
`;

const validateHelp = `Compile and validate one article through Scribe's production MDX pipeline.

Usage
  scribe validate <article.mdx> [--strict]

Examples
  scribe validate ./content/article.mdx
  scribe validate ./content/article.mdx --strict

Options
  --strict      Treat warnings, including plaintext language fallback, as errors.
  -h, --help    Show this command help.
`;

export interface MainDependencies {
  readonly cwd?: string;
  readonly stdout?: (value: string) => void;
  readonly stderr?: (value: string) => void;
  readonly isTTY?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  dependencies: MainDependencies = {}
): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = dependencies.stderr ?? ((value: string) => process.stderr.write(value));
  const color = supportsColor(
    dependencies.isTTY ?? process.stdout.isTTY === true,
    dependencies.env ?? process.env
  );
  if (args.includes("--version") || args.includes("-v")) {
    stdout(`${version}\n`);
    return 0;
  }
  if (args[0] === "--help" || args[0] === "-h") {
    stdout(help);
    return 0;
  }
  if (args.length === 0) {
    stderr("Expected a command. Run `scribe --help` for the three supported actions.\n");
    return 2;
  }

  const [command, ...rest] = args;
  if (command === "init") {
    if (rest.includes("--help") || rest.includes("-h")) {
      stdout(initHelp);
      return 0;
    }
    return runInit(rest, { version, cwd, stdout, stderr });
  }
  if (command === "studio") {
    if (rest.includes("--help") || rest.includes("-h")) {
      stdout(studioHelp);
      return 0;
    }
    return runStudio(rest, { cwd, stdout, stderr });
  }
  if (command !== "validate") {
    const suggestion = suggestClosest(String(command), ["init", "validate", "studio"]);
    stderr(`Unknown command "${String(command)}".${suggestion === undefined ? "" : ` Did you mean "${suggestion}"?`}\nRun \`scribe --help\` for the supported actions.\n`);
    return 2;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    stdout(validateHelp);
    return 0;
  }

  const strict = rest.includes("--strict");
  const unsupportedOptions = rest.filter((argument) => argument.startsWith("-") && argument !== "--strict");
  const paths = rest.filter((argument) => !argument.startsWith("-"));
  if (unsupportedOptions.length > 0 || paths.length !== 1) {
    const unknown = unsupportedOptions[0];
    const suggestion = unknown === undefined ? undefined : suggestClosest(unknown, ["--strict", "--help"]);
    const detail = unknown !== undefined
      ? `Unknown option "${unknown}".${suggestion === undefined ? "" : ` Did you mean "${suggestion}"?`}`
      : "Expected exactly one MDX file.";
    stderr(`${detail}\nRun \`scribe validate --help\` for accepted arguments.\n`);
    return 2;
  }

  return validate(paths[0] as string, strict, { cwd, stdout, stderr, color });
}

async function validate(
  inputPath: string,
  strict: boolean,
  output: Required<Pick<MainDependencies, "cwd" | "stdout" | "stderr">> & { readonly color: boolean }
): Promise<number> {
  const path = resolve(output.cwd, inputPath);
  const shownPath = displayPath(output.cwd, path);
  try {
    const source = await readFile(path, "utf8");
    const file = await compileScribeMdx({ path, value: source }, { strict });
    for (const message of file.messages) output.stderr(`${formatDiagnostic(shownPath, message, "warning")}\n`);
    const count = file.messages.length;
    output.stdout(`${colorize("Success", "success", output.color)}  Validation passed\n  ${shownPath}\n${count === 0 ? "" : `${colorize("Warning", "warning", output.color)}  ${count} warning${count === 1 ? "" : "s"} reported\n`}\n`);
    return 0;
  } catch (error) {
    output.stderr(`${formatDiagnostic(shownPath, error, "error")}\n${colorize("Error", "error", output.color)}  Validation failed\n  ${shownPath}\n\nNext\n  Fix the diagnostic above, then run \`scribe validate ${commandArgument(shownPath)}${strict ? " --strict" : ""}\` again.\n`);
    return 1;
  }
}

function formatDiagnostic(path: string, error: unknown, severity: "error" | "warning"): string {
  const diagnostic = error as {
    readonly line?: number;
    readonly column?: number;
    readonly reason?: string;
    readonly message?: string;
    readonly ruleId?: string;
  };
  const location = diagnostic.line === undefined
    ? path
    : `${path}:${diagnostic.line}:${diagnostic.column ?? 1}`;
  const code = diagnostic.ruleId ?? "SCB0001";
  const reason = diagnostic.reason ?? diagnostic.message ?? String(error);
  return `${location} [${severity} ${code}] ${singleLine(reason)}`;
}

function singleLine(value: string): string {
  return value.replace(/\s*\n\s*/gu, " ").trim();
}

export function isMainModule(
  moduleUrl: string,
  entryPath: string | undefined,
  realpath: (path: string) => string = realpathSync
): boolean {
  if (!entryPath) return false;

  try {
    return realpath(fileURLToPath(moduleUrl)) === realpath(entryPath);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
