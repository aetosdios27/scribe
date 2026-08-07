import {
  mkdir,
  mkdtemp,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  checkPackageAlignment,
  formatAlignmentDiagnostic,
  scribePackageDefinitions
} from "./version-alignment.js";

async function project(
  files: Record<string, string>
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scribe-alignment-"));
  for (const [name, value] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, value);
  }
  return root;
}

async function installScribeSet(
  root: string,
  version: string
): Promise<void> {
  for (const definition of scribePackageDefinitions) {
    const manifest = join(
      root,
      "node_modules",
      ...definition.name.split("/"),
      "package.json"
    );
    await mkdir(join(manifest, ".."), { recursive: true });
    await writeFile(
      manifest,
      JSON.stringify({
        name: definition.name,
        version
      })
    );
  }
}

it("resolves hoisted Scribe packages up to the package-manager root", async () => {
  const root = await project({
    "package.json": "{}",
    "apps/site/package.json": "{}"
  });
  await installScribeSet(root, "1.2.3");

  const report = await checkPackageAlignment(
    join(root, "apps", "site"),
    "1.2.3",
    root
  );

  expect(report.inspectable).toBe(true);
  expect(report.aligned).toBe(true);
  expect(
    report.installed.every((entry) => entry.status === "resolved")
  ).toBe(true);
});

it("distinguishes a missing package from an inspection failure", async () => {
  const root = await project({ "package.json": "{}" });

  const missing = await checkPackageAlignment(root, "1.2.3", root);
  expect(missing.inspectable).toBe(true);
  expect(missing.aligned).toBe(false);
  expect(
    missing.installed.every((entry) => entry.status === "missing")
  ).toBe(true);

  const brokenManifest = join(
    root,
    "node_modules",
    "@scribe-sdk",
    "react",
    "package.json"
  );
  await mkdir(join(brokenManifest, ".."), { recursive: true });
  await writeFile(brokenManifest, "{ nope");

  const broken = await checkPackageAlignment(root, "1.2.3", root);
  expect(broken.inspectable).toBe(false);
  expect(
    broken.installed.find(
      (entry) => entry.packageName === "@scribe-sdk/react"
    )?.status
  ).toBe("error");
});

it("does not recommend blind package mutation when inspection failed", async () => {
  const root = await project({
    "node_modules/@scribe-sdk/react/package.json": "{ nope"
  });

  const report = await checkPackageAlignment(root, "1.2.3", root);
  const diagnostic = formatAlignmentDiagnostic(report, "npm");

  expect(diagnostic).toContain("could not be verified");
  expect(diagnostic).toContain("inspection failed");
  expect(diagnostic).not.toContain("npm install");
});

it("reports exact version skew as unaligned", async () => {
  const root = await project({ "package.json": "{}" });
  await installScribeSet(root, "1.2.2");

  const report = await checkPackageAlignment(root, "1.2.3", root);

  expect(report.inspectable).toBe(true);
  expect(report.aligned).toBe(false);
  expect(formatAlignmentDiagnostic(report, "npm")).toContain(
    "Expected every Scribe package to resolve at 1.2.3"
  );
});

it("refuses a package-manager root that is not an ancestor", async () => {
  const app = await project({ "package.json": "{}" });
  const unrelated = await project({ "package.json": "{}" });

  await expect(
    checkPackageAlignment(app, "1.2.3", unrelated)
  ).rejects.toThrow(/outside package-manager root/u);
});
