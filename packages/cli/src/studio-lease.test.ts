import { expect, it } from "vitest";

import { StudioWriterLease } from "./studio-lease.js";

it("grants one writer, renews it, and refuses a competing tab", () => {
  let now = 1_000;
  const lease = new StudioWriterLease(8_000, () => now);

  expect(lease.acquire("tab-a")).toEqual({ granted: true, expiresAt: 9_000 });
  now = 2_000;
  expect(lease.acquire("tab-a")).toEqual({ granted: true, expiresAt: 10_000 });
  expect(lease.acquire("tab-b")).toEqual({ granted: false, expiresAt: 10_000 });
  expect(lease.holds("tab-a")).toBe(true);
  expect(lease.holds("tab-b")).toBe(false);
});

it("allows another tab after expiry or an explicit release", () => {
  let now = 100;
  const lease = new StudioWriterLease(50, () => now);
  lease.acquire("tab-a");
  now = 151;
  expect(lease.acquire("tab-b").granted).toBe(true);
  lease.release("tab-b");
  expect(lease.acquire("tab-c").granted).toBe(true);
});
