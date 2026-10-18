import { expect, it, vi } from "vitest";
import { createPostgresGuestCheckoutRecovery } from "../infrastructure/persistence/checkout-session-allocation-store.js";
const id = (n: number) => `0190ee75-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const allocation = {
  brandReference: id(1),
  storeReference: id(2),
  guestSessionReference: id(3),
  createOperationReference: id(4),
  cartReference: id(5),
  cartVersion: 1,
  quoteReference: id(6),
  quoteVersion: 1,
  checkoutSessionReference: id(7),
  submissionReference: id(8),
  paymentOperationReference: id(9),
  allocatedAt: "2026-09-21T05:00:00.000Z",
};
const input = { guestSessionReference: id(3), observedAt: "2026-09-21T06:00:00.000Z" };
function fixture(found: unknown[] = [{ allocation, created: allocation.allocatedAt }]) {
  const query = vi.fn().mockImplementation(async (sql: string) => ({
    rows: sql.startsWith("SELECT jsonb_build_object") ? found : [],
  }));
  const authorize = vi.fn().mockResolvedValue(true);
  return {
    query,
    authorize,
    source: createPostgresGuestCheckoutRecovery({ scope: allocation, authorize }),
  };
}
it("returns only the matched Guest checkout and reauthorizes", async () => {
  const f = fixture();
  expect(await f.source.latest({ query: f.query }, input)).toEqual(allocation);
  expect(f.authorize).toHaveBeenCalledTimes(2);
  const call = f.query.mock.calls[1];
  expect(call?.[1]).toEqual([id(1), id(2), id(3), input.observedAt]);
  expect(call?.[0]).toContain("JOIN rms_ordering.checkout_session_record");
});
it("returns null when no completed checkout exists", async () => {
  const f = fixture([]);
  expect(await f.source.latest({ query: f.query }, input)).toBeNull();
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
it.each([
  { allocation: { ...allocation, guestSessionReference: id(90) }, created: allocation.allocatedAt },
  { allocation: { ...allocation, storeReference: id(90) }, created: allocation.allocatedAt },
  { allocation, created: "2026-09-21T04:00:00.000Z" },
  { allocation, created: "2026-09-21T07:00:00.000Z" },
])("rejects mismatched or temporally invalid rows", async (row) => {
  const f = fixture([row]);
  await expect(f.source.latest({ query: f.query }, input)).rejects.toThrow();
});
it("rejects permission revoked after reading", async () => {
  const f = fixture();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.source.latest({ query: f.query }, input)).rejects.toThrow();
});
it("does not query after initial denial", async () => {
  const f = fixture();
  f.authorize.mockResolvedValue(false);
  await expect(f.source.latest({ query: f.query }, input)).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
