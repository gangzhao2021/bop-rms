import { parseOrderingReference } from "../domain/cart.js";
import { beforeEach, expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
const mocks = vi.hoisted(() => ({ revision: vi.fn() }));
vi.mock("../infrastructure/persistence/order-revision-position.js", () => ({
  createPostgresOrderRevisionPosition: () => mocks.revision,
}));
import { createPostgresOrderCancelledAmountSource } from "../infrastructure/persistence/order-cancelled-amount-source.js";
const id = (n: number) => "0190faec-0000-7000-8000-" + String(n).padStart(12, "0");
beforeEach(() => vi.resetAllMocks());
function fixture() {
  const money = {
    subtotalMinor: 1000n,
    discountMinor: 0n,
    feeMinor: 0n,
    taxMinor: 130n,
    totalMinor: 1130n,
  };
  const base = {
    brandReference: id(1),
    storeReference: id(2),
    orderReference: id(3),
    observedAt: "2026-09-22T01:00:00.000Z",
    currencyCode: "CAD" as const,
    basis: "SubmittedItemSnapshots" as const,
    tipIncluded: false as const,
    amendmentAdjustmentsIncluded: false as const,
    ...money,
    totalMinor: 2260n,
    batches: [
      { orderBatchReference: parseOrderingReference(id(4)), itemCount: 1, ...money },
      { orderBatchReference: parseOrderingReference(id(5)), itemCount: 1, ...money },
    ],
    snapshotDigest: "sha256:" + "a".repeat(64),
  };
  const row = {
    cancellation_id: id(6),
    order_batch_id: id(5),
    cancelled_at: "2026-09-22T00:59:00.000Z",
    cancelled_order_version: 4,
    source_bound: true,
  };
  const rows: (typeof row)[] = [row];
  const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
  const tx = { query: query as typeof query & ConsumerTransaction["query"] };
  const authorize = vi.fn(async () => true);
  mocks.revision.mockResolvedValue({ version: 4, snapshotDigest: "sha256:" + "b".repeat(64) });
  const load = createPostgresOrderCancelledAmountSource({ ...base, authorize });
  return { base, row, rows, tx, query, authorize, load: () => load(tx, base) };
}
it("deducts only cancelled batch and binds its frozen price and revision", async () => {
  const f = fixture(),
    result = await f.load();
  expect(result.cancelledTotalMinor).toBe(1130n);
  expect(f.base.totalMinor).toBe(2260n);
  expect(mocks.revision).toHaveBeenCalledWith(f.tx, {
    orderReference: f.base.orderReference,
    observedAt: f.base.observedAt,
  });
  expect(f.query).toHaveBeenCalledWith(
    expect.stringContaining("r.previous_revision_id=c.expected_source_checkpoint"),
    [f.base.brandReference, f.base.storeReference, f.base.orderReference],
  );
});
it("does not deduct absent cancellations, including Pickup", async () => {
  const f = fixture();
  f.rows.length = 0;
  expect((await f.load()).cancelledTotalMinor).toBe(0n);
  expect(mocks.revision).not.toHaveBeenCalled();
});
it.each([
  "unbound",
  "future",
  "unknown-batch",
  "duplicate",
  "future-version",
  "authorization",
  "chain",
])("rejects %s without returning a deduction", async (kind) => {
  const f = fixture();
  if (kind === "unbound") f.row.source_bound = false;
  if (kind === "future") f.row.cancelled_at = "2026-09-23T00:00:00.000Z";
  if (kind === "unknown-batch") f.row.order_batch_id = id(9);
  if (kind === "duplicate") f.rows.push({ ...f.row });
  if (kind === "future-version") f.row.cancelled_order_version = 5;
  if (kind === "authorization")
    f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  if (kind === "chain") mocks.revision.mockRejectedValue(new Error("unbound"));
  await expect(f.load()).rejects.toThrow("ORDER_CANCELLED_AMOUNT_UNAVAILABLE");
});
it("includes cancellation identity even when the amount is unchanged", async () => {
  const f = fixture(),
    first = await f.load();
  f.row.cancellation_id = id(7);
  expect((await f.load()).snapshotDigest).not.toBe(first.snapshotDigest);
});
