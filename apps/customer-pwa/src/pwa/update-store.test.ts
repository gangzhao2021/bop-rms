import { describe, expect, it, vi } from "vitest";
import { createPwaUpdateStore } from "./update-store.js";

describe("WP-1708 prompt-only update store", () => {
  it("never activates a waiting worker on a sensitive route", async () => {
    const activate = vi.fn(async () => undefined);
    const store = createPwaUpdateStore();
    store.notifyWaiting(activate);
    await store.activate("/checkout/payment");
    await store.activate("/orders/018f7c00-0000-7000-8000-000000000001");
    expect(activate).not.toHaveBeenCalled();
    expect(store.getState()).toEqual({ status: "waiting" });
  });

  it("activates once only after an explicit action on a safe route", async () => {
    const activate = vi.fn(async () => undefined);
    const store = createPwaUpdateStore();
    store.notifyWaiting(activate);
    expect(activate).not.toHaveBeenCalled();
    await store.activate("/menu");
    await store.activate("/menu");
    expect(activate).toHaveBeenCalledTimes(1);
    expect(store.getState()).toEqual({ status: "applying" });
  });

  it("returns to waiting after a bounded activation failure", async () => {
    const store = createPwaUpdateStore();
    store.notifyWaiting(async () => {
      throw new Error("synthetic");
    });
    await store.activate("/");
    expect(store.getState()).toEqual({ status: "waiting" });
  });
});
