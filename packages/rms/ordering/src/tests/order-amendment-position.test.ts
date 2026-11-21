import { expect, it, vi } from "vitest";
import { createPostgresOrderAmendmentPosition } from "../infrastructure/persistence/dining-session-order-inventory.js";
const id = (n: number) => "0190fac3-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-20T00:00:00.000Z";
const row = {
  amendment_id: id(4),
  quote_id: id(5),
  delta_minor: "-100",
  currency_code: "CAD",
  original_total_minor: "1000",
  revised_total_minor: "900",
  requested_at: new Date(at),
  status: "PendingApproval",
  version: 1,
  occurred_at: new Date(at),
  history_count: "1",
  minimum_version: 1,
  future_history: false,
};
async function read(
  rows: (typeof row)[],
  authorizeAndFence = async () => true,
  parentPresent = true,
) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({
      rows: parentPresent ? [{ order_id: id(3), created_at: new Date(at) }] : [],
    })
    .mockResolvedValueOnce({ rows: rows.map((row) => ({ amendment_id: row.amendment_id })) })
    .mockResolvedValueOnce({ rows });
  return createPostgresOrderAmendmentPosition({
    brandReference: id(1),
    storeReference: id(2),
    authorizeAndFence,
  }).load({ query }, { orderReference: id(3), observedAt: at });
}
it("retains pending and applied signed price changes", async () => {
  const r = await read([row, { ...row, amendment_id: id(6), status: "Applied" }]);
  expect(r.pendingCount).toBe(1);
  expect(r.appliedDeltaMinor).toBe(-100n);
  expect(r.amendments[1]?.deltaMinor).toBe("-100");
});
it.each([
  { ...row, history_count: "0" },
  { ...row, status: "Unknown" },
  { ...row, future_history: true },
  { ...row, minimum_version: 2 },
  { ...row, delta_minor: "1.5" },
  { ...row, currency_code: "USD" },
  { ...row, revised_total_minor: "800" },
])("rejects incomplete or invalid states %#", async (value) => {
  await expect(read([value])).rejects.toThrow("ORDER_AMENDMENT_POSITION_UNAVAILABLE");
});
it("reauthorizes the completed read", async () => {
  let calls = 0;
  await expect(read([], async () => ++calls === 1)).rejects.toThrow();
});
it("distinguishes no amendments from unavailable evidence", async () => {
  expect((await read([])).pendingCount).toBe(0);
  await expect(read([], async () => false)).rejects.toThrow();
});

it("does not treat a missing or foreign Order as zero pending", async () => {
  await expect(read([], async () => true, false)).rejects.toThrow(
    "ORDER_AMENDMENT_POSITION_UNAVAILABLE",
  );
});
it("only applied changes contribute to signed adjustment", async () => {
  const result = await read([
    row,
    { ...row, amendment_id: id(6), status: "Rejected" },
    {
      ...row,
      amendment_id: id(7),
      status: "Applied",
      delta_minor: "250",
      revised_total_minor: "1250",
    },
    { ...row, amendment_id: id(8), status: "Applied", delta_minor: "-100" },
  ]);
  expect(result.appliedDeltaMinor).toBe(150n);
});
it("bounds persisted monetary deltas", async () => {
  await expect(read([{ ...row, delta_minor: "9223372036854775808" }])).rejects.toThrow();
});

it("rejects state inventory not covered by parent locks", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ order_id: id(3), created_at: new Date(at) }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [row] });
  await expect(
    createPostgresOrderAmendmentPosition({
      brandReference: id(1),
      storeReference: id(2),
      authorizeAndFence: async () => true,
    }).load({ query }, { orderReference: id(3), observedAt: at }),
  ).rejects.toThrow();
});
it("locks scoped parents before reading latest states, without a global table lock", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ order_id: id(3), created_at: new Date(at) }] })
    .mockResolvedValueOnce({ rows: [{ amendment_id: row.amendment_id }] })
    .mockResolvedValueOnce({ rows: [row] });
  await createPostgresOrderAmendmentPosition({
    brandReference: id(1),
    storeReference: id(2),
    authorizeAndFence: async () => true,
  }).load({ query }, { orderReference: id(3), observedAt: at });
  expect(query.mock.calls[1]?.[0]).toContain("order_header");
  expect(query.mock.calls[1]?.[0]).toContain("FOR UPDATE");
  expect(query.mock.calls[2]?.[0]).toContain("ORDER BY amendment_id LIMIT 1001 FOR UPDATE");
  expect(query.mock.calls[2]?.[1]).toEqual([id(1), id(2), id(3)]);
  expect(query.mock.calls.some(([sql]) => String(sql).includes("LOCK TABLE"))).toBe(false);
});
