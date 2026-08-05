import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  acquireIntegrationLock,
  applyFileChanges,
  IntegrationLockError,
  manifestAndLockfilePaths,
  releaseIntegrationLock,
  restoreSnapshot,
  snapshotFiles,
  verifyIntegration
} from "./transaction.js";

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scribe-transaction-"));
  for (const [name, value] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), value);
  }
  return root;
}

it("acquires and releases a repository-scoped integration lock", async () => {
  const root = await project({ "package.json": "{}" });
  const lock = await acquireIntegrationLock(root);
  await expect(acquireIntegrationLock(root)).rejects.toBeInstanceOf(IntegrationLockError);
  await releaseIntegrationLock(lock);
  const second = await acquireIntegrationLock(root);
  expect(second).toBe(lock);
  await releaseIntegrationLock(second);
});

it("recovers a stale lock left by a dead process", async () => {
  const root = await project({});
  const lock = join(root, ".scribe-integrate.lock");
  await writeFile(lock, JSON.stringify({ pid: 999_999_999, startedAt: Date.now() }));
  await acquireIntegrationLock(root);
  await releaseIntegrationLock(lock);
});

it("snapshots existing and missing files and restores both", async () => {
  const root = await project({ "app/globals.css": "body { margin: 0; }", "package.json": "{}" });
  const snapshot = await snapshotFiles(root, ["app/globals.css", "mdx-components.tsx", "package.json"]);

  await applyFileChanges(root, [
    { path: "app/globals.css", content: "body { margin: 0; }\n@import \"x\";\n" },
    { path: "mdx-components.tsx", content: "export const C = 1;\n" }
  ]);

  const failures = await restoreSnapshot(root, snapshot, ["mdx-components.tsx"]);
  expect(failures).toEqual([]);
  expect(await readFile(join(root, "app/globals.css"), "utf8")).toBe("body { margin: 0; }");
  await expect(readFile(join(root, "mdx-components.tsx"), "utf8")).rejects.toThrow();
});

it("propagates unreadable snapshot paths instead of treating them as absent", async () => {
  const root = await project({});
  await mkdir(join(root, "app", "globals.css"), { recursive: true });
  await expect(snapshotFiles(root, ["app/globals.css"])).rejects.toThrow();
});

it("reports failures it could not restore", async () => {
  const root = await project({ "app/globals.css": "original" });
  const snapshot = await snapshotFiles(root, ["app/globals.css"]);
  await applyFileChanges(root, [{ path: "app/globals.css", content: "changed" }]);
  await rm(join(root, "app/globals.css"));
  await mkdir(join(root, "app/globals.css"));
  await writeFile(join(root, "app/globals.css", "blocked.tmp"), "blocked");
  const failures = await restoreSnapshot(root, snapshot, []);
  expect(failures).toEqual(["app/globals.css"]);
});

it("tracks created files during apply for later removal", async () => {
  const root = await project({ "package.json": "{}" });
  const applied = await applyFileChanges(root, [
    { path: "mdx-components.tsx", content: "export const C = 1;\n" }
  ]);
  expect(applied).toEqual([{ path: "mdx-components.tsx", created: true }]);
});

it("returns the manifest and manager lockfiles to snapshot", async () => {
  const root = await project({});
  const paths = manifestAndLockfilePaths(root, "bun");
  expect(paths).toContain(join(root, "package.json"));
  expect(paths).toContain(join(root, "bun.lock"));
  expect(manifestAndLockfilePaths(root, "npm")).toContain(join(root, "package-lock.json"));
});

it("verifies installed packages, the selected stylesheet, and written files", async () => {
  const root = await project({ "package.json": "{}" });
  await mkdir(join(root, "node_modules", "@scribe-sdk", "react"), { recursive: true });
  await writeFile(join(root, "node_modules", "@scribe-sdk", "react", "package.json"), JSON.stringify({ version: "0.1.0-alpha.8" }));
  await mkdir(join(root, "node_modules", "@scribe-sdk", "styles"), { recursive: true });
  await writeFile(join(root, "node_modules", "@scribe-sdk", "styles", "package.json"), JSON.stringify({ version: "0.1.0-alpha.8" }));
  await writeFile(join(root, "node_modules", "@scribe-sdk", "styles", "foundation.css"), "/* stylesheet */\n");
  await applyFileChanges(root, [{ path: "mdx-components.tsx", content: "export const C = 1;\n" }]);

  const clean = await verifyIntegration(root, {
    packages: [{ name: "@scribe-sdk/react", version: "0.1.0-alpha.8" }],
    stylesheetMode: "foundation",
    files: [{ path: "mdx-components.tsx", created: true }]
  });
  expect(clean).toEqual([]);

  const broken = await verifyIntegration(root, {
    packages: [{ name: "@scribe-sdk/react", version: "0.9.9" }],
    stylesheetMode: "tailwind",
    files: [{ path: "missing.tsx", created: true }]
  });
  expect(broken.join("\n")).toContain("expected 0.9.9");
  expect(broken.join("\n")).toContain("tailwind.css was not installed");
  expect(broken.join("\n")).toContain("missing.tsx was not written");
});

it("removes its temporary files and leaves only intended artifacts", async () => {
  const root = await project({ "package.json": "{}" });
  const applied = await applyFileChanges(root, [
    { path: "mdx-components.tsx", content: "export const C = 1;\n" }
  ]);
  await restoreSnapshot(root, await snapshotFiles(root, ["mdx-components.tsx"]), applied.filter((change) => change.created).map((change) => change.path));
  const entries = await readdir(root);
  expect(entries.filter((name) => name.includes(".scribe-") && name.endsWith(".tmp"))).toEqual([]);
});
