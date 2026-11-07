import { describe, expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresPaymentStatusStore } from "../infrastructure/persistence/payment-status-store.js";

const id = (n: number) => "0198a106-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-08-03T18:00:00.000Z";
function row(intent = 10) {
  return {
    projection_name: "payment_status_v1",
    projection_version: 1,
    projection_generation_id: id(100 + intent),
    source_event_id: id(200 + intent),
    projected_at: at,
    last_rebuilt_at: null,
    freshness_status: "Fresh",
    payment_transaction_id: id(300 + intent),
    payment_intent_id: id(intent),
    payment_attempt_id: id(400 + intent),
    order_id: id(50),
    brand_id: id(1),
    store_id: id(2),
    terminal_status: "Succeeded",
    amount_minor: "1250",
    currency_code: "CAD",
    failure_reason: null,
    retry_disposition: null,
    terminal_occurred_at: at,
    source_aggregate_version: 2,
  };
}
function fixture(rows = [row()], withOrderAuthorization = true) {
  const authorize = vi.fn().mockResolvedValue(true);
  const authorizeOrder = vi.fn().mockResolvedValue(true);
  const query = vi.fn().mockImplementation(async (sql: string) => ({
    rows: sql.includes("FROM rms_payment") ? rows : [],
    rowCount: sql.includes("FROM rms_payment") ? rows.length : 1,
  }));
  const transaction = { query } as unknown as ConsumerTransaction;
  const store = createPostgresPaymentStatusStore({
    scope: {
      brandReference: id(1),
      storeReference: id(2),
      providerAccountReference: id(3),
      environment: "Test",
    },
    authorize,
    ...(withOrderAuthorization ? { authorizeOrder } : {}),
  });
  return {
    authorize,
    authorizeOrder,
    query,
    transaction,
    load: () => store.listByOrder({ transaction, orderReference: id(50) }),
  };
}
describe("Payment terminal projections by Order", () => {
  it("returns per-intent facts with exact scope and both authorization layers", async () => {
    const f = fixture([row(10), row(11)]);
    const result = await f.load();
    expect(result.map((p) => p.snapshot.paymentIntentReference)).toEqual([id(10), id(11)]);
    expect(result[0]?.snapshot.amount).toEqual({ amountMinor: 1250n, currencyCode: "CAD" });
    expect(f.authorizeOrder).toHaveBeenCalledTimes(2);
    expect(f.authorizeOrder).toHaveBeenCalledWith(f.transaction, {
      brandReference: id(1),
      storeReference: id(2),
      orderReference: id(50),
      access: "Read",
    });
    expect(f.query.mock.calls[1]?.[1]).toEqual([id(1), id(2), id(50)]);
    expect(f.authorize).toHaveBeenNthCalledWith(1, f.transaction, {
      brandReference: id(1),
      storeReference: id(2),
      paymentIntentReference: id(10),
      access: "Read",
    });
    expect(f.authorize).toHaveBeenCalledTimes(2);
  });
  it("rejects missing order authorization before any query", async () => {
    const f = fixture([row()], false);
    await expect(f.load()).rejects.toMatchObject({ code: "PAYMENT_STATUS_PERMISSION_DENIED" });
    expect(f.query).not.toHaveBeenCalled();
  });
  it("rejects denied order authorization before any query", async () => {
    const f = fixture();
    f.authorizeOrder.mockResolvedValue(false);
    await expect(f.load()).rejects.toMatchObject({ code: "PAYMENT_STATUS_PERMISSION_DENIED" });
    expect(f.query).not.toHaveBeenCalled();
  });
  it("does not return a partial list when intent authorization fails", async () => {
    const f = fixture([row(10), row(11)]);
    f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(f.load()).rejects.toMatchObject({ code: "PAYMENT_STATUS_PERMISSION_DENIED" });
  });
  it("rechecks order authorization after intent reads", async () => {
    const f = fixture();
    f.authorizeOrder.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(f.load()).rejects.toMatchObject({ code: "PAYMENT_STATUS_PERMISSION_DENIED" });
  });
  it.each(["order_id", "store_id", "brand_id"])("rejects a foreign %s", async (key) => {
    const f = fixture([{ ...row(), [key]: id(99) }]);
    await expect(f.load()).rejects.toMatchObject({ code: "PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE" });
  });
  it("rejects duplicate active intent generations", async () => {
    await expect(fixture([row(), row()]).load()).rejects.toMatchObject({
      code: "PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("rejects overflow without silently truncating", async () => {
    await expect(
      fixture(Array.from({ length: 101 }, (_, n) => row(n + 10))).load(),
    ).rejects.toMatchObject({ code: "PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE" });
  });
  it("returns empty facts for no terminal projections", async () => {
    expect(await fixture([]).load()).toEqual([]);
  });
  it("does not expose unrelated private columns", async () => {
    const result = await fixture([Object.assign(row(), { provider_secret: "private" })]).load();
    expect(
      JSON.stringify(result, (_, value) => (typeof value === "bigint" ? value.toString() : value)),
    ).not.toContain("private");
  });
});
