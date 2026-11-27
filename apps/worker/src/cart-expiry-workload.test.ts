import { afterEach, expect, it, vi } from "vitest";
import { createCartExpiryWorkload } from "./cart-expiry-workload.js";
afterEach(() => vi.useRealTimers());
const config = { pageSize: 2, pollIntervalMs: 10, drainDeadlineMs: 100 };
const cart = (cartReference: string) => ({ cartReference, expectedAggregateVersion: 1 });
it("advances past stale candidates and wraps for changed versions", async () => {
  vi.useFakeTimers();
  const discover = vi.fn(async (_limit: number, after: string | null) =>
    after === null ? [cart("a"), cart("b")] : [cart("c")],
  );
  const expire = vi.fn(async () => "Stale" as const);
  const work = createCartExpiryWorkload({ ...config, discover, expire });
  await work.start();
  await vi.advanceTimersByTimeAsync(20);
  await work.stop();
  expect(discover.mock.calls).toEqual([
    [2, null],
    [2, "b"],
    [2, null],
  ]);
  expect(expire).toHaveBeenCalledTimes(5);
  expect(vi.getTimerCount()).toBe(0);
});
it("fails on unclassified command error without continuing or hiding failure", async () => {
  vi.useFakeTimers();
  const expire = vi.fn().mockRejectedValue(new Error("private dependency details"));
  const work = createCartExpiryWorkload({
    ...config,
    discover: async () => [cart("a"), cart("b")],
    expire,
  });
  await expect(work.start()).rejects.toThrow("OUTBOX_WORKLOAD_FAILED");
  await expect(work.completion).resolves.toBe("failed");
  await vi.advanceTimersByTimeAsync(100);
  expect(expire).toHaveBeenCalledTimes(1);
  await work.stop();
});
it("drains the in-flight command and skips the rest of the page", async () => {
  vi.useFakeTimers();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const expire = vi.fn(async () => {
    await held;
    return "Applied" as const;
  });
  const work = createCartExpiryWorkload({
    ...config,
    discover: async () => [cart("a"), cart("b")],
    expire,
  });
  const starting = work.start();
  await vi.advanceTimersByTimeAsync(100);
  expect(expire).toHaveBeenCalledTimes(1);
  const stopping = work.stop();
  release();
  await starting;
  await stopping;
  expect(expire).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it.each([
  { page: [cart("b"), cart("a")] },
  { page: [cart("a"), cart("a")] },
  { page: [cart("a"), cart("b"), cart("c")] },
  { page: [cart("a"), { ...cart("b"), expectedAggregateVersion: 0 }] },
])("validates the entire page before any writes: %j", async ({ page }) => {
  const expire = vi.fn();
  const work = createCartExpiryWorkload({ ...config, discover: async () => page, expire });
  await expect(work.start()).rejects.toThrow("OUTBOX_WORKLOAD_FAILED");
  expect(expire).not.toHaveBeenCalled();
  await work.stop();
});
it("rejects an unrecognized success result", async () => {
  const work = createCartExpiryWorkload({
    ...config,
    discover: async () => [cart("a")],
    expire: vi.fn().mockResolvedValue("Unknown"),
  });
  await expect(work.start()).rejects.toThrow("OUTBOX_WORKLOAD_FAILED");
  await work.stop();
});
