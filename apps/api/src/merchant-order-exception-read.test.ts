import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import type { OrderExceptionSource } from "@bop/projection";
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
  const listOpen = vi.fn(async () => ({
    items: [] as OrderExceptionSource[],
    next: null as string | null,
  }));
  const listResolved = vi.fn(async () => ({
    items: [] as OrderExceptionSource[],
    next: null as string | null,
  }));
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
    sources: () => ({ listOpen, listResolved }),
    metadata,
  });
  return { read, authorize, listOpen, listResolved, metadata };
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
it("does not return a silently truncated open list", async () => {
  const f = fixture();
  let cursor = 10;
  f.listOpen.mockImplementation(async () => ({ items: [], next: id(cursor++) }));
  await expect(f.read("synthetic-cookie")).rejects.toThrow("MERCHANT_ORDER_EXCEPTION_UNAVAILABLE");
  expect(f.listOpen).toHaveBeenCalledTimes(10);
  expect(f.metadata).not.toHaveBeenCalled();
});
const sourceOf = (n: number, status: "Open" | "Final" = "Open") => ({
  sourceReference: id(n),
  tenantReference: scope.tenantReference,
  brandReference: scope.brandReference,
  storeReference: scope.storeReference,
  orderReference: id(n + 100_000),
  paymentReference: id(n + 200_000),
  diningReference: null,
  kind: "PaidWithoutFulfillableOrder" as const,
  severity: "Critical" as const,
  sourceOwner: "Payment" as const,
  sourceStatus: status,
  providerState: "Unknown" as const,
  compensationStatus: status === "Final" ? ("Completed" as const) : ("Pending" as const),
  sourceVersion: 1n,
  sourceDigest: `sha256:${"a".repeat(64)}`,
  createdAt: "2026-09-12T14:58:00.000Z",
  updatedAt: "2026-09-12T14:59:00.000Z",
  resolutionEvidenceReference: status === "Final" ? id(n + 300_000) : null,
});
it("WP-2423: lists every open case past 500 and one page of resolved history with its cursor", async () => {
  const f = fixture();
  const open = Array.from({ length: 530 }, (_, n) => sourceOf(1000 + n));
  f.listOpen.mockImplementation(async (...args: unknown[]) => {
    const input = args[1] as { afterSourceReference: string | null; limit: number };
    const start =
      input.afterSourceReference === null
        ? 0
        : open.findIndex((s) => s.sourceReference === input.afterSourceReference) + 1;
    const items = open.slice(start, start + input.limit);
    return {
      items,
      next: start + input.limit < open.length ? (items.at(-1)?.sourceReference ?? null) : null,
    };
  });
  const resolved = Array.from({ length: 25 }, (_, n) => sourceOf(9000 - n, "Final"));
  f.listResolved.mockResolvedValue({ items: resolved, next: id(8976) });
  const result = await f.read("synthetic-cookie", { resolvedBefore: id(9001) });
  expect(f.listResolved).toHaveBeenCalledWith(expect.anything(), {
    beforeSourceReference: id(9001),
    limit: 25,
  });
  expect(result.items.filter((item) => item.status === "Open")).toHaveLength(530);
  expect(result.items.filter((item) => item.status === "Resolved")).toHaveLength(25);
  expect(result.olderResolvedBefore).toBe(id(8976));
  await expect(f.read("synthetic-cookie", { resolvedBefore: "not-a-reference" })).rejects.toThrow(
    "MERCHANT_ORDER_EXCEPTION_UNAVAILABLE",
  );
});
it("DEC-EXCEPTION-CONFIRMED-REFUND-DUE: a confirmed refund is due at its business day's end, others in 15 minutes", async () => {
  const confirmed = { ...sourceOf(40), providerState: "Confirmed" as const };
  const unconfirmed = sourceOf(41);
  const dayEnd = "2026-09-13T04:00:00.000Z";
  const refundCheckDueAt = vi.fn(async () => new Map([[id(40), dayEnd]]));
  const read = createMerchantOrderExceptionRead({
    transactions: { run: async (work) => work({ query: vi.fn() }) },
    authorize: async () => scope,
    sources: () => ({
      listOpen: async () => ({ items: [confirmed, unconfirmed], next: null }),
      listResolved: async () => ({ items: [], next: null }),
    }),
    refundCheckDueAt,
    metadata: async () => ({
      storeLabel: "Synthetic Store",
      businessDate: "2026-09-12",
      checkpointReference: id(5),
      projectedAt: at,
      freshnessStatus: "Fresh",
      currentSourceCheck: "Complete" as const,
    }),
  });
  const result = await read("synthetic-cookie");
  expect(refundCheckDueAt).toHaveBeenCalledWith(expect.anything(), scope, [confirmed]);
  expect(result.items.find((item) => item.exceptionReference === id(40))?.dueAt).toBe(dayEnd);
  expect(result.items.find((item) => item.exceptionReference === id(41))?.dueAt).toBe(
    "2026-09-12T15:13:00.000Z",
  );
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
  const orderNumbers = vi.fn(async () => new Map([[id(8), "13"]]));
  const read = createMerchantOrderExceptionRead({
    transactions: { run: async (work) => work({ query: vi.fn() }) },
    authorize: async () => scope,
    sources: () => ({
      listOpen: async () => ({ items: [source], next: null }),
      listResolved: async () => ({ items: [], next: null }),
    }),
    orderNumbers,
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
  // WP-2423: staff see the linked order's number.
  expect(result.items[0]?.orderNumber).toBe("13");
  expect(orderNumbers).toHaveBeenCalledWith(expect.anything(), scope, [id(8)]);
  expect(result).not.toHaveProperty("currentSourceCheck");
});
it("WP-2423: says what each payment reconciliation difference is about, and only for those", async () => {
  const base = {
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    paymentReference: null,
    diningReference: null,
    severity: "High" as const,
    sourceOwner: "Payment" as const,
    providerState: "Confirmed" as const,
    compensationStatus: "NotRequested" as const,
    sourceVersion: 1n,
    sourceDigest: `sha256:${"b".repeat(64)}`,
    createdAt: "2026-09-12T14:00:00.000Z",
    updatedAt: "2026-09-12T14:30:00.000Z",
  };
  const day = {
    ...base,
    sourceReference: id(20),
    orderReference: null,
    kind: "PaymentReconciliationDifference" as const,
    sourceStatus: "Final" as const,
    resolutionEvidenceReference: id(21),
  };
  const linked = {
    ...base,
    sourceReference: id(22),
    orderReference: id(23),
    paymentReference: id(24),
    kind: "PaidWithoutFulfillableOrder" as const,
    sourceStatus: "Open" as const,
    resolutionEvidenceReference: null,
  };
  const detail = {
    type: "BusinessDayTotals" as const,
    businessDate: "2026-09-11",
    captured: { storeMinor: "5650", providerMinor: "5650" },
    refunded: { storeMinor: "0", providerMinor: "2260" },
    checkedAt: "2026-09-12T08:00:03.000Z",
    resolvedAt: "2026-09-12T14:30:00.000Z",
  };
  const reconciliationDetails = vi.fn(async () => new Map([[id(20), detail]]));
  const read = createMerchantOrderExceptionRead({
    transactions: { run: async (work) => work({ query: vi.fn() }) },
    authorize: async () => scope,
    sources: () => ({
      listOpen: async () => ({ items: [linked], next: null }),
      listResolved: async () => ({ items: [day], next: null }),
    }),
    reconciliationDetails,
    metadata: async () => ({
      storeLabel: "Synthetic Store",
      businessDate: "2026-09-12",
      checkpointReference: id(5),
      projectedAt: at,
      freshnessStatus: "Fresh",
      currentSourceCheck: "Complete" as const,
    }),
  });
  const result = await read("synthetic-cookie");
  expect(reconciliationDetails).toHaveBeenCalledWith(expect.anything(), scope, [day]);
  expect(result.items.find((item) => item.exceptionReference === id(20))).toMatchObject({
    status: "Resolved",
    reconciliation: detail,
  });
  expect(result.items.find((item) => item.exceptionReference === id(22))).not.toHaveProperty(
    "reconciliation",
  );
});
