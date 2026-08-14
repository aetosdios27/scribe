import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import {
  applyIntegratePlan,
  inspectProject,
  planIntegrate,
  resolveProjectStyleMode
} from "./integrate.js";
import {
  formatPackageCommand,
  type PackageCommand
} from "./package-manager.js";
import { scribePackageDefinitions } from "./version-alignment.js";

const version = "1.2.3";

async function project(
  files: Record<string, string | Buffer>
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scribe-integrate-"));
  for (const [name, value] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, value);
  }
  return root;
}

function scribeDeclarations(targetVersion = version) {
  return {
    dependencies: {
      react: "19.2.7",
      "@scribe-sdk/react": targetVersion,
      "@scribe-sdk/styles": targetVersion,
      "@scribe-sdk/mdx": targetVersion
    },
    devDependencies: {
      "@scribe-sdk/cli": targetVersion
    }
  };
}

async function installScribeSet(
  root: string,
  targetVersion = version,
  styleModes: readonly string[] = ["default", "foundation", "tailwind"]
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
        version: targetVersion
      })
    );
  }

  for (const mode of styleModes) {
    const path = join(
      root,
      "node_modules",
      "@scribe-sdk",
      "styles",
      `${mode}.css`
    );
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `/* ${mode} */\n`);
  }
}

async function alignedViteProject(
  extra: Record<string, string | Buffer> = {}
): Promise<string> {
  const declarations = scribeDeclarations();
  const root = await project({
    "package.json": JSON.stringify({
      packageManager: "npm@11.0.0",
      dependencies: {
        ...declarations.dependencies,
        vite: "8.1.3"
      },
      devDependencies: declarations.devDependencies
    }),
    "package-lock.json": "{}",
    "src/index.css": "body { margin: 0; }\n",
    ...extra
  });
  await installScribeSet(root);
  return root;
}

it("does not treat an unrelated source mention as proof that Scribe components are wired", async () => {
  const root = await alignedViteProject({
    "src/unrelated.ts":
      'export const note = "See createScribeComponents for documentation.";\n'
  });

  const inspection = await inspectProject(root);
  expect(inspection.hasScribeComponents).toBe(false);
});

it("an explicit style mode does not bypass an invalid project boundary", async () => {
  const root = await project({
    "package.json": JSON.stringify({
      packageManager: "npm@11.0.0",
      private: true
    }),
    "package-lock.json": "{}"
  });

  const resolution = await resolveProjectStyleMode(root, "default");
  expect(resolution.mode).toBe("default");
  expect(resolution.ambiguities.join("\n")).toContain(
    "React was not detected"
  );
  expect(resolution.ambiguities.join("\n")).toContain(
    "no unambiguous application framework"
  );
});

it("does not invent a Vite integration step for a Next app with no active MDX pipeline", async () => {
  const declarations = scribeDeclarations();
  const root = await project({
    "package.json": JSON.stringify({
      packageManager: "npm@11.0.0",
      dependencies: {
        ...declarations.dependencies,
        next: "16.2.11"
      },
      devDependencies: declarations.devDependencies
    }),
    "package-lock.json": "{}",
    "app/globals.css": "body { margin: 0; }\n"
  });
  await installScribeSet(root);

  const plan = await planIntegrate(root, "default", version);
  const manual = plan.manualSteps.join("\n");

  expect(manual).toContain("No active Next.js MDX compilation pipeline");
  expect(manual).not.toContain("Vite MDX");
  expect(manual).not.toContain("Vite MDX plugin");
});

it("plans package convergence instead of merely warning about version skew", async () => {
  const old = "1.2.2";
  const declarations = scribeDeclarations(old);
  const root = await project({
    "package.json": JSON.stringify({
      packageManager: "npm@11.0.0",
      dependencies: {
        ...declarations.dependencies,
        vite: "8.1.3"
      },
      devDependencies: declarations.devDependencies
    }),
    "package-lock.json": "{}",
    "src/index.css": "body { margin: 0; }\n"
  });
  await installScribeSet(root, old);

  const plan = await planIntegrate(root, "default", version);

  expect(plan.packages).toHaveLength(4);
  expect(plan.commands).toHaveLength(2);
  expect(
    plan.commands.map((command) => formatPackageCommand(command)).join("\n")
  ).toContain("@scribe-sdk/react@1.2.3");
});

it("uses the workspace root as the transaction/package-manager root", async () => {
  const root = await project({
    "package.json": JSON.stringify({
      private: true,
      workspaces: ["apps/*"],
      packageManager: "bun@1.3.13"
    }),
    "bun.lock": "",
    "apps/site/package.json": JSON.stringify({
      dependencies: {
        react: "19.2.7",
        vite: "8.1.3"
      }
    }),
    "apps/site/src/index.css": "body { margin: 0; }\n"
  });

  const plan = await planIntegrate(
    join(root, "apps", "site"),
    "default",
    version
  );

  const canonicalRoot = await realpath(root);
  expect(plan.inspection.packageManager).toBe("bun");
  expect(plan.inspection.packageManagerRoot).toBe(canonicalRoot);
  expect(plan.guards.map((guard) => guard.path)).toContain(
    "apps/site/package.json"
  );
  expect(plan.guards.map((guard) => guard.path)).toContain("bun.lock");
});


it("aborts if a guarded file changes after planning", async () => {
  const root = await alignedViteProject();
  const plan = await planIntegrate(root, "default", version);
  await writeFile(join(root, "src", "index.css"), "/* user edit while reviewing */\n");

  await expect(applyIntegratePlan(plan, version)).rejects.toMatchObject({
    partialState: false
  });
  await expect(readFile(join(root, "src", "index.css"), "utf8"))
    .resolves.toBe("/* user edit while reviewing */\n");
});
