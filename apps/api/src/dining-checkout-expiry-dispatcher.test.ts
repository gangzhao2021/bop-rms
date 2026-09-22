import { expect, it, vi } from "vitest";
import { createDiningCheckoutExpiryDispatcher } from "./dining-checkout-expiry-dispatcher.js";
const mocks = vi.hoisted(() => ({ discover: vi.fn(), record: vi.fn() }));
vi.mock("@rms/ordering", () => ({
  createPostgresDiningCheckoutExpiryCandidates: () => ({ discover: mocks.discover }),
}));
vi.mock("./dining-checkout-expiry-recorder.js", () => ({
  createDiningCheckoutExpiryRecorder: () => ({ record: mocks.record }),
}));
const candidate = (orderBatchReference: string) => ({
  orderReference: "order",
  orderBatchReference,
  allocation: {},
});
function fixture() {
  let scanning = false;
  const tx = { query: vi.fn() };
  mocks.discover.mockReset().mockResolvedValue([]);
  mocks.record.mockReset().mockImplementation(async () => {
    expect(scanning).toBe(false);
    return { status: "Existing" };
  });
  const options = {
    scope: {
      tenantReference: "tenant",
      brandReference: "brand",
      storeReference: "store",
      providerAccountReference: "account",
      environment: "Test" as const,
    },
    transactions: {
      async run<T>(work: (transaction: typeof tx) => Promise<T>) {
        scanning = true;
        try {
          return await work(tx);
        } finally {
          scanning = false;
        }
      },
    },
    authorize: async () => true,
    authorizeDiscovery: async () => true,
    now: () => "2026-09-21T02:00:00.000Z",
    newReference: () => "reference",
    pageSize: 2,
  };
  return { work: createDiningCheckoutExpiryDispatcher(options), options };
}
it("advances past unresolved or not-due Batches and wraps after a short page", async () => {
  const { work } = fixture();
  mocks.discover
    .mockResolvedValueOnce([candidate("a"), candidate("b")])
    .mockResolvedValueOnce([candidate("c")]);
  mocks.record
    .mockResolvedValueOnce({ status: "NotDue" })
    .mockResolvedValueOnce({ status: "NotStarted" });
  expect(await work.runOnce()).toBe(2);
  expect(await work.runOnce()).toBe(1);
  expect(await work.runOnce()).toBe(0);
  expect(mocks.discover.mock.calls.map((call) => call[1].after)).toEqual([null, "b", null]);
  expect(mocks.discover.mock.calls.every((call) => call[1].limit === 2)).toBe(true);
  await work.stop();
});
it("shares concurrent polling and drains one active record without starting the next", async () => {
  const { work } = fixture();
  mocks.discover.mockResolvedValue([candidate("a"), candidate("b")]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  mocks.record.mockImplementation(async () => {
    entered();
    await held;
    return { status: "Created" };
  });
  const first = work.runOnce();
  expect(work.runOnce()).toBe(first);
  await started;
  const stopped = work.stop();
  release();
  expect(await first).toBe(1);
  expect(await stopped).toBe("drained");
  expect(mocks.record).toHaveBeenCalledTimes(1);
  expect(await work.runOnce()).toBe(0);
});
it("propagates a recording failure without processing later Batches", async () => {
  const { work } = fixture();
  mocks.discover.mockResolvedValue([candidate("a"), candidate("b")]);
  mocks.record.mockRejectedValue(new Error("RECORD_UNAVAILABLE"));
  await expect(work.runOnce()).rejects.toThrow("RECORD_UNAVAILABLE");
  expect(mocks.record).toHaveBeenCalledTimes(1);
  await work.stop();
});
it("propagates discovery failure without recording", async () => {
  const { work } = fixture();
  mocks.discover.mockRejectedValue(new Error("DISCOVERY_UNAVAILABLE"));
  await expect(work.runOnce()).rejects.toThrow("DISCOVERY_UNAVAILABLE");
  expect(mocks.record).not.toHaveBeenCalled();
  await work.stop();
});
it("does not advance the page on an unrecognized recorder result", async () => {
  const { work } = fixture();
  mocks.discover.mockResolvedValue([candidate("a")]);
  mocks.record.mockResolvedValue({ status: "Cancelled" });
  await expect(work.runOnce()).rejects.toThrow("DINING_CHECKOUT_EXPIRY_DISPATCH_FAILED");
  await work.stop();
});
it.each([0, 101, 1.5])("rejects an invalid configured bound %s", (pageSize) => {
  const { options } = fixture();
  expect(() => createDiningCheckoutExpiryDispatcher({ ...options, pageSize })).toThrow(
    "DINING_CHECKOUT_EXPIRY_DISPATCHER_CONFIG_INVALID",
  );
});
