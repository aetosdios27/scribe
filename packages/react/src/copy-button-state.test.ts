import { expect, it } from "vitest";

import { reduceCopyStatus } from "./copy-button-state.js";

it("models copied feedback and reset without coupling it to the article", () => {
  expect(reduceCopyStatus("idle", "copy-success")).toBe("copied");
  expect(reduceCopyStatus("idle", "copy-error")).toBe("error");
  expect(reduceCopyStatus("copied", "reset")).toBe("idle");
});
