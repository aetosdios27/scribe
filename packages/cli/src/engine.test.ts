import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveStudioPort } from "./engine.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const engineSource = resolve(packageRoot, "src/engine.ts");
const fixtureRoot = resolve(workspaceRoot, "tests/fixtures/protocol");

const packageVersion = (JSON.parse(
  await readFile(resolve(packageRoot, "package.json"), "utf8")
) as { version: string }).version;

describe("engine protocol", () => {
  it("negotiates one versioned handshake and rejects unknown methods", async () => {
    const messages = await runEngine([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          cliVersion: packageVersion,
          cwd: workspaceRoot,
          invokedBinary: "scribe"
        }
      },
      { jsonrpc: "2.0", id: 2, method: "unknown.method", params: {} }
    ]);

    expect(messages).toHaveLength(2);
    expect(object(messages[0]).result).toMatchObject({
      protocolVersion: 1,
      engineVersion: packageVersion
    });
    expect(object(object(messages[1]).error)).toMatchObject({
      code: -32_601,
      message: expect.stringContaining("Unknown engine method")
    });
    expect(JSON.stringify(messages[1])).not.toContain("stack");
  });

  it("rejects commands before the handshake", async () => {
    const messages = await runEngine([
      { jsonrpc: "2.0", id: 1, method: "validate", params: { article: "article.mdx" } }
    ]);
    expect(object(object(messages[0]).error)).toMatchObject({
      code: -32_600,
      message: expect.stringContaining("initialized")
    });
  });

  it("recomputes an article path from an edited slug", async () => {
    const messages = await runEngine([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          cliVersion: packageVersion,
          cwd: workspaceRoot,
          invokedBinary: "scribe"
        }
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "studioArticle.suggest",
        params: {
          title: "Cache Notes",
          slug: "redis-internals",
          contentDirectory: "content/blog"
        }
      }
    ]);
    const result = object(object(messages[1]).result);
    expect(object(result.values)).toMatchObject({
      slug: "redis-internals",
      targetPath: "content/blog/redis-internals.mdx"
    });
  });

  it("keeps shared fixtures parseable and versioned", async () => {
    const initialize = object(JSON.parse(await readFile(resolve(fixtureRoot, "initialize.json"), "utf8")) as unknown);
    const events = JSON.parse(await readFile(resolve(fixtureRoot, "events.json"), "utf8")) as unknown;
    const failures = JSON.parse(await readFile(resolve(fixtureRoot, "failures.json"), "utf8")) as unknown;
    expect(object(initialize.request).jsonrpc).toBe("2.0");
    expect(object(object(initialize.result).result).protocolVersion).toBe(1);
    expect(Array.isArray(events) ? events : []).toHaveLength(3);
    expect(Array.isArray(failures) ? failures : []).toHaveLength(2);
  });

  it("uses the default Studio port when none or null is provided", () => {
    expect(resolveStudioPort(undefined)).toBe(4317);
    expect(resolveStudioPort(null)).toBe(4317);
  });

  it("validates explicit Studio ports", () => {
    expect(resolveStudioPort(8080)).toBe(8080);
    expect(() => resolveStudioPort(0)).toThrow(/integer from 1 to 65535/);
    expect(() => resolveStudioPort(70_000)).toThrow(/integer from 1 to 65535/);
    expect(() => resolveStudioPort("4317")).toThrow(/integer from 1 to 65535/);
  });
});

async function runEngine(requests: readonly unknown[]): Promise<readonly unknown[]> {
  const child = spawn("bun", [engineSource, "--engine"], {
    cwd: workspaceRoot,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  child.stdin.end();
  const status = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  expect(status).toBe(0);
  expect(stderr).toBe("");
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected an object fixture.");
  }
  return Object.fromEntries(Object.entries(value));
}
