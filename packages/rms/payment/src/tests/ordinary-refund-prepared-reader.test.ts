import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresOrdinaryRefundPreparedReader } from "../infrastructure/persistence/ordinary-refund-operation-store.js";
import { encodeOrdinaryRefundOperation as encode } from "../application/ordinary-refund-operation.js";
import { refundRequestId as id } from "./ordinary-refund-request.fixture.js";
function fixture() {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    requestReference: id(5),
    operationReference: id(6),
    providerOperationReference: id(7),
    paymentTransactionReference: id(8),
    paymentIntentReference: id(9),
    paymentAttemptReference: id(10),
    firstCaptureReference: id(11),
    providerAccountReference: id(12),
    executorReference: id(13),
    auditReference: id(14),
    approvalReference: null,
    claimVersion: 1,
    claimsDigest: "sha256:" + "a".repeat(64),
    allocationDigest: "sha256:" + "b".repeat(64),
    preparedAt: "2026-09-13T12:00:00.000Z",
    environment: "Test",
    currencyCode: "CAD",
    amountMinor: 6000n,
    policyVersion: "PILOT_ORDINARY_REFUND_V1",
    status: "Prepared",
  };
}
function setup(records: unknown[] = [fixture()]) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.startsWith("SELECT record_json")
      ? records.map((record) => ({ record: encode(record) }))
      : [],
    rowCount: 0,
  }));
  const authorize = vi.fn(async () => true);
  const source = createPostgresOrdinaryRefundPreparedReader({
    scope: { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    providerAccountReference: id(12),
    environment: "Test",
    authorize,
  });
  const input = {
    orderReference: id(4),
    requestReference: id(5),
    paymentAttemptReference: id(10),
    observedAt: "2026-09-20T12:00:00.000Z",
  };
  return { source, input, authorize, query, tx: { query } as unknown as ConsumerTransaction };
}
it("recovers preparation with only order fence and rechecks current permission", async () => {
  const f = setup();
  expect((await f.source(f.tx, f.input))?.operationReference).toBe(id(6));
  expect(f.authorize).toHaveBeenCalledTimes(2);
  const locks = f.query.mock.calls.filter(([sql]) => sql.includes("pg_advisory_xact_lock"));
  expect(locks).toHaveLength(1);
  expect(f.query.mock.calls.some(([sql]) => /INSERT|UPDATE|DELETE/u.test(sql))).toBe(false);
});
it("distinguishes missing preparation without inventing an operation", async () => {
  const f = setup([]);
  expect(await f.source(f.tx, f.input)).toBeNull();
});
it.each([
  "tenantReference",
  "brandReference",
  "storeReference",
  "orderReference",
  "requestReference",
  "paymentAttemptReference",
  "providerAccountReference",
])("rejects mismatched %s", async (key) => {
  const f = setup([{ ...fixture(), [key]: id(99) }]);
  await expect(f.source(f.tx, f.input)).rejects.toThrow();
});
it("rejects future, duplicate or revoked preparation reads", async () => {
  const future = setup([{ ...fixture(), preparedAt: "2026-09-21T00:00:00.000Z" }]);
  await expect(future.source(future.tx, future.input)).rejects.toThrow();
  const duplicate = setup([fixture(), fixture()]);
  await expect(duplicate.source(duplicate.tx, duplicate.input)).rejects.toThrow();
  const revoked = setup();
  revoked.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(revoked.source(revoked.tx, revoked.input)).rejects.toThrow();
});
