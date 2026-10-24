import type { ConsumerTransaction } from "@bop/eventing";
import { expect, it, vi } from "vitest";
import { createPostgresDiningCheckoutExpiryCandidates } from "../infrastructure/persistence/order-batch-checkout-expiry-store.js";
const id = (n: number) => `0190ee31-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-21T02:00:00.000Z";
const candidate = (n = 20) => ({
  orderReference: id(19),
  orderBatchReference: id(n),
  allocation: {
    brandReference: id(1),
    storeReference: id(2),
    guestSessionReference: id(3),
    cartReference: id(4),
    cartVersion: 1,
    quoteReference: id(5),
    quoteVersion: 2,
    createOperationReference: id(6),
    checkoutSessionReference: id(7),
    submissionReference: id(8),
    paymentOperationReference: id(9),
    allocatedAt: "2026-09-21T01:00:00.000Z",
  },
});
function fixture(rows: unknown[] = [candidate()]) {
  const authorize = vi.fn(async () => true);
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("FROM rms_ordering.order_batch b") ? rows : [],
    rowCount: rows.length,
  }));
  const tx = { query: query as typeof query & ConsumerTransaction["query"] };
  const source = createPostgresDiningCheckoutExpiryCandidates({
    brandReference: id(1),
    storeReference: id(2),
    authorize,
  });
  return { source, tx, authorize, query };
}
it("returns immutable exact allocations in monotonic order with the requested bound", async () => {
  const f = fixture([candidate(20), candidate(21)]);
  const found = await f.source.discover(f.tx, { observedAt: at, after: id(18), limit: 2 });
  expect(found).toEqual([candidate(20), candidate(21)]);
  expect(Object.isFrozen(found)).toBe(true);
  expect(Object.isFrozen(found[0]?.allocation)).toBe(true);
  expect(f.query.mock.calls[1]).toBeDefined();
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
it.each([0, 101, 1.5])("rejects invalid page bound %s before SQL", async (limit) => {
  const f = fixture();
  await expect(f.source.discover(f.tx, { observedAt: at, after: null, limit })).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
it("refuses revoked discovery before SQL or after reading", async () => {
  const f = fixture();
  f.authorize.mockResolvedValueOnce(false);
  await expect(
    f.source.discover(f.tx, { observedAt: at, after: null, limit: 2 }),
  ).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(
    f.source.discover(f.tx, { observedAt: at, after: null, limit: 2 }),
  ).rejects.toThrow();
});
it.each([
  { rows: [candidate(21), candidate(20)] },
  { rows: [candidate(20), candidate(20)] },
  { rows: [candidate(20), candidate(21), candidate(22)] },
  { rows: [{ ...candidate(), allocation: { ...candidate().allocation, storeReference: id(99) } }] },
  {
    rows: [
      {
        ...candidate(),
        allocation: { ...candidate().allocation, allocatedAt: "2026-09-22T01:00:00.000Z" },
      },
    ],
  },
  { rows: [{ ...candidate(), unexpected: true }] },
])("rejects a malformed or cross-scope page: %j", async ({ rows }) => {
  const f = fixture(rows);
  await expect(
    f.source.discover(f.tx, { observedAt: at, after: null, limit: 2 }),
  ).rejects.toThrow();
});
it("rejects a candidate at or behind the supplied cursor", async () => {
  const f = fixture();
  await expect(
    f.source.discover(f.tx, { observedAt: at, after: id(20), limit: 2 }),
  ).rejects.toThrow();
});
