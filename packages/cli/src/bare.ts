import { constants } from "node:fs";
import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { contentConventions } from "./content-paths.js";
import { findSupportedProjectRoot } from "./launcher.js";
import type { ProjectInspection } from "./integrate.js";

export interface BareCommandDependencies {
  readonly cwd: string;
  readonly version: string;
}

export async function bareStateOutput(dependencies: BareCommandDependencies): Promise<string> {
  const { cwd, version } = dependencies;
  const root = await findSupportedProjectRoot(cwd);
  if (root === undefined) {
    return "No supported React project was found.\n\nRun Scribe from a Next.js or Vite project,\nor use `scribe --help`.\n";
  }

  let inspection;
  try {
    const { inspectProject } = await import("./integrate.js");
    inspection = await inspectProject(root);
  } catch {
    return "Scribe could not inspect the project at this location.\nRun `scribe integrate --dry-run` for diagnostics.\n";
  }

  const integrated = inspection.hasScribeCompiler || inspection.hasScribeComponents;
  const runtimePresent = ["@scribe-sdk/react", "@scribe-sdk/styles", "@scribe-sdk/mdx"]
    .every((name) => inspection.packageNames.has(name));
  if (integrated && runtimePresent) {
    return integratedOutput(root, version, inspection);
  }
  return unintegratedOutput(root);
}

function unintegratedOutput(root: string): string {
  const stack = stackDescription(root);
  return [
    "Scribe",
    "",
    "Detected",
    `  Stack  ${stack}`,
    "",
    "Scribe is not integrated here.",
    "",
    "Inspect the integration plan:",
    "  scribe integrate --dry-run",
    ""
  ].join("\n");
}

async function integratedOutput(root: string, version: string, inspection: ProjectInspection): Promise<string> {
  const { recommendStyleMode } = await import("./integrate.js");
  const mode = recommendStyleMode(inspection, undefined).mode;
  const content = await detectedContentDirectory(root);
  const lines = [
    "Scribe",
    "",
    "Project",
    ...(mode === undefined ? [] : [`  Mode       ${mode}`]),
    ...(content === undefined ? [] : [`  Content    ${content}`]),
    `  CLI        ${version}`,
    "",
    "Commands",
    "  scribe studio <article>",
    "  scribe validate <article>",
    "  scribe import <medium-export.zip>",
    ""
  ];
  return lines.join("\n");
}

function stackDescription(root: string): string {
  try {
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      readonly dependencies?: Readonly<Record<string, string>>;
      readonly devDependencies?: Readonly<Record<string, string>>;
    };
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    const parts: string[] = [];
    if (dependencies.next !== undefined) parts.push(`Next.js ${majorOf(dependencies.next)}`);
    if (dependencies.vite !== undefined) parts.push(`Vite ${majorOf(dependencies.vite)}`);
    if (dependencies.react !== undefined) parts.push(`React ${majorOf(dependencies.react)}`);
    if (dependencies.tailwindcss !== undefined) parts.push(`Tailwind ${majorOf(dependencies.tailwindcss)}`);
    return parts.length > 0 ? parts.join(", ") : "React project";
  } catch {
    return "React project";
  }
}

function majorOf(specifier: string): string {
  const normalized = specifier.trim().replace(/^[\s<=>~^*]+/u, "");
  if (normalized === "") return "unknown";
  return normalized.split(/[.-]/u)[0] ?? "unknown";
}

async function detectedContentDirectory(root: string): Promise<string | undefined> {
  const detected: string[] = [];
  for (const convention of contentConventions) {
    const path = resolve(root, convention);
    try {
      await access(path, constants.F_OK);
      detected.push(convention);
    } catch {
      // Continue through conventions.
    }
  }
  return detected.length === 1 ? detected[0] : undefined;
}
