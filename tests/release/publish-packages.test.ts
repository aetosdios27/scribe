import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isDirectExecution,
  publicPackages,
  publishAlphaPackages
} from "../../scripts/publish-alpha-packages.mjs";

describe("alpha package publisher", () => {
  it("recognizes the relative script path used by the root package command", () => {
    expect(isDirectExecution(
      "file:///workspace/scripts/publish-alpha-packages.mjs",
      "scripts/publish-alpha-packages.mjs",
      "/workspace"
    )).toBe(true);
  });

  it("publishes missing tarballs explicitly to alpha with the CLI last", async () => {
    const root = await releaseFixture();
    const versions = new Map(publicPackages.map(({ name }) => [name, ["0.1.0-alpha.7"]]));
    const tags = new Map(publicPackages.map(({ name }) => [name, { alpha: "0.1.0-alpha.7", latest: "0.1.0-alpha.4" }]));
    const published: Array<{ name: string; tarball: string; tag: string }> = [];

    await publishAlphaPackages({
      root,
      registry: {
        versions: async (name) => versions.get(name) ?? [],
        distTags: async (name) => tags.get(name) ?? {},
        publishTarball: async (name, tarball, tag) => {
          published.push({ name, tarball, tag });
          versions.get(name)?.push("0.1.0-alpha.8");
          tags.set(name, { alpha: "0.1.0-alpha.8", latest: "0.1.0-alpha.4" });
        }
      }
    });

    expect(published.map(({ name }) => name)).toEqual([
      "@scribe-sdk/styles",
      "@scribe-sdk/react",
      "@scribe-sdk/mdx",
      "@scribe-sdk/cli"
    ]);
    expect(published.every(({ tag }) => tag === "alpha")).toBe(true);
    expect(published.at(-1)?.tarball.endsWith("scribe-sdk-cli-0.1.0-alpha.8.tgz")).toBe(true);
  });

  it("skips versions that are already published", async () => {
    const root = await releaseFixture();
    const publishTarball = async () => {
      throw new Error("already-published packages must not be republished");
    };

    await expect(publishAlphaPackages({
      root,
      registry: {
        versions: async () => ["0.1.0-alpha.8"],
        distTags: async () => ({ alpha: "0.1.0-alpha.8", latest: "0.1.0-alpha.4" }),
        publishTarball
      }
    })).resolves.toBeUndefined();
  });

  it("waits for the alpha dist-tag to converge after publishing", async () => {
    const root = await releaseFixture();
    const versions = new Map(publicPackages.map(({ name }) => [name, ["0.1.0-alpha.7"]]));
    const tags = new Map(publicPackages.map(({ name }) => [name, { alpha: "0.1.0-alpha.7", latest: "0.1.0-alpha.4" }]));
    const published: Array<{ name: string }> = [];
    const postPublishReads = new Map(publicPackages.map(({ name }) => [name, 0]));

    await publishAlphaPackages({
      root,
      distTagAttempts: 3,
      distTagDelayMs: 0,
      registry: {
        versions: async (name) => versions.get(name) ?? [],
        distTags: async (name) => {
          const tag = tags.get(name) ?? {};
          const isPublished = published.some((entry) => entry.name === name);
          if (isPublished) {
            const n = (postPublishReads.get(name) ?? 0) + 1;
            postPublishReads.set(name, n);
            if (n < 2) return { ...tag, alpha: "0.1.0-alpha.7" };
          }
          return tag;
        },
        publishTarball: async (name) => {
          published.push({ name });
          versions.get(name)?.push("0.1.0-alpha.8");
          tags.set(name, { alpha: "0.1.0-alpha.8", latest: "0.1.0-alpha.4" });
        }
      }
    });
    expect(postPublishReads.get("@scribe-sdk/styles")).toBeGreaterThanOrEqual(2);
    expect(published.map(({ name }) => name)).toEqual([
      "@scribe-sdk/styles",
      "@scribe-sdk/react",
      "@scribe-sdk/mdx",
      "@scribe-sdk/cli"
    ]);
  });

  it("fails closed when the alpha dist-tag never converges", async () => {
    const root = await releaseFixture();
    const published: string[] = [];

    await expect(publishAlphaPackages({
      root,
      distTagAttempts: 3,
      distTagDelayMs: 0,
      registry: {
        versions: async (name) => published.includes(name) ? ["0.1.0-alpha.8"] : [],
        distTags: async () => ({ alpha: "0.1.0-alpha.7", latest: "0.1.0-alpha.4" }),
        publishTarball: async (name) => {
          published.push(name);
        }
      }
    })).rejects.toThrow("has alpha=0.1.0-alpha.7; expected 0.1.0-alpha.8");
  });

  it("fails closed when publication moves latest", async () => {
    const root = await releaseFixture();
    let published = false;

    await expect(publishAlphaPackages({
      root,
      registry: {
        versions: async () => published ? ["0.1.0-alpha.8"] : ["0.1.0-alpha.7"],
        distTags: async () => ({
          alpha: published ? "0.1.0-alpha.8" : "0.1.0-alpha.7",
          latest: published ? "0.1.0-alpha.8" : "0.1.0-alpha.4"
        }),
        publishTarball: async () => {
          published = true;
        }
      }
    })).rejects.toThrow("changed latest");
  });

  it("does not publish later packages when the first package moves latest", async () => {
    const root = await releaseFixture();
    const published: string[] = [];

    await expect(publishAlphaPackages({
      root,
      registry: {
        versions: async (name) => published.includes(name) ? ["0.1.0-alpha.8"] : [],
        distTags: async (name) => ({
          alpha: published.includes(name) ? "0.1.0-alpha.8" : "0.1.0-alpha.7",
          latest: name === "@scribe-sdk/styles" && published.includes(name) ? "0.1.0-alpha.8" : "0.1.0-alpha.4"
        }),
        publishTarball: async (name) => {
          published.push(name);
        }
      }
    })).rejects.toThrow("changed latest");

    expect(published).toEqual(["@scribe-sdk/styles"]);
  });

  it("rejects release state that is not an alpha prerelease", async () => {
    const root = await releaseFixture({ mode: "exit", tag: "alpha" });

    await expect(publishAlphaPackages({
      root,
      registry: {
        versions: async () => [],
        distTags: async () => ({}),
        publishTarball: async () => undefined
      }
    })).rejects.toThrow("alpha prerelease mode");
  });
});

async function releaseFixture(pre = { mode: "pre", tag: "alpha" }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scribe-alpha-publish-"));
  await mkdir(join(root, ".changeset"), { recursive: true });
  await mkdir(join(root, ".scribe-release"), { recursive: true });
  await writeFile(join(root, ".changeset", "pre.json"), JSON.stringify(pre));

  for (const { directory } of publicPackages) {
    await mkdir(join(root, "packages", directory), { recursive: true });
    await writeFile(join(root, "packages", directory, "package.json"), JSON.stringify({
      name: `@scribe-sdk/${directory}`,
      version: "0.1.0-alpha.8"
    }));
    await writeFile(
      join(root, ".scribe-release", `scribe-sdk-${directory}-0.1.0-alpha.8.tgz`),
      "fixture"
    );
  }

  return root;
}
