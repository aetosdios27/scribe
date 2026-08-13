import { constants } from "node:fs";
import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { contentConventions } from "./content-paths.js";
import { findSupportedProjectRoot } from "./launcher.js";
import { detectPackageManagerContext } from "./package-manager.js";
import { checkPackageAlignment } from "./version-alignment.js";
import type { ProjectInspection } from "./integrate.js";
import { renderPanel, type UiRow } from "./terminal-ui.js";

export interface BareCommandDependencies {
  readonly cwd: string;
  readonly version: string;
}

export async function bareStateOutput(dependencies: BareCommandDependencies): Promise<string> {
  const { cwd, version } = dependencies;
  const root = await findSupportedProjectRoot(cwd);
  if (root === undefined) {
    return renderPanel({
      title: "Scribe · Project status",
      description: "No supported React project was found.",
      rows: [
        { label: "Expected", value: "Next.js or Vite" },
        { label: "Help", value: "scribe --help" }
      ],
      footer: "Run Scribe from the project you want to inspect."
    });
  }

  let inspection;
  try {
    const { inspectProject } = await import("./integrate.js");
    inspection = await inspectProject(root);
  } catch {
    return renderPanel({
      title: "Scribe · Project status",
      description: "Project inspection failed.",
      rows: [{ label: "Diagnose", value: "scribe integrate --dry-run" }],
      footer: "No project files were changed."
    });
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
  return renderPanel({
    title: "Scribe · Project status",
    description: "Scribe is not integrated here.",
    rows: [
      { label: "Project", value: stackDescription(root) },
      { label: "Next", value: "scribe integrate --dry-run", tone: "brand" }
    ],
    footer: "Review the integration plan before changing the project."
  });
}

async function integratedOutput(root: string, version: string, inspection: ProjectInspection): Promise<string> {
  const { recommendStyleMode } = await import("./integrate.js");
  const mode = recommendStyleMode(inspection, undefined).mode;
  const content = await detectedContentDirectory(root);
  const packageRows = await packageVersionRows(root, version);
  return renderPanel({
    title: "Scribe · Project status",
    description: stackDescription(root),
    rows: [
      ...(mode === undefined ? [] : [{ label: "Mode", value: mode }]),
      ...(content === undefined ? [] : [{ label: "Content", value: content }]),
      { label: "CLI", value: version },
      { label: "Open", value: "scribe studio <article>" },
      { label: "Check", value: "scribe validate <article>" },
      { label: "Create", value: "scribe studio init" },
      ...packageRows
    ],
    footer: "Run `scribe update` to align the complete installation."
  });
}

async function packageVersionRows(root: string, version: string): Promise<UiRow[]> {
  try {
    const context = await detectPackageManagerContext(root);
    const report = await checkPackageAlignment(root, version, context.packageManagerRoot);
    if (report.aligned) {
      return [
        { label: "Manager", value: context.manager },
        { label: "Packages", value: `${version} (aligned)`, tone: "success" }
      ];
    }
    return [
      { label: "Packages", value: "version mismatch", tone: "error" },
      ...report.installed.map((entry) => ({
        label: entry.packageName,
        value: entry.status === "resolved" ? entry.version ?? "unknown" : entry.status,
        tone: entry.status === "resolved" && entry.version === version
          ? "default" as const
          : "warning" as const
      })),
      { label: "Repair", value: "scribe update", tone: "brand" }
    ];
  } catch (error) {
    return [{
      label: "Packages",
      value: `inspection failed — ${error instanceof Error ? error.message : String(error)}`,
      tone: "error"
    }];
  }
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
