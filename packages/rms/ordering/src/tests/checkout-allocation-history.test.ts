import { expect, it, vi } from "vitest";
import { createPostgresCheckoutAllocationHistory } from "../infrastructure/persistence/checkout-session-allocation-store.js";
import type { CartQueryTransaction } from "../infrastructure/persistence/cart-query-store.js";
const id = (n: number) => "0190ed93-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = { brandReference: id(1), storeReference: id(2) };
const input = {
  cartReference: id(3),
  expectedCartVersion: 5,
  observedAt: "2026-09-20T12:00:00.000Z",
};
const allocation = (n = 10) => ({
  ...scope,
  cartReference: id(3),
  cartVersion: 2,
  quoteReference: id(n),
  quoteVersion: 1,
  guestSessionReference: id(4),
  createOperationReference: id(n + 1),
  checkoutSessionReference: id(n + 2),
  submissionReference: id(n + 3),
  paymentOperationReference: id(n + 4),
  allocatedAt: "2026-09-20T11:00:00.000Z",
});
function fixture(found: unknown[] = [allocation()], version = 5) {
  const authorize = vi.fn(async () => true);
  const query = vi.fn<CartQueryTransaction["query"]>(async (sql) => {
    if (sql.includes("FOR UPDATE")) return { rows: [{ aggregate_version: version }] };
    if (sql.includes("AS allocation"))
      return { rows: found.map((value) => ({ allocation: value })) };
    return { rows: [] };
  });
  const reader = createPostgresCheckoutAllocationHistory({ scope, authorize });
  return { reader, authorize, query, tx: { query } };
}
it("locks Cart before collecting all attempts across Cart versions without a CheckoutSession join", async () => {
  const second = { ...allocation(20), cartVersion: 4 };
  const f = fixture([allocation(), second]);
  const result = await f.reader.load(f.tx, input);
  expect(result).toEqual([allocation(), second]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(f.authorize).toHaveBeenCalledTimes(2);
  expect(f.query.mock.calls[1]?.[0]).toContain("FOR UPDATE");
  expect(f.query.mock.calls[2]?.[0]).not.toContain("JOIN");
  expect(f.query.mock.calls[2]?.[1]).toEqual([id(1), id(2), id(3)]);
});
it("returns an empty history only after locking a matching Cart", async () => {
  const f = fixture([]);
  expect(await f.reader.load(f.tx, input)).toEqual([]);
  const stale = fixture([], 4);
  await expect(stale.reader.load(stale.tx, input)).rejects.toMatchObject({
    code: "INTENT_CONFLICT",
  });
});
it.each([0, 1])("rejects authorization denial at stage %s", async (stage) => {
  const f = fixture();
  if (stage === 0) f.authorize.mockResolvedValue(false);
  else f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.reader.load(f.tx, input)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  if (stage === 0) expect(f.query).not.toHaveBeenCalled();
});
it.each([
  { storeReference: id(99) },
  { cartReference: id(99) },
  { cartVersion: 6 },
  { allocatedAt: "2026-09-21T00:00:00.000Z" },
  { quoteVersion: 3 },
])("rejects invalid history %j", async (change) => {
  const f = fixture([{ ...allocation(), ...change }]);
  await expect(f.reader.load(f.tx, input)).rejects.toThrow();
});
it("rejects duplicate identities and over-limit history without returning a partial result", async () => {
  for (const found of [[allocation(), allocation()], Array(1001).fill(allocation())]) {
    const f = fixture(found);
    await expect(f.reader.load(f.tx, input)).rejects.toThrow();
  }
});
it("rejects missing Cart and database failures without leaking details", async () => {
  const f = fixture();
  f.query.mockResolvedValue({ rows: [] });
  await expect(f.reader.load(f.tx, input)).rejects.toThrow();
  f.query.mockRejectedValue(new Error("private failure"));
  await expect(f.reader.load(f.tx, input)).rejects.toMatchObject({
    code: "DEPENDENCY_UNAVAILABLE",
  });
});

it("replacement history requires complete submission coverage after collecting allocation history", async () => {
  const f = fixture();
  const base = f.query.getMockImplementation();
  f.query.mockImplementation(async (sql, values) =>
    sql.includes("AS uncovered") ? { rows: [{ uncovered: false }] } : base?.(sql, values),
  );
  expect(await f.reader.loadForReplacement(f.tx, input)).toEqual([allocation()]);
  expect(f.authorize).toHaveBeenCalledTimes(3);
  const coverage = f.query.mock.calls.find(([sql]) => sql.includes("AS uncovered"));
  expect(coverage?.[1]).toEqual([id(1), id(2), id(3), 5, input.observedAt]);
});
it.each([true, null, "false"])(
  "replacement denies uncovered or malformed coverage %s",
  async (uncovered) => {
    const f = fixture();
    const base = f.query.getMockImplementation();
    f.query.mockImplementation(async (sql, values) =>
      sql.includes("AS uncovered") ? { rows: [{ uncovered }] } : base?.(sql, values),
    );
    await expect(f.reader.loadForReplacement(f.tx, input)).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
  },
);
it("replacement rechecks authorization after submission coverage", async () => {
  const f = fixture();
  const base = f.query.getMockImplementation();
  f.query.mockImplementation(async (sql, values) =>
    sql.includes("AS uncovered") ? { rows: [{ uncovered: false }] } : base?.(sql, values),
  );
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.reader.loadForReplacement(f.tx, input)).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
});
it("empty allocated history does not bypass submission coverage", async () => {
  const f = fixture([]);
  const base = f.query.getMockImplementation();
  f.query.mockImplementation(async (sql, values) =>
    sql.includes("AS uncovered") ? { rows: [{ uncovered: true }] } : base?.(sql, values),
  );
  await expect(f.reader.loadForReplacement(f.tx, input)).rejects.toThrow();
});
