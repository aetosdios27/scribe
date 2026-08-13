import {
  mkdtemp,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  describe,
  expect,
  it
} from "vitest";

import {
  isDirectInvocation,
  selectNativePackage
} from "./bootstrap.js";

describe("native CLI package selection", () => {
  it.each([
    [
      "linux",
      "x64",
      "gnu",
      "@scribe-sdk/cli-linux-x64-gnu",
      "scribe-cli"
    ],
    [
      "linux",
      "x64",
      "musl",
      "@scribe-sdk/cli-linux-x64-musl",
      "scribe-cli"
    ],
    [
      "linux",
      "arm64",
      "gnu",
      "@scribe-sdk/cli-linux-arm64-gnu",
      "scribe-cli"
    ],
    [
      "linux",
      "arm64",
      "musl",
      "@scribe-sdk/cli-linux-arm64-musl",
      "scribe-cli"
    ],
    [
      "darwin",
      "x64",
      undefined,
      "@scribe-sdk/cli-darwin-x64",
      "scribe-cli"
    ],
    [
      "darwin",
      "arm64",
      undefined,
      "@scribe-sdk/cli-darwin-arm64",
      "scribe-cli"
    ],
    [
      "win32",
      "x64",
      undefined,
      "@scribe-sdk/cli-win32-x64-msvc",
      "scribe-cli.exe"
    ],
    [
      "win32",
      "arm64",
      undefined,
      "@scribe-sdk/cli-win32-arm64-msvc",
      "scribe-cli.exe"
    ]
  ] as const)(
    "selects %s/%s/%s",
    (
      platform,
      arch,
      libc,
      packageName,
      binary
    ) => {
      expect(
        selectNativePackage({
          platform,
          arch,
          ...(libc === undefined
            ? {}
            : { libc })
        })
      ).toEqual({
        packageName,
        binary
      });
    }
  );

  it("rejects unsupported platforms", () => {
    expect(() =>
      selectNativePackage({
        platform: "freebsd",
        arch: "x64"
      })
    ).toThrow(
      "does not provide a native CLI"
    );
  });
});

describe("bootstrap invocation detection", () => {
  it("recognizes the canonical module path", () => {
    expect(
      isDirectInvocation(
        "bootstrap.mjs",
        "bootstrap.mjs"
      )
    ).toBe(true);
  });

  it("rejects an unrelated entrypoint", () => {
    expect(
      isDirectInvocation(
        "some-other-script.mjs",
        "bootstrap.mjs"
      )
    ).toBe(false);
  });

  it.skipIf(
    process.platform === "win32"
  )(
    "recognizes an installed package-bin symlink",
    async () => {
      const directory = await mkdtemp(
        join(
          tmpdir(),
          "scribe-bootstrap-test-"
        )
      );

      try {
        const target = join(
          directory,
          "bootstrap.mjs"
        );

        const link = join(
          directory,
          "scribe"
        );

        await writeFile(
          target,
          "#!/usr/bin/env node\n"
        );

        await symlink(
          target,
          link
        );

        expect(
          isDirectInvocation(
            link,
            target
          )
        ).toBe(true);
      } finally {
        await rm(
          directory,
          {
            recursive: true,
            force: true
          }
        );
      }
    }
  );
});
