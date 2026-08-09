import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = process.cwd();

async function read(path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}

type PackageManifest = {
  packageManager: string;
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};

type IssueFormItem = {
  type: string;
  id?: string;
  attributes?: {
    label?: string;
    options?: Array<{ label: string; required?: boolean }>;
  };
  validations?: { required?: boolean };
};

type IssueForm = {
  name: string;
  description: string;
  body: IssueFormItem[];
};

function expectValidIssueForm(
  form: IssueForm,
  requiredIds: readonly string[]
): void {
  expect(form.name.length).toBeGreaterThan(0);
  expect(form.description.length).toBeGreaterThan(0);
  expect(Array.isArray(form.body)).toBe(true);
  expect(form.body.length).toBeGreaterThan(0);

  const fieldIds = form.body.flatMap((item) => (item.id ? [item.id] : []));
  expect(new Set(fieldIds).size).toBe(fieldIds.length);

  for (const item of form.body) {
    expect(["markdown", "input", "textarea", "dropdown", "checkboxes"]).toContain(
      item.type
    );
    if (item.type !== "markdown") {
      expect(item.id).toBeTruthy();
      expect(item.attributes?.label).toBeTruthy();
    }
  }

  for (const id of requiredIds) {
    const item = form.body.find((candidate) => candidate.id === id);
    expect(item, `missing required issue-form field: ${id}`).toBeDefined();
    expect(item?.validations?.required).toBe(true);
  }
}

describe("public contributor surface", () => {
  it("documents the product boundary, evidence standard, and real repository commands", async () => {
    const [contributing, architecture, manifestSource, lockfile] = await Promise.all([
      read("CONTRIBUTING.md"),
      read("docs/ARCHITECTURE.md"),
      read("package.json"),
      read("bun.lock")
    ]);
    const manifest = JSON.parse(manifestSource) as PackageManifest;

    const documentedScripts = [
      ...contributing.matchAll(/\bbun run ([a-z0-9:-]+)/giu)
    ].flatMap((match) => (match[1] ? [match[1]] : []));
    expect(documentedScripts.length).toBeGreaterThan(10);
    for (const script of documentedScripts) {
      expect(manifest.scripts, `missing package.json script: ${script}`).toHaveProperty(
        script
      );
    }

    expect(contributing).toContain("bun install --frozen-lockfile");
    expect(manifest.packageManager).toMatch(/^bun@/u);
    expect(lockfile).toContain('"lockfileVersion"');

    expect(contributing).toContain("bunx vitest run");
    expect(manifest.devDependencies).toHaveProperty("vitest");
    expect(await read("packages/mdx/src/transform.test.ts")).toBeTruthy();
    expect(await read("packages/cli/src/studio-files.test.ts")).toBeTruthy();

    expect(contributing).toContain("bunx changeset");
    expect(manifest.devDependencies).toHaveProperty("@changesets/cli");

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
    const [bugSource, featureSource, pullRequest] = await Promise.all([
      read(".github/ISSUE_TEMPLATE/bug_report.yml"),
      read(".github/ISSUE_TEMPLATE/feature_integration.yml"),
      read(".github/PULL_REQUEST_TEMPLATE.md")
    ]);
    const bug = parse(bugSource) as IssueForm;
    const feature = parse(featureSource) as IssueForm;

    expect(bug.name).toBe("Bug report");
    expectValidIssueForm(bug, [
      "description",
      "expected",
      "actual",
      "reproduction",
      "package-version",
      "framework-runtime",
      "public-package"
    ]);
    expect(bug.body.find((item) => item.id === "reproduction")?.attributes?.label).toBe(
      "Minimal reproduction"
    );
    expect(
      bug.body.find((item) => item.id === "checks")?.attributes?.options?.every(
        (option) => option.required
      )
    ).toBe(true);

    expect(feature.name).toBe("Feature / integration proposal");
    expectValidIssueForm(feature, [
      "goal",
      "limitation",
      "workaround",
      "current-api",
      "smallest-solution",
      "implementation"
    ]);

    const pullRequestSections = [
      ...pullRequest.matchAll(/^## (.+)$/gmu)
    ].flatMap((match) => (match[1] ? [match[1]] : []));
    expect(pullRequestSections).toEqual([
      "Problem",
      "Approach",
      "Why this scope?",
      "Verification",
      "Public surface",
      "Visual evidence",
      "AI assistance",
      "Release"
    ]);
    expect(pullRequest).toMatch(
      /What fails before this patch and passes after it\?[\s\S]*Did AI materially assist this contribution\?[\s\S]*I reviewed and understand the submitted change/u
    );
  });

  it("publishes a private-reporting path and a standard conduct policy", async () => {
    const [security, conduct] = await Promise.all([
      read("SECURITY.md"),
      read("CODE_OF_CONDUCT.md")
    ]);

    expect(security).toContain("Do not open a public issue");
    expect(security).toContain(
      "[aetosdios27@gmail.com](mailto:aetosdios27@gmail.com)"
    );
    expect(security).toContain("subject `Scribe security report`");
    expect(security).toMatch(
      /Include the affected package and version, impact, reproduction, and any suggested mitigation/u
    );
    expect(security).toContain("There is no guaranteed response SLA");
    expect(security).toContain("trusted local project content");
    expect(conduct).toContain("Contributor Covenant Code of Conduct");
    expect(conduct).toContain("race, caste, color, religion");
  });
});
