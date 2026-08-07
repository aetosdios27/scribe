import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import {
  inspectProject,
  planIntegrate,
  resolveProjectStyleMode,
  runIntegrate
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

it("does not treat a README mention as proof that Scribe components are wired", async () => {
  const root = await alignedViteProject({
    "bun-global/install/cache/readme/README.md":
      "See createScribeComponents for documentation.\n"
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

  expect(plan.inspection.packageManager).toBe("bun");
  expect(plan.inspection.packageManagerRoot).toBe(root);
  expect(plan.guards.map((guard) => guard.path)).toContain(
    "apps/site/package.json"
  );
  expect(plan.guards.map((guard) => guard.path)).toContain("bun.lock");
});

it("aborts if the user edits a planned file while reviewing the confirmation", async () => {
  const root = await alignedViteProject();
  const stderr = vi.fn();

  const status = await runIntegrate(["--mode", "default"], {
    cwd: root,
    version,
    stdout: vi.fn(),
    stderr,
    confirm: async () => {
      await writeFile(
        join(root, "src", "index.css"),
        "/* user edit while reviewing */\n"
      );
      return true;
    }
  });

  expect(status).toBe(2);
  expect(
    await readFile(join(root, "src", "index.css"), "utf8")
  ).toBe("/* user edit while reviewing */\n");
  expect(stderr.mock.calls.join("\n")).toContain(
    "project changed after the Scribe integration plan was created"
  );
  expect(await readdir(root)).not.toContain(".scribe-integrate.lock");
});

it("aborts if a planned-new MDX component map appears during review", async () => {
  const declarations = scribeDeclarations();
  const root = await project({
    "package.json": JSON.stringify({
      packageManager: "npm@11.0.0",
      dependencies: {
        ...declarations.dependencies,
        next: "16.2.11",
        "@next/mdx": "16.2.11"
      },
      devDependencies: declarations.devDependencies
    }),
    "package-lock.json": "{}",
    "app/globals.css": "body { margin: 0; }\n",
    "next.config.mjs":
      "import createMDX from '@next/mdx';\nexport default createMDX({})({});\n"
  });
  await installScribeSet(root);

  const status = await runIntegrate(["--mode", "default"], {
    cwd: root,
    version,
    stdout: vi.fn(),
    stderr: vi.fn(),
    confirm: async () => {
      await writeFile(
        join(root, "mdx-components.tsx"),
        "export const UserCreatedThis = true;\n"
      );
      return true;
    }
  });

  expect(status).toBe(2);
  expect(
    await readFile(join(root, "mdx-components.tsx"), "utf8")
  ).toContain("UserCreatedThis");
});

it("never reports full success while required MDX work remains", async () => {
  const root = await alignedViteProject();
  const stdout = vi.fn();

  const status = await runIntegrate(
    ["--mode", "default", "--yes"],
    {
      cwd: root,
      version,
      stdout,
      stderr: vi.fn()
    }
  );

  expect(status).toBe(3);
  const output = stdout.mock.calls.join("\n");
  expect(output).toContain("Action required");
  expect(output).not.toContain("Success  Scribe integrated");
  expect(output).toContain("No active Vite MDX plugin was detected");
  expect(
    await readFile(join(root, "src", "index.css"), "utf8")
  ).toContain('@scribe-sdk/styles/default.css');
});

it("keeps @charset first when adding the stylesheet import", async () => {
  const root = await alignedViteProject({
    "src/index.css":
      '@charset "UTF-8";\nbody { margin: 0; }\n'
  });

  const status = await runIntegrate(
    ["--mode", "default", "--yes"],
    {
      cwd: root,
      version,
      stdout: vi.fn(),
      stderr: vi.fn()
    }
  );

  expect(status).toBe(3);
  expect(
    await readFile(join(root, "src", "index.css"), "utf8")
  ).toMatch(
    /^@charset "UTF-8";\n@import "@scribe-sdk\/styles\/default\.css";/u
  );
});

it("stops before touching source files for a non-automated package manager", async () => {
  const root = await project({
    "package.json": JSON.stringify({
      packageManager: "pnpm@10.15.0",
      dependencies: {
        react: "19.2.7",
        vite: "8.1.3"
      }
    }),
    "pnpm-lock.yaml": "",
    "src/index.css": "body { margin: 0; }\n"
  });

  const before = await readFile(
    join(root, "src", "index.css"),
    "utf8"
  );
  const stderr = vi.fn();

  const status = await runIntegrate(
    ["--mode", "default", "--yes"],
    {
      cwd: root,
      version,
      stdout: vi.fn(),
      stderr
    }
  );

  expect(status).toBe(2);
  expect(
    await readFile(join(root, "src", "index.css"), "utf8")
  ).toBe(before);
  expect(stderr.mock.calls.join("\n")).toContain(
    "not automated yet"
  );
});

it("restores tracked manifest and lockfile contents when the second package command fails", async () => {
  const originalManifest = JSON.stringify({
    packageManager: "npm@11.0.0",
    dependencies: {
      react: "19.2.7",
      vite: "8.1.3"
    }
  });
  const root = await project({
    "package.json": originalManifest,
    "package-lock.json": '{"lockfileVersion":3}\n',
    "src/index.css": "body { margin: 0; }\n"
  });

  let commandIndex = 0;
  const runCommand = vi.fn(
    async (_command: PackageCommand) => {
      commandIndex += 1;
      if (commandIndex === 1) {
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({
            packageManager: "npm@11.0.0",
            dependencies: {
              react: "19.2.7",
              vite: "8.1.3",
              "@scribe-sdk/react": version,
              "@scribe-sdk/styles": version,
              "@scribe-sdk/mdx": version
            }
          })
        );
        await writeFile(
          join(root, "package-lock.json"),
          '{"lockfileVersion":3,"mutated":true}\n'
        );
        return 0;
      }
      return 1;
    }
  );

  const status = await runIntegrate(
    ["--mode", "default", "--yes"],
    {
      cwd: root,
      version,
      stdout: vi.fn(),
      stderr: vi.fn(),
      runCommand
    }
  );

  expect(status).toBe(1);
  expect(runCommand).toHaveBeenCalledTimes(2);
  expect(await readFile(join(root, "package.json"), "utf8")).toBe(
    originalManifest
  );
  expect(
    await readFile(join(root, "package-lock.json"), "utf8")
  ).toBe('{"lockfileVersion":3}\n');
  expect(await readdir(root)).not.toContain(".scribe-integrate.lock");
});

it("blocks conflicting package-manager signals before any mutation", async () => {
  const root = await project({
    "package.json": JSON.stringify({
      packageManager: "npm@11.0.0",
      dependencies: {
        react: "19.2.7",
        vite: "8.1.3"
      }
    }),
    "package-lock.json": "{}",
    "bun.lock": "",
    "src/index.css": "body { margin: 0; }\n"
  });
  const before = await readFile(
    join(root, "src", "index.css"),
    "utf8"
  );

  const status = await runIntegrate(
    ["--mode", "default", "--yes"],
    {
      cwd: root,
      version,
      stdout: vi.fn(),
      stderr: vi.fn()
    }
  );

  expect(status).toBe(2);
  expect(
    await readFile(join(root, "src", "index.css"), "utf8")
  ).toBe(before);
});

it("keeps dry runs pure while surfacing required manual actions", async () => {
  const root = await alignedViteProject();
  const before = await readFile(
    join(root, "src", "index.css"),
    "utf8"
  );
  const stdout = vi.fn();

  const status = await runIntegrate(
    ["--mode", "default", "--dry-run"],
    {
      cwd: root,
      version,
      stdout,
      stderr: vi.fn()
    }
  );

  expect(status).toBe(0);
  expect(
    await readFile(join(root, "src", "index.css"), "utf8")
  ).toBe(before);
  const output = stdout.mock.calls.join("\n");
  expect(output).toContain("No files or packages will be changed.");
  expect(output).toContain("Required manual actions");
});
