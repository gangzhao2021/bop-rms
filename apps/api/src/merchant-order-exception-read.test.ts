import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createMerchantOrderExceptionRead } from "./merchant-order-exception-read.js";
const id = (n: number) => "0190ed90-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  sessionReference: id(4),
};
const at = "2026-09-12T15:00:00.000Z";
function fixture() {
  const tx = { query: vi.fn() } as ConsumerTransaction;
  const authorize = vi.fn(async () => scope);
  const list = vi.fn(async () => ({ items: [], nextAfterSourceReference: null as string | null }));
  const metadata = vi.fn(async () => ({
    storeLabel: "Synthetic Store",
    businessDate: "2026-09-12",
    checkpointReference: id(5),
    projectedAt: at,
    freshnessStatus: "Stale" as const,
  }));
  const read = createMerchantOrderExceptionRead({
    transactions: { run: async (work) => work(tx) },
    authorize,
    sources: () => ({ list }),
    metadata,
  });
  return { read, authorize, list, metadata };
}
it("returns a bounded empty view only after both authorizations and explicit metadata", async () => {
  const f = fixture();
  expect(await f.read("synthetic-cookie")).toMatchObject({
    screenId: "OPS-ORDER-EXCEPTION",
    items: [],
    freshnessStatus: "Stale",
  });
  expect(f.authorize).toHaveBeenCalledTimes(2);
  expect(f.authorize.mock.calls[0]).toBeDefined();
});
it("rejects Store switching before returning the view", async () => {
  const f = fixture();
  f.authorize.mockResolvedValueOnce(scope).mockResolvedValue({ ...scope, storeReference: id(6) });
  await expect(f.read("synthetic-cookie")).rejects.toThrow("MERCHANT_ORDER_EXCEPTION_UNAVAILABLE");
});
it("does not return a silently truncated source list", async () => {
  const f = fixture();
  let cursor = 10;
  f.list.mockImplementation(async () => ({ items: [], nextAfterSourceReference: id(cursor++) }));
  await expect(f.read("synthetic-cookie")).rejects.toThrow("MERCHANT_ORDER_EXCEPTION_UNAVAILABLE");
  expect(f.list).toHaveBeenCalledTimes(5);
  expect(f.metadata).not.toHaveBeenCalled();
});

it("uses only trusted metadata source checks for a current older exception read", async () => {
  const source = {
    sourceReference: id(7),
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    orderReference: id(8),
    paymentReference: id(9),
    diningReference: null,
    kind: "PaidWithoutFulfillableOrder" as const,
    severity: "Critical" as const,
    sourceOwner: "Payment" as const,
    sourceStatus: "Open" as const,
    providerState: "Confirmed" as const,
    compensationStatus: "Pending" as const,
    sourceVersion: 1n,
    sourceDigest: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-09-12T14:00:00.000Z",
    updatedAt: "2026-09-12T14:01:00.000Z",
    resolutionEvidenceReference: null,
  };
  let checked = false;
  const read = createMerchantOrderExceptionRead({
    transactions: { run: async (work) => work({ query: vi.fn() }) },
    authorize: async () => scope,
    sources: () => ({ list: async () => ({ items: [source], nextAfterSourceReference: null }) }),
    metadata: async (_tx, selected, sources) => {
      expect(selected).toEqual(scope);
      expect(sources).toEqual([source]);
      expect(Object.isFrozen(sources)).toBe(true);
      return {
        storeLabel: "Synthetic Store",
        businessDate: "2026-09-12",
        checkpointReference: id(5),
        projectedAt: at,
        freshnessStatus: "Fresh",
        ...(checked ? { currentSourceCheck: "Complete" as const } : {}),
      };
    },
  });
  expect((await read({ currentSourceCheck: "Complete" })).freshnessStatus).toBe("Stale");
  checked = true;
  const result = await read("synthetic-cookie");
  expect(result.freshnessStatus).toBe("Fresh");
  expect(result.items[0]).toMatchObject({ status: "Open", compensationStatus: "Pending" });
  expect(result).not.toHaveProperty("currentSourceCheck");
});
