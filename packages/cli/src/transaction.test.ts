import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  acquireIntegrationLock,
  applyFileChanges,
  captureExpectedFileState,
  FileStateConflictError,
  hashContent,
  IntegrationLockError,
  IntegrationLockOwnershipError,
  manifestAndLockfilePaths,
  releaseIntegrationLock,
  restoreSnapshot,
  snapshotFiles,
  verifyIntegration
} from "./transaction.js";

async function project(
  files: Record<string, string | Buffer>
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scribe-transaction-"));
  for (const [name, value] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, value);
  }
  return root;
}

it("acquires a repository lock and only its owner can release it", async () => {
  const root = await project({ "package.json": "{}" });
  const first = await acquireIntegrationLock(root);

  await expect(acquireIntegrationLock(root)).rejects.toBeInstanceOf(
    IntegrationLockError
  );

  await writeFile(
    first.path,
    JSON.stringify({
      pid: process.pid,
      startedAt: Date.now(),
      token: "different-owner"
    })
  );

  await expect(releaseIntegrationLock(first)).rejects.toBeInstanceOf(
    IntegrationLockOwnershipError
  );

  await rm(first.path, { force: true });
});

it("refuses to delete a malformed lock as if it were stale", async () => {
  const root = await project({
    ".scribe-integrate.lock": "{ definitely-not-json"
  });

  await expect(acquireIntegrationLock(root)).rejects.toMatchObject({
    name: "IntegrationLockError"
  });

  expect(await readFile(join(root, ".scribe-integrate.lock"), "utf8")).toBe(
    "{ definitely-not-json"
  );
});

it("recovers a well-formed stale lock whose process is dead", async () => {
  const root = await project({
    ".scribe-integrate.lock": JSON.stringify({
      pid: 999_999_999,
      startedAt: Date.now(),
      token: "dead-owner"
    })
  });

  const handle = await acquireIntegrationLock(root);
  expect(handle.token).not.toBe("dead-owner");
  await releaseIntegrationLock(handle);
});

it("snapshots and restores binary files byte-for-byte", async () => {
  const original = Buffer.from([
    0x00, 0xff, 0xfe, 0x80, 0x62, 0x75, 0x6e, 0x00, 0x01
  ]);
  const root = await project({ "bun.lockb": original });

  const snapshot = await snapshotFiles(root, ["bun.lockb"]);
  await writeFile(join(root, "bun.lockb"), Buffer.from([1, 2, 3, 4]));

  expect(await restoreSnapshot(root, snapshot)).toEqual([]);
  expect(await readFile(join(root, "bun.lockb"))).toEqual(original);
});

it("aborts when an existing file changed after planning", async () => {
  const root = await project({ "app/globals.css": "original\n" });
  const expected = await captureExpectedFileState(
    root,
    "app/globals.css"
  );

  await writeFile(join(root, "app/globals.css"), "user edit\n");

  await expect(
    applyFileChanges(root, [
      {
        path: "app/globals.css",
        content: "scribe edit\n",
        expected
      }
    ])
  ).rejects.toBeInstanceOf(FileStateConflictError);

  expect(await readFile(join(root, "app/globals.css"), "utf8")).toBe(
    "user edit\n"
  );
});

it("aborts when a planned-new file appears before apply", async () => {
  const root = await project({ "package.json": "{}" });
  const expected = await captureExpectedFileState(
    root,
    "mdx-components.tsx"
  );
  expect(expected).toEqual({ kind: "missing" });

  await writeFile(
    join(root, "mdx-components.tsx"),
    "export const UserFile = true;\n"
  );

  await expect(
    applyFileChanges(root, [
      {
        path: "mdx-components.tsx",
        content: "export const ScribeFile = true;\n",
        expected
      }
    ])
  ).rejects.toBeInstanceOf(FileStateConflictError);

  expect(
    await readFile(join(root, "mdx-components.tsx"), "utf8")
  ).toContain("UserFile");
});

it("rollback refuses to overwrite a file edited after Scribe wrote it", async () => {
  const root = await project({ "app/globals.css": "original\n" });
  const snapshot = await snapshotFiles(root, ["app/globals.css"]);
  const expected = await captureExpectedFileState(
    root,
    "app/globals.css"
  );

  const applied = await applyFileChanges(root, [
    {
      path: "app/globals.css",
      content: "scribe wrote this\n",
      expected
    }
  ]);

  await writeFile(
    join(root, "app/globals.css"),
    "user changed it afterwards\n"
  );

  expect(await restoreSnapshot(root, snapshot, applied)).toEqual([
    "app/globals.css"
  ]);
  expect(await readFile(join(root, "app/globals.css"), "utf8")).toBe(
    "user changed it afterwards\n"
  );
});

it("rejects transaction paths that escape the project root", async () => {
  const root = await project({ "package.json": "{}" });

  await expect(snapshotFiles(root, ["../outside.txt"])).rejects.toThrow(
    /escapes the project root|project-relative/u
  );

  await expect(
    captureExpectedFileState(root, join(tmpdir(), "absolute.txt"))
  ).rejects.toThrow(/project-relative/u);
});

it("verifies written content rather than merely checking file existence", async () => {
  const root = await project({
    "result.txt": "wrong contents",
    "node_modules/@scribe-sdk/react/package.json": JSON.stringify({
      name: "@scribe-sdk/react",
      version: "1.2.3"
    }),
    "node_modules/@scribe-sdk/styles/default.css": "/* styles */"
  });

  const problems = await verifyIntegration(root, {
    packages: [
      {
        name: "@scribe-sdk/react",
        version: "1.2.3",
        manifestPath: "node_modules/@scribe-sdk/react/package.json"
      }
    ],
    stylesheet: {
      packageDirectory: "node_modules/@scribe-sdk/styles",
      mode: "default"
    },
    files: [
      {
        path: "result.txt",
        expectedHash: hashContent("expected contents")
      }
    ]
  });

  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain(
    "does not contain the content Scribe wrote"
  );
});

it("returns root-relative manifest and lockfile paths for transaction snapshots", () => {
  expect(manifestAndLockfilePaths("apps/site/package.json", "bun")).toEqual([
    "apps/site/package.json",
    "bun.lock",
    "bun.lockb"
  ]);

  expect(manifestAndLockfilePaths("package.json", "npm")).toEqual([
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json"
  ]);
});
