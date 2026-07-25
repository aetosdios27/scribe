import { expect, it } from "vitest";

import { StudioTransactionCoordinator } from "./studio-transactions.js";

it("serializes concurrent mutations and rejects the stale second writer", async () => {
  const coordinator = new StudioTransactionCoordinator(1);
  const applied: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = coordinator.mutate(
    { clientId: "tab-a", operationId: "a-1", baseRevision: 1 },
    async () => {
      await firstBlocked;
      applied.push("first");
      return { accepted: true as const, value: "first" };
    }
  );
  const second = coordinator.mutate(
    { clientId: "tab-b", operationId: "b-1", baseRevision: 1 },
    async () => {
      applied.push("second");
      return { accepted: true as const, value: "second" };
    }
  );

  releaseFirst();

  await expect(first).resolves.toEqual({ kind: "accepted", revision: 2, value: "first" });
  await expect(second).resolves.toEqual({ kind: "stale", revision: 2 });
  expect(applied).toEqual(["first"]);
});

it("returns an accepted operation idempotently without applying it twice", async () => {
  const coordinator = new StudioTransactionCoordinator(4);
  let applications = 0;
  const request = { clientId: "tab-a", operationId: "a-7", baseRevision: 4 };

  const first = await coordinator.mutate(request, async () => {
    applications += 1;
    return { accepted: true as const, value: { source: "# accepted" } };
  });
  const replay = await coordinator.mutate(request, async () => {
    applications += 1;
    return { accepted: true as const, value: { source: "# duplicate" } };
  });

  expect(first).toEqual({ kind: "accepted", revision: 5, value: { source: "# accepted" } });
  expect(replay).toEqual(first);
  expect(applications).toBe(1);
});

it("does not advance the revision when a guarded mutation is rejected", async () => {
  const coordinator = new StudioTransactionCoordinator(2);

  const result = await coordinator.mutate(
    { clientId: "tab-a", operationId: "a-2", baseRevision: 2 },
    async () => ({ accepted: false as const, value: "protected source changed" })
  );

  expect(result).toEqual({ kind: "rejected", revision: 2, value: "protected source changed" });
  expect(coordinator.revision).toBe(2);
});

it("runs system mutations in the same queue as client mutations", async () => {
  const coordinator = new StudioTransactionCoordinator(1);
  const order: string[] = [];

  const system = coordinator.system(async () => {
    order.push("external");
    return { changed: true, value: "external" };
  });
  const client = coordinator.mutate(
    { clientId: "tab-a", operationId: "a-1", baseRevision: 1 },
    async () => {
      order.push("client");
      return { accepted: true as const, value: "client" };
    }
  );

  await expect(system).resolves.toEqual({ changed: true, revision: 2, value: "external" });
  await expect(client).resolves.toEqual({ kind: "stale", revision: 2 });
  expect(order).toEqual(["external"]);
});

it("does not advance the revision for a no-op system observation", async () => {
  const coordinator = new StudioTransactionCoordinator(7);

  const system = await coordinator.system(async () => ({
    changed: false as const,
    value: "same file bytes"
  }));

  expect(system).toEqual({ changed: false, revision: 7, value: "same file bytes" });
  expect(coordinator.revision).toBe(7);
  await expect(coordinator.mutate(
    { clientId: "tab-a", operationId: "a-8", baseRevision: 7 },
    async () => ({ accepted: true as const, value: "edit" })
  )).resolves.toEqual({ kind: "accepted", revision: 8, value: "edit" });
});
