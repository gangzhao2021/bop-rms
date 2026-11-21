import type { ConsumerTransaction } from "@bop/eventing";
import { expect, it, vi } from "vitest";
import { loadCheckoutAllocationSubmittedBatch } from "../infrastructure/persistence/checkout-session-allocation-store.js";
import { loadCheckoutSessionDeadline } from "../infrastructure/persistence/checkout-session-store.js";

const id = (n: number) => `0190ee42-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const allocation = {
  brandReference: id(1),
  storeReference: id(2),
  guestSessionReference: id(3),
  createOperationReference: id(4),
  cartReference: id(5),
  cartVersion: 3,
  quoteReference: id(6),
  quoteVersion: 2,
  checkoutSessionReference: id(7),
  submissionReference: id(8),
  paymentOperationReference: id(9),
  allocatedAt: "2026-10-11T22:00:00.000Z",
};
const tx = (rows: unknown[]) => {
  const query = vi.fn<(sql: string, values?: readonly unknown[]) => Promise<unknown>>(
    async (sql) => ({
      rows: sql.startsWith("SELECT set_config") ? [] : rows,
      rowCount: rows.length,
    }),
  );
  return { query, tx: { query } as unknown as ConsumerTransaction };
};
it("WP-2423: reports whether the allocation's own submission produced its batch", async () => {
  const yes = tx([{ batches: 1 }]);
  expect(await loadCheckoutAllocationSubmittedBatch(yes.tx, allocation)).toBe(true);
  expect(yes.query.mock.calls[1]?.[1]).toEqual([id(1), id(2), id(8), id(5), 3, id(6)]);
  expect(String(yes.query.mock.calls[1]?.[0])).toContain("FROM rms_ordering.order_batch");
  expect(await loadCheckoutAllocationSubmittedBatch(tx([{ batches: 0 }]).tx, allocation)).toBe(
    false,
  );
  for (const rows of [[{ batches: 2 }], [], [{ batches: "1" }], [{ batches: 1, extra: 1 }]])
    await expect(loadCheckoutAllocationSubmittedBatch(tx(rows).tx, allocation)).rejects.toThrow();
  await expect(
    loadCheckoutAllocationSubmittedBatch(tx([{ batches: 1 }]).tx, {
      ...allocation,
      cartVersion: 0,
    }),
  ).rejects.toThrow();
});
it("WP-2423: returns no deadline when the checkout session is absent and refuses ambiguity", async () => {
  expect(await loadCheckoutSessionDeadline(tx([]).tx, allocation)).toBeNull();
  await expect(loadCheckoutSessionDeadline(tx([{}, {}]).tx, allocation)).rejects.toThrow();
  await expect(
    loadCheckoutSessionDeadline(tx([{ snapshot_json: { schemaVersion: 1 } }]).tx, allocation),
  ).rejects.toThrow();
});
