import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ submitted: vi.fn(), amendments: vi.fn(), cancelled: vi.fn() }));
vi.mock("../infrastructure/persistence/submitted-order-amount-source.js", () => ({
  createPostgresSubmittedOrderAmountSource: () => mock.submitted,
}));
vi.mock("../infrastructure/persistence/dining-session-order-inventory.js", () => ({
  createPostgresOrderAmendmentPosition: () => ({ load: mock.amendments }),
}));
vi.mock("../infrastructure/persistence/order-cancelled-amount-source.js", () => ({
  createPostgresOrderCancelledAmountSource: () => mock.cancelled,
}));
import { createPostgresOrderPricedAmountSource } from "../infrastructure/order-priced-amount-source.js";
const id = (n: number) => "0190faec-0000-7000-8000-" + String(n).padStart(12, "0");
const scope = { brandReference: id(1), storeReference: id(2) },
  query = { orderReference: id(3), observedAt: "2026-09-20T00:00:00.000Z" };
beforeEach(() => vi.resetAllMocks());
function setup() {
  const base = {
    ...scope,
    ...query,
    currencyCode: "CAD",
    tipIncluded: false,
    amendmentAdjustmentsIncluded: false,
    totalMinor: 1000n,
    snapshotDigest: "sha256:" + "a".repeat(64),
  };
  const changes = {
    ...scope,
    ...query,
    amendments: [] as { amendmentReference: string; status: string; deltaMinor: string }[],
    appliedDeltaMinor: 0n,
    pendingCount: 0,
  };
  mock.cancelled.mockResolvedValue({
    cancelledTotalMinor: 0n,
    snapshotDigest: "sha256:" + "c".repeat(64),
  });
  mock.submitted.mockResolvedValue(base);
  mock.amendments.mockResolvedValue(changes);
  const authorize = vi.fn(async () => true),
    tx = { query: vi.fn() };
  const load = createPostgresOrderPricedAmountSource({ ...scope, authorize });
  return { base, changes, tx, authorize, load: () => load(tx, query) };
}
it("composes same scoped observation and transaction, preserves submitted prices", async () => {
  const f = setup(),
    value = await f.load();
  expect(value.pricedTotalMinor).toBe(1000n);
  expect(value.pendingAmendmentCount).toBe(0);
  expect(mock.submitted).toHaveBeenCalledWith(f.tx, query);
  expect(mock.amendments).toHaveBeenCalledWith(f.tx, query);
  expect(Object.isFrozen(value)).toBe(true);
  expect(value).not.toHaveProperty("financialFinalityReference");
});
it("counts pending changes but prices only Applied changes", async () => {
  const f = setup();
  f.changes.amendments = [
    { amendmentReference: id(4), status: "Applied", deltaMinor: "-100" },
    { amendmentReference: id(5), status: "PendingApproval", deltaMinor: "-500" },
    { amendmentReference: id(6), status: "Rejected", deltaMinor: "-200" },
  ];
  f.changes.appliedDeltaMinor = -100n;
  f.changes.pendingCount = 1;
  const value = await f.load();
  expect(value.pricedTotalMinor).toBe(900n);
  expect(value.pendingAmendmentCount).toBe(1);
  expect(value.submittedTotalMinor).toBe(1000n);
  expect(Object.isFrozen(value.amendments[0])).toBe(true);
});
it.each(["scope", "time", "currency", "tip", "double-count", "pending", "adjustment", "digest"])(
  "rejects inconsistent owner position %s",
  async (kind) => {
    const f = setup();
    if (kind === "scope") f.changes.storeReference = id(9);
    if (kind === "time") f.changes.observedAt = "2026-09-20T00:01:00.000Z";
    if (kind === "currency") f.base.currencyCode = "USD";
    if (kind === "tip") f.base.tipIncluded = true;
    if (kind === "double-count") f.base.amendmentAdjustmentsIncluded = true;
    if (kind === "pending") f.changes.pendingCount = 1;
    if (kind === "adjustment") f.changes.appliedDeltaMinor = 1n;
    if (kind === "digest") f.base.snapshotDigest = "invalid";
    await expect(f.load()).rejects.toThrow("ORDER_PRICED_AMOUNT_UNAVAILABLE");
  },
);
it("fails on unavailable source or revoked current authorization", async () => {
  const f = setup();
  mock.amendments.mockRejectedValueOnce(new Error("private"));
  await expect(f.load()).rejects.toThrow("ORDER_PRICED_AMOUNT_UNAVAILABLE");
  f.authorize.mockResolvedValue(false);
  await expect(f.load()).rejects.toThrow("ORDER_PRICED_AMOUNT_UNAVAILABLE");
});
it.each(["-1001", "9223372036854775807"])("rejects an invalid adjusted total %s", async (delta) => {
  const f = setup();
  f.changes.amendments = [{ amendmentReference: id(4), status: "Applied", deltaMinor: delta }];
  f.changes.appliedDeltaMinor = BigInt(delta);
  await expect(f.load()).rejects.toThrow("ORDER_PRICED_AMOUNT_UNAVAILABLE");
});
it("binds amendment state evidence in digest even when total stays unchanged", async () => {
  const f = setup(),
    original = await f.load();
  f.changes.amendments = [{ amendmentReference: id(4), status: "PendingKitchen", deltaMinor: "0" }];
  f.changes.pendingCount = 1;
  const changed = await f.load();
  expect(changed.pricedTotalMinor).toBe(original.pricedTotalMinor);
  expect(changed.snapshotDigest).not.toBe(original.snapshotDigest);
});

it("deducts cancelled batch frozen amount without changing submitted history", async () => {
  const f = setup();
  mock.cancelled.mockResolvedValue({
    cancelledTotalMinor: 400n,
    snapshotDigest: "sha256:" + "d".repeat(64),
  });
  const value = await f.load();
  expect(value.submittedTotalMinor).toBe(1000n);
  expect(value.pricedTotalMinor).toBe(600n);
  expect(value.cancelledBatchTotalMinor).toBe(400n);
  expect(mock.cancelled).toHaveBeenCalledWith(f.tx, f.base);
});
it.each([-1n, 1001n])("rejects invalid cancellation deduction %s", async (amount) => {
  const f = setup();
  mock.cancelled.mockResolvedValue({
    cancelledTotalMinor: amount,
    snapshotDigest: "sha256:" + "d".repeat(64),
  });
  await expect(f.load()).rejects.toThrow("ORDER_PRICED_AMOUNT_UNAVAILABLE");
});
