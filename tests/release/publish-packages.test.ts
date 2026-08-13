import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isDirectExecution,
  publicPackages,
  publishPrereleasePackages
} from "../../scripts/publish-prerelease-packages.mjs";

describe("prerelease package publisher", () => {
  it("recognizes the relative script path used by the root package command", () => {
    expect(isDirectExecution(
      "file:///workspace/scripts/publish-prerelease-packages.mjs",
      "scripts/publish-prerelease-packages.mjs",
      "/workspace"
    )).toBe(true);
  });

  it("publishes every missing package explicitly to beta without moving alpha", async () => {
    const root = await releaseFixture();
    const versions = new Map(publicPackages.map(({ name }) => [name, ["0.1.0-alpha.10"]]));
    const tags = new Map<string, { alpha: string; beta: string }>(
      publicPackages.map(({ name }) => [name, {
        alpha: "0.1.0-alpha.10",
        beta: "0.1.0-alpha.10"
      }])
    );
    const published: Array<{ name: string; tarball: string; tag: string }> = [];

    await publishPrereleasePackages({
      root,
      registry: {
        versions: async (name) => versions.get(name) ?? [],
        distTags: async (name) => tags.get(name) ?? {},
        publishTarball: async (name, tarball, tag) => {
          published.push({ name, tarball, tag });
          versions.get(name)?.push("0.1.0-beta");
          const previous = tags.get(name) as { alpha: string; beta: string };
          tags.set(name, { ...previous, beta: "0.1.0-beta" });
        }
      }
    });

    expect(published.map(({ name }) => name)).toEqual([
      "@scribe-sdk/styles",
      "@scribe-sdk/react",
      "@scribe-sdk/mdx",
      "@scribe-sdk/cli"
    ]);
    expect(published.every(({ tag }) => tag === "beta")).toBe(true);
    expect(published.at(-1)?.tarball.endsWith("scribe-sdk-cli-0.1.0-beta.tgz")).toBe(true);
    expect([...tags.values()].every(({ alpha }) => alpha === "0.1.0-alpha.10")).toBe(true);
  });

  it("skips published packages and fails closed when beta never converges", async () => {
    const root = await releaseFixture();
    const published: string[] = [];

    await expect(publishPrereleasePackages({
      root,
      distTagAttempts: 3,
      distTagDelayMs: 0,
      registry: {
        versions: async (name) => published.includes(name) ? ["0.1.0-beta"] : [],
        distTags: async () => ({
          alpha: "0.1.0-alpha.10",
          beta: "0.1.0-alpha.10"
        }),
        publishTarball: async (name) => {
          published.push(name);
        }
      }
    })).rejects.toThrow("has beta=0.1.0-alpha.10; expected 0.1.0-beta");
  });

  it("accepts historical alpha mode but rejects unsupported or exited prerelease state", async () => {
    const alphaRoot = await releaseFixture(
      { mode: "pre", tag: "alpha" },
      "0.1.0-alpha.10"
    );
    await expect(publishPrereleasePackages({
      root: alphaRoot,
      registry: {
        versions: async () => ["0.1.0-alpha.10"],
        distTags: async () => ({ alpha: "0.1.0-alpha.10" }),
        publishTarball: async () => undefined
      }
    })).resolves.toBeUndefined();

    for (const pre of [
      { mode: "exit", tag: "beta" },
      { mode: "pre", tag: "next" }
    ]) {
      const root = await releaseFixture(pre);
      await expect(publishPrereleasePackages({
        root,
        registry: {
          versions: async () => [],
          distTags: async () => ({}),
          publishTarball: async () => undefined
        }
      })).rejects.toThrow("alpha or beta prerelease mode");
    }
  });
});

async function releaseFixture(
  pre: { mode: string; tag: string } = { mode: "pre", tag: "beta" },
  version = "0.1.0-beta"
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scribe-prerelease-publish-"));
  await mkdir(join(root, ".changeset"), { recursive: true });
  await mkdir(join(root, ".scribe-release"), { recursive: true });
  await writeFile(join(root, ".changeset", "pre.json"), JSON.stringify(pre));

  for (const { directory } of publicPackages) {
    await mkdir(join(root, "packages", directory), { recursive: true });
    await writeFile(join(root, "packages", directory, "package.json"), JSON.stringify({
      name: `@scribe-sdk/${directory}`,
      version
    }));
    await writeFile(
      join(root, ".scribe-release", `scribe-sdk-${directory}-${version}.tgz`),
      "fixture"
    );
  }
  return root;
}
