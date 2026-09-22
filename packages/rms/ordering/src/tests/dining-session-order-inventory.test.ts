import { expect, it, vi } from "vitest";
import { createPostgresDiningSessionOrderInventory } from "../infrastructure/persistence/dining-session-order-inventory.js";
const id = (n: number) => "0190fac0-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-20T00:00:00.000Z",
  scope = { brandReference: id(1), storeReference: id(2) },
  input = { diningSessionReference: id(3), observedAt: at };
const batch = (n: number, kind = "Initial") => ({
  order_batch_id: id(n),
  submission_id: id(n + 100),
  quote_id: id(n + 200),
  submitted_at: new Date(at),
  submission_kind: kind,
  bound: true,
});
function fixture(
  rows: unknown[] = [batch(5), batch(6, "Additional")],
  authorizeAndFence = async () => true,
) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ order_id: id(4), created_at: new Date(at) }] })
    .mockResolvedValueOnce({ rows });
  return {
    query,
    source: createPostgresDiningSessionOrderInventory({ ...scope, authorizeAndFence }),
  };
}
it("returns all linked batches without claiming financial or execution finality", async () => {
  const f = fixture();
  const result = await f.source.load({ query: f.query }, input);
  expect(result.orders[0]?.batches).toHaveLength(2);
  expect(result.orders[0]?.batches[1]?.kind).toBe("Additional");
  expect(result.orders[0]).not.toHaveProperty("financialClass");
});
it.each(
  [
    [],
    [batch(5, "Additional")],
    [batch(5), batch(6)],
    [{ ...batch(5), bound: false }],
    [{ ...batch(5), submitted_at: new Date("2026-09-21T00:00:00.000Z") }],
    [batch(5), { ...batch(6, "Additional"), submission_id: id(105) }],
  ].map((rows) => ({ rows })),
)("rejects incomplete or inconsistent inventory %#", async ({ rows }) => {
  const f = fixture(rows);
  await expect(f.source.load({ query: f.query }, input)).rejects.toThrow(
    "DINING_ORDER_INVENTORY_UNAVAILABLE",
  );
});
it("denies before querying", async () => {
  const f = fixture(undefined, async () => false);
  await expect(f.source.load({ query: f.query }, input)).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
it("rejects authority revoked after reading", async () => {
  let calls = 0;
  const f = fixture(undefined, async () => ++calls === 1);
  await expect(f.source.load({ query: f.query }, input)).rejects.toThrow();
});
it("does not silently truncate oversized batches", async () => {
  const f = fixture(
    Array.from({ length: 1001 }, (_, i) => batch(i + 5, i === 0 ? "Initial" : "Additional")),
  );
  await expect(f.source.load({ query: f.query }, input)).rejects.toThrow();
});
