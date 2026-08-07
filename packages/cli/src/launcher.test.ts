import {
  mkdir,
  mkdtemp,
  realpath,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  classifyInvokedBinary,
  delegateToLocalCli,
  delegationMarker,
  findSupportedProjectRoot,
  isSupportedProject,
  readCliVersion,
  resolveExecutionContext,
  resolveLocalCli,
  shouldDelegate
} from "./launcher.js";

async function project(
  files: Record<string, string>
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scribe-launcher-"));
  for (const [name, value] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, value);
  }
  return root;
}

async function fakeLocalCli(
  root: string,
  version = "9.9.9"
): Promise<string> {
  const directory = join(
    root,
    "node_modules",
    "@scribe-sdk",
    "cli"
  );
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "@scribe-sdk/cli",
      version,
      bin: { scribe: "./dist/index.mjs" }
    })
  );
  await writeFile(
    join(directory, "dist", "index.mjs"),
    "console.log('local');\n"
  );
  return realpath(directory);
}

it("classifies only the executable name it can actually observe", () => {
  expect(
    classifyInvokedBinary("/project/node_modules/.bin/scribe")
  ).toBe("scribe");
  expect(
    classifyInvokedBinary("C:\\project\\node_modules\\.bin\\scb.exe")
  ).toBe("scb");
  expect(classifyInvokedBinary("/package/dist/index.mjs")).toBe(
    "other"
  );
});

it("resolves a CLI hoisted to the workspace root", async () => {
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
    })
  });
  const hoisted = await fakeLocalCli(root, "1.2.3");

  const local = await resolveLocalCli(
    join(root, "apps", "site"),
    root
  );

  expect(local?.packageRoot).toBe(hoisted);
  expect(local?.version).toBe("1.2.3");
});

it("a foreign CLI delegates to the resolvable project-local CLI", async () => {
  const root = await project({
    "package.json": JSON.stringify({
      packageManager: "npm@11.0.0",
      dependencies: {
        react: "19.2.7",
        vite: "8.1.3"
      }
    }),
    "package-lock.json": "{}"
  });
  await fakeLocalCli(root, "1.2.3");

  const context = await resolveExecutionContext({
    cwd: root,
    packageRoot: "/opt/global/@scribe-sdk/cli",
    packageVersion: "2.0.0",
    argv1: "/usr/local/bin/scribe"
  });

  expect(context.source).toBe("foreign-with-local");
  expect(shouldDelegate(context)).toBe(true);
});

it("delegation markers are bound to the exact target CLI", async () => {
  const root = await project({
    "package.json": JSON.stringify({
      packageManager: "npm@11.0.0",
      dependencies: {
        react: "19.2.7",
        vite: "8.1.3"
      }
    }),
    "package-lock.json": "{}"
  });
  const localRoot = await fakeLocalCli(root, "1.2.3");

  const poisoned = await resolveExecutionContext({
    cwd: root,
    packageRoot: "/opt/global/@scribe-sdk/cli",
    packageVersion: "2.0.0",
    env: { [delegationMarker]: "/some/other/project/cli" }
  });

  expect(poisoned.delegated).toBe(false);
  expect(shouldDelegate(poisoned)).toBe(true);

  const delegated = await resolveExecutionContext({
    cwd: root,
    packageRoot: localRoot,
    packageVersion: "1.2.3",
    env: { [delegationMarker]: localRoot }
  });

  expect(delegated.delegated).toBe(true);
  expect(delegated.source).toBe("delegated-child");
  expect(shouldDelegate(delegated)).toBe(false);
});

it("passes the target-bound delegation marker to the child", async () => {
  const root = await project({
    "package.json": JSON.stringify({
      packageManager: "npm@11.0.0",
      dependencies: {
        react: "19.2.7",
        vite: "8.1.3"
      }
    }),
    "package-lock.json": "{}"
  });
  await fakeLocalCli(root, "1.2.3");

  const context = await resolveExecutionContext({
    cwd: root,
    packageRoot: "/opt/global/@scribe-sdk/cli",
    packageVersion: "2.0.0"
  });

  let observed:
    | {
        command: string;
        args: readonly string[];
        env: Readonly<Record<string, string | undefined>>;
      }
    | undefined;

  const status = await delegateToLocalCli(
    context,
    ["validate", "article.mdx"],
    {
      spawnImpl: async (command, args, options) => {
        observed = { command, args, env: options.env };
        return 7;
      }
    }
  );

  expect(status).toBe(7);
  expect(observed?.command).toBe(process.execPath);
  expect(observed?.args.slice(1)).toEqual([
    "validate",
    "article.mdx"
  ]);
  expect(observed?.env[delegationMarker]).toBe(
    context.localCli?.packageRoot
  );
});

it("treats a malformed installed local CLI as broken, not missing", async () => {
  const root = await project({
    "package.json": JSON.stringify({
      dependencies: {
        react: "19.2.7",
        vite: "8.1.3"
      }
    }),
    "node_modules/@scribe-sdk/cli/package.json": "{ nope"
  });

  await expect(resolveLocalCli(root, root)).rejects.toThrow(
    /Could not parse project-local Scribe CLI manifest/u
  );
});

it("refuses a local CLI with no declared executable instead of guessing dist/index.mjs", async () => {
  const root = await project({
    "package.json": "{}",
    "node_modules/@scribe-sdk/cli/package.json": JSON.stringify({
      name: "@scribe-sdk/cli",
      version: "1.2.3"
    })
  });

  await expect(resolveLocalCli(root, root)).rejects.toThrow(
    /does not advertise a scribe\/scb executable/u
  );
});

it("rejects a local CLI whose declared executable escapes its package root", async () => {
  const root = await project({
    "package.json": "{}",
    "outside.mjs": "console.log('outside');\n",
    "node_modules/@scribe-sdk/cli/package.json": JSON.stringify({
      name: "@scribe-sdk/cli",
      version: "1.2.3",
      bin: { scribe: "../../../outside.mjs" }
    })
  });

  await expect(resolveLocalCli(root, root)).rejects.toThrow(
    /escapes its package root/u
  );
});

it("does not walk above a repository boundary looking for a React project", async () => {
  const outer = await project({
    "package.json": JSON.stringify({
      dependencies: {
        react: "19.2.7",
        vite: "8.1.3"
      }
    }),
    "repo/.git/HEAD": "ref: refs/heads/main\n",
    "repo/nested/placeholder.txt": ""
  });

  expect(
    await findSupportedProjectRoot(
      join(outer, "repo", "nested")
    )
  ).toBeUndefined();
});

it("fails on a malformed nearest package.json rather than silently walking upward", async () => {
  const root = await project({
    ".git/HEAD": "ref: refs/heads/main\n",
    "package.json": JSON.stringify({
      dependencies: {
        react: "19.2.7",
        vite: "8.1.3"
      }
    }),
    "apps/site/package.json": "{ broken"
  });

  await expect(
    findSupportedProjectRoot(join(root, "apps", "site"))
  ).rejects.toThrow(/Could not parse/u);
});

it("does not invent version 0.0.0 for a broken running CLI manifest", async () => {
  const root = await project({
    "package.json": JSON.stringify({
      name: "@scribe-sdk/cli"
    })
  });

  expect(() => readCliVersion(root)).toThrow(
    /Could not determine the running Scribe CLI version/u
  );
});

it("still recognizes an ordinary supported project", async () => {
  const root = await project({
    "package.json": JSON.stringify({
      dependencies: {
        react: "19.2.7",
        next: "16.2.11"
      }
    })
  });

  expect(await isSupportedProject(root)).toBe(true);
});
