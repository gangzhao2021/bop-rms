import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresProviderCaptureEvidenceQuery } from "../infrastructure/persistence/provider-capture-exception-store.js";
const id = (n: number) => "0190fa01-0000-7000-8000-" + String(n).padStart(12, "0");
function fixture() {
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
  const row = {
    tenant_id: id(1),
    brand_id: id(2),
    store_id: id(3),
    reconciliation_exception_id: id(4),
    amount_minor: "2260",
    currency_code: "CAD",
    environment: "Test",
    occurred_at: new Date("2026-09-20T03:35:37.236Z"),
    observed_at: new Date("2026-09-22T00:00:00.000Z"),
  };
  const rows: unknown[] = [row],
    authorize = vi.fn(async () => true);
  const query = vi.fn(async (sql: string) => ({
    rows: sql.startsWith("SELECT tenant_id") ? rows : [],
    rowCount: rows.length,
  }));
  const tx = { query } as unknown as ConsumerTransaction;
  return {
    scope,
    row,
    rows,
    authorize,
    query,
    read: () => createPostgresProviderCaptureEvidenceQuery({ scope, authorize })(tx, id(4)),
  };
}
it("returns only money/time/environment and historical reason under explicit scoped purpose", async () => {
  const f = fixture();
  expect(await f.read()).toEqual({
    amountMinor: "2260",
    currencyCode: "CAD",
    environment: "Test",
    occurredAt: f.row.occurred_at.toISOString(),
    observedAt: f.row.observed_at.toISOString(),
    recordedReason: "ProviderCaptureWithoutInternalOperation",
  });
  expect(f.query.mock.calls[1]?.[0]).toContain(
    "WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND reconciliation_exception_id=$4",
  );
  expect(f.authorize).toHaveBeenCalledTimes(2);
  expect(f.authorize.mock.calls[0]).toEqual([
    expect.anything(),
    { ...f.scope, exceptionReference: id(4), purpose: "ReadPaymentReconciliationEvidence" },
  ]);
});
it("distinguishes no recorded capture evidence without claiming reconciliation", async () => {
  const f = fixture();
  f.rows.length = 0;
  expect(await f.read()).toBeNull();
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
it("denies before reads and rechecks permission after reading", async () => {
  const f = fixture();
  f.authorize.mockResolvedValueOnce(false);
  await expect(f.read()).rejects.toMatchObject({
    code: "PAYMENT_RECONCILIATION_PERMISSION_DENIED",
  });
  expect(f.query).not.toHaveBeenCalled();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.read()).rejects.toMatchObject({
    code: "PAYMENT_RECONCILIATION_PERMISSION_DENIED",
  });
});
it.each(["tenant_id", "brand_id", "store_id", "reconciliation_exception_id"] as const)(
  "rejects mismatched %s",
  async (key) => {
    const f = fixture();
    f.row[key] = id(9);
    await expect(f.read()).rejects.toThrow();
  },
);
it("rejects duplicate, invalid amount and reversed time evidence", async () => {
  const f = fixture();
  f.rows.push(f.row);
  await expect(f.read()).rejects.toThrow();
  f.rows.pop();
  f.row.amount_minor = "0";
  await expect(f.read()).rejects.toThrow();
  f.row.amount_minor = "2260";
  f.row.observed_at = new Date("2026-01-01T00:00:00.000Z");
  await expect(f.read()).rejects.toThrow();
});
