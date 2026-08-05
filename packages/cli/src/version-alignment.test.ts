import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { checkPackageAlignment, formatAlignmentDiagnostic } from "./version-alignment.js";

async function project(versions: Partial<Record<"cli" | "mdx" | "react" | "styles", string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scribe-alignment-"));
  for (const [name, version] of Object.entries(versions)) {
    if (version === undefined) continue;
    const directory = join(root, "node_modules", "@scribe-sdk", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: `@scribe-sdk/${name}`, version }));
  }
  return root;
}

it("reports aligned lockstep versions", async () => {
  const root = await project({ cli: "0.1.0-alpha.8", mdx: "0.1.0-alpha.8", react: "0.1.0-alpha.8", styles: "0.1.0-alpha.8" });
  const report = await checkPackageAlignment(root, "0.1.0-alpha.8");
  expect(report.aligned).toBe(true);
});

it("reports mismatched versions with every package listed", async () => {
  const root = await project({ cli: "0.4.0-alpha.1", mdx: "0.3.0-alpha.4", react: "0.3.0-alpha.4", styles: "0.3.0-alpha.4" });
  const report = await checkPackageAlignment(root, "0.4.0-alpha.1");
  expect(report.aligned).toBe(false);
  const diagnostic = formatAlignmentDiagnostic(report, "bun");
  expect(diagnostic).toContain("CLI       0.4.0-alpha.1");
  expect(diagnostic).toContain("MDX       0.3.0-alpha.4");
  expect(diagnostic).toContain("bun update @scribe-sdk/cli @scribe-sdk/mdx @scribe-sdk/react @scribe-sdk/styles");
});

it("uses the detected package manager in the remediation", async () => {
  const root = await project({ cli: "0.1.0-alpha.8", mdx: "0.1.0-alpha.7", react: "0.1.0-alpha.8", styles: "0.1.0-alpha.8" });
  const report = await checkPackageAlignment(root, "0.1.0-alpha.8");
  expect(formatAlignmentDiagnostic(report, "npm")).toContain("npm update @scribe-sdk/cli @scribe-sdk/mdx @scribe-sdk/react @scribe-sdk/styles");
});

it("is not aligned when a package is missing", async () => {
  const root = await project({ cli: "0.1.0-alpha.8", mdx: "0.1.0-alpha.8", react: "0.1.0-alpha.8" });
  const report = await checkPackageAlignment(root, "0.1.0-alpha.8");
  expect(report.aligned).toBe(false);
  expect(report.installed.find((entry) => entry.name === "styles")?.version).toBeUndefined();
});
