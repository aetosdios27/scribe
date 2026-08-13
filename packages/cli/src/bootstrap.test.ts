import { describe, expect, it } from "vitest";

import { selectNativePackage } from "./bootstrap.js";

describe("native CLI package selection", () => {
  it.each([
    ["linux", "x64", "gnu", "@scribe-sdk/cli-linux-x64-gnu", "scribe-cli"],
    ["linux", "x64", "musl", "@scribe-sdk/cli-linux-x64-musl", "scribe-cli"],
    ["linux", "arm64", "gnu", "@scribe-sdk/cli-linux-arm64-gnu", "scribe-cli"],
    ["linux", "arm64", "musl", "@scribe-sdk/cli-linux-arm64-musl", "scribe-cli"],
    ["darwin", "x64", undefined, "@scribe-sdk/cli-darwin-x64", "scribe-cli"],
    ["darwin", "arm64", undefined, "@scribe-sdk/cli-darwin-arm64", "scribe-cli"],
    ["win32", "x64", undefined, "@scribe-sdk/cli-win32-x64-msvc", "scribe-cli.exe"],
    ["win32", "arm64", undefined, "@scribe-sdk/cli-win32-arm64-msvc", "scribe-cli.exe"]
  ] as const)("selects %s/%s/%s", (platform, arch, libc, packageName, binary) => {
    expect(selectNativePackage({ platform, arch, ...(libc === undefined ? {} : { libc }) }))
      .toEqual({ packageName, binary });
  });

  it("rejects unsupported platforms", () => {
    expect(() => selectNativePackage({ platform: "freebsd", arch: "x64" }))
      .toThrow("does not provide a native CLI");
  });
});
