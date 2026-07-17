import { expect, it, vi } from "vitest";

import { isMainModule, main, version } from "./index.js";

it("exposes a Node-compatible phase-one CLI boundary", () => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  expect(main(["--version"])).toBe(0);
  expect(write).toHaveBeenCalledWith(`${version}\n`);

  write.mockRestore();
});

it("recognizes a symlinked installed binary as the entrypoint", () => {
  const realpath = vi.fn((path: string) =>
    path.endsWith("/scb") ? "/package/dist/index.mjs" : path
  );

  expect(
    isMainModule(
      "file:///package/dist/index.mjs",
      "/consumer/node_modules/.bin/scb",
      realpath
    )
  ).toBe(true);
});
