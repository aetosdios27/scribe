#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compileScribeMdx } from "@scribe/mdx";

export const version = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version as string;

const help = `Scribe ${version}

Validate technical articles through Scribe's production MDX compiler.

Usage:
  scb validate <article.mdx> [--strict]
  scb --help
  scb --version

Options:
  --strict    Treat warnings, including plaintext language fallbacks, as errors.
  -h, --help  Show this help.
  -v, --version  Show the installed Scribe version.
`;

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(help);
    return 0;
  }

  const [command, ...rest] = args;
  if (command !== "validate") {
    process.stderr.write(`Unknown command "${String(command)}". Run \`scb --help\` for usage.\n`);
    return 2;
  }

  const strict = rest.includes("--strict");
  const unsupportedOptions = rest.filter((argument) => argument.startsWith("-") && argument !== "--strict");
  const paths = rest.filter((argument) => !argument.startsWith("-"));
  if (unsupportedOptions.length > 0 || paths.length !== 1) {
    const detail = unsupportedOptions.length > 0
      ? `Unknown option "${unsupportedOptions[0]}".`
      : "Expected exactly one MDX file.";
    process.stderr.write(`${detail} Usage: scb validate <article.mdx> [--strict]\n`);
    return 2;
  }

  return validate(paths[0] as string, strict);
}

async function validate(inputPath: string, strict: boolean): Promise<number> {
  const path = resolve(inputPath);
  try {
    const source = await readFile(path, "utf8");
    const file = await compileScribeMdx({ path, value: source }, { strict });
    for (const message of file.messages) process.stderr.write(`${formatDiagnostic(path, message, "warning")}\n`);
    const count = file.messages.length;
    process.stdout.write(`Validated ${path}${count === 0 ? "." : ` with ${count} warning${count === 1 ? "" : "s"}.`}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${formatDiagnostic(path, error, "error")}\n`);
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
