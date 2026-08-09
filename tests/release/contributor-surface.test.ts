import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

async function read(path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}

describe("public contributor surface", () => {
  it("documents the product boundary, evidence standard, and real repository commands", async () => {
    const [contributing, architecture] = await Promise.all([
      read("CONTRIBUTING.md"),
      read("docs/ARCHITECTURE.md")
    ]);

    for (const command of [
      "bun install --frozen-lockfile",
      "bun run build",
      "bun run typecheck",
      "bun run test",
      "bun run docs:check",
      "bun run test:browser:chromium",
      "bun run test:studio:browser",
      "bun run test:visual:helium",
      "bun run test:release",
      "bun run release:consumers"
    ]) {
      expect(contributing).toContain(command);
    }

    expect(contributing).toContain("The host owns the website");
    expect(contributing).toContain("AI is a tool, not the contributor");
    expect(contributing).toContain("fails against the broken or base behavior");
    expect(contributing).toContain("No autonomous contribution bots");
    expect(contributing).toContain("bunx changeset");

    expect(architecture).toContain("Why Scribe is shaped this way");
    expect(architecture).toContain("Source is authoritative");
    expect(architecture).toContain("Compile-time first");
    expect(architecture).toContain("@scribe-sdk/mdx");
    expect(architecture).toContain("@scribe-sdk/react");
    expect(architecture).toContain("@scribe-sdk/styles");
    expect(architecture).toContain("@scribe-sdk/cli");
  });

  it("keeps issue forms and the pull request template focused on evidence", async () => {
    const [bug, feature, pullRequest] = await Promise.all([
      read(".github/ISSUE_TEMPLATE/bug_report.yml"),
      read(".github/ISSUE_TEMPLATE/feature_integration.yml"),
      read(".github/PULL_REQUEST_TEMPLATE.md")
    ]);

    expect(bug).toContain("name: Bug report");
    expect(feature).toContain("name: Feature / integration proposal");
    expect(bug).toContain("Minimal reproduction");
    expect(bug).toContain("current public or locally packed Scribe package");
    expect(feature).toContain("What are you trying to publish or build?");
    expect(feature).toContain("smallest useful solution");
    expect(pullRequest).toContain("What fails before this patch and passes after it?");
    expect(pullRequest).toContain("Did AI materially assist this contribution?");
    expect(pullRequest).toContain("I reviewed and understand the submitted change");
  });

  it("publishes a private-reporting path and a standard conduct policy", async () => {
    const [security, conduct] = await Promise.all([
      read("SECURITY.md"),
      read("CODE_OF_CONDUCT.md")
    ]);

    expect(security).toContain("Do not open a public issue");
    expect(security).toContain("trusted local project content");
    expect(conduct).toContain("Contributor Covenant Code of Conduct");
  });
});
