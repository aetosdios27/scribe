import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error The release staging utility is intentionally plain ESM.
import { stageNativeCli } from "../../scripts/stage-native-cli.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("native CLI package staging", () => {
  it.each([
    ["x86_64-unknown-linux-gnu", "linux-x64-gnu", "scribe-cli"],
    ["x86_64-unknown-linux-musl", "linux-x64-musl", "scribe-cli"],
    ["aarch64-unknown-linux-gnu", "linux-arm64-gnu", "scribe-cli"],
    ["aarch64-unknown-linux-musl", "linux-arm64-musl", "scribe-cli"],
    ["x86_64-apple-darwin", "darwin-x64", "scribe-cli"],
    ["aarch64-apple-darwin", "darwin-arm64", "scribe-cli"],
    ["x86_64-pc-windows-msvc", "win32-x64-msvc", "scribe-cli.exe"],
    ["aarch64-pc-windows-msvc", "win32-arm64-msvc", "scribe-cli.exe"]
  ] as const)("stages %s with verifiable provenance", async (target, directory, binary) => {
    const root = await fixture(directory);
    const source = join(root, "target", target, binary);
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, `native-${target}`);

    const result = await stageNativeCli({ target, source, rootDirectory: root });
    const metadata = JSON.parse(await readFile(join(root, "packages/cli-native", directory, "build-metadata.json"), "utf8"));

    expect(result.destination).toBe(join(root, "packages/cli-native", directory, "bin", binary));
    expect(await readFile(result.destination, "utf8")).toBe(`native-${target}`);
    expect(metadata).toMatchObject({
      package: `@scribe-sdk/cli-${directory}`,
      version: "0.1.0-beta",
      target,
      binary,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u)
    });
    if (process.platform !== "win32") {
      expect((await stat(result.destination)).mode & 0o111).not.toBe(0);
    }
  });

  it("rejects package versions that do not match the CLI", async () => {
    const root = await fixture("linux-x64-gnu", "0.1.0-alpha.10");
    const source = join(root, "scribe-cli");
    await writeFile(source, "native");

    await expect(stageNativeCli({
      target: "x86_64-unknown-linux-gnu",
      source,
      rootDirectory: root
    })).rejects.toThrow("does not match @scribe-sdk/cli@0.1.0-beta");
  });
});

async function fixture(directory: string, nativeVersion = "0.1.0-beta"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scribe-native-packaging-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "packages/cli"), { recursive: true });
  await mkdir(join(root, "packages/cli-native", directory), { recursive: true });
  await writeFile(join(root, "packages/cli/package.json"), JSON.stringify({
    name: "@scribe-sdk/cli",
    version: "0.1.0-beta"
  }));
  await writeFile(join(root, "packages/cli-native", directory, "package.json"), JSON.stringify({
    name: `@scribe-sdk/cli-${directory}`,
    version: nativeVersion
  }));
  return root;
}
