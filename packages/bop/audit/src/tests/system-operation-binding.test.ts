import { expect, it, vi } from "vitest";
import { verifySystemAuditOperationBinding } from "../index.js";
const id = (n: number) => `0190ee73-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const input = {
  auditId: id(1),
  brandId: id(2),
  storeId: id(3),
  targetId: id(4),
  correlationId: id(5),
  actionCode: "INVENTORY_RESERVATION_RELEASE",
  targetType: "InventoryReservation",
  reasonCode: "CHECKOUT_DEADLINE_REACHED",
  sourceChannel: "SYSTEM",
  occurredAt: "2026-09-21T05:00:00.000Z",
};
it("requires authority before and after exact System linkage query", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ matched: true }] }),
    authorize = vi.fn().mockResolvedValue(true);
  expect(await verifySystemAuditOperationBinding({ query }, input, authorize)).toBe(true);
  expect(authorize).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[0]?.[0]).toContain("actor_reference IS NULL");
  expect(query.mock.calls[0]?.[1]).toContain(input.correlationId);
});
it("rejects initial denial without querying", async () => {
  const query = vi.fn();
  expect(await verifySystemAuditOperationBinding({ query }, input, async () => false)).toBe(false);
  expect(query).not.toHaveBeenCalled();
});
it("rejects authorization revoked after matched evidence", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ matched: true }] }),
    authorize = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await verifySystemAuditOperationBinding({ query }, input, authorize)).toBe(false);
});
it.each([
  { rows: [] },
  { rows: [{ matched: false }] },
  { rows: [{ matched: true }, { matched: true }] },
])("rejects missing or ambiguous match", async (result) => {
  expect(
    await verifySystemAuditOperationBinding(
      { query: vi.fn().mockResolvedValue(result) },
      input,
      async () => true,
    ),
  ).toBe(false);
});
it("rejects malformed timestamp before querying", async () => {
  const query = vi.fn();
  expect(
    await verifySystemAuditOperationBinding(
      { query },
      { ...input, occurredAt: "2026-02-30T00:00:00.000Z" },
      async () => true,
    ),
  ).toBe(false);
  expect(query).not.toHaveBeenCalled();
});
