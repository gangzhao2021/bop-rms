import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresDiningSessionOrderLookup } from "../infrastructure/persistence/dining-session-order-lookup.js";
const id = (n: number) => `0190fa60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const input = {
  diningSessionReference: id(3),
  guestSessionReference: id(4),
  observedAt: "2026-09-20T08:00:00.000Z",
};
function fixture(rows: readonly Record<string, unknown>[] = []) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    .mockResolvedValue({ rows, rowCount: rows.length });
  const authorize = vi.fn().mockResolvedValue(true);
  const store = createPostgresDiningSessionOrderLookup({
    brandReference: id(1),
    storeReference: id(2),
    authorize,
  });
  return { query, authorize, store, transaction: { query } as ConsumerTransaction };
}
it("returns a unique parent while retaining exact scope and session filters", async () => {
  const f = fixture([{ order_id: id(5) }]);
  await expect(f.store.load(f.transaction, input)).resolves.toBe(id(5));
  expect(f.query.mock.calls[1]?.[1]).toEqual([id(1), id(2), id(3), input.observedAt]);
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
it("returns no parent only when the authorized query has no history", async () => {
  const f = fixture();
  await expect(f.store.load(f.transaction, input)).resolves.toBeNull();
});
it("denies before accessing persistence", async () => {
  const f = fixture();
  f.authorize.mockResolvedValue(false);
  await expect(f.store.load(f.transaction, input)).rejects.toThrow(
    "DINING_SESSION_ORDER_LOOKUP_UNAVAILABLE",
  );
  expect(f.query).not.toHaveBeenCalled();
});
it("rejects authority revoked during the read", async () => {
  const f = fixture([{ order_id: id(5) }]);
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.store.load(f.transaction, input)).rejects.toThrow(
    "DINING_SESSION_ORDER_LOOKUP_UNAVAILABLE",
  );
});
it("rejects ambiguous parent history instead of choosing a convenient Order", async () => {
  const f = fixture([{ order_id: id(5) }, { order_id: id(6) }]);
  await expect(f.store.load(f.transaction, input)).rejects.toThrow(
    "DINING_SESSION_ORDER_LOOKUP_UNAVAILABLE",
  );
});
