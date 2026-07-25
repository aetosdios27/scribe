import { expect, it, vi } from "vitest";

import { StudioEventHub } from "./studio-events.js";

it("broadcasts revisions and detaches closed Studio clients", () => {
  const hub = new StudioEventHub();
  const first = vi.fn();
  const second = vi.fn();
  const unsubscribe = hub.subscribe(first);
  hub.subscribe(second);

  hub.publish(2);
  unsubscribe();
  hub.publish(3);

  expect(first.mock.calls).toEqual([[2]]);
  expect(second.mock.calls).toEqual([[2], [3]]);
});

it("notifies transports when Studio shuts down", () => {
  const hub = new StudioEventHub();
  const close = vi.fn();
  hub.onClose(close);
  hub.close();
  expect(close).toHaveBeenCalledOnce();
});

it("isolates a broken transport from the remaining Studio clients", () => {
  const hub = new StudioEventHub();
  const healthy = vi.fn();
  const broken = vi.fn(() => {
    throw new Error("socket closed");
  });
  hub.subscribe(broken);
  hub.subscribe(healthy);

  expect(() => hub.publish(4)).not.toThrow();
  hub.publish(5);

  expect(broken).toHaveBeenCalledOnce();
  expect(healthy.mock.calls).toEqual([[4], [5]]);
});
