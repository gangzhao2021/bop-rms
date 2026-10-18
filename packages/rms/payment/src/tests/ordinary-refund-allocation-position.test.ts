import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresOrdinaryRefundRequestPositionSource } from "../infrastructure/persistence/ordinary-refund-request-store.js";
import { encodeOrdinaryRefundRequest } from "../application/ordinary-refund-request.js";
import {
  ordinaryRefundRequestFixture,
  refundRequestId as id,
} from "./ordinary-refund-request.fixture.js";
function setup() {
  const request = ordinaryRefundRequestFixture();
  const payment = request.payments[0];
  if (!payment) throw Error("fixture");
  const scope = {
    tenantReference: request.tenantReference,
    brandReference: request.brandReference,
    storeReference: request.storeReference,
  };
  const input = {
    orderReference: request.orderReference,
    paymentTransactionReference: payment.paymentTransactionReference,
    paymentIntentReference: payment.paymentIntentReference,
    paymentAttemptReference: payment.paymentAttemptReference,
    observedAt: request.requestedAt,
  };
  const history = [request];
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("ORDER BY claim_version")
      ? history.map((r, i) => ({ record: encodeOrdinaryRefundRequest(r), version: String(i + 1) }))
      : [],
    rowCount: null,
  }));
  const tx = { query } as unknown as ConsumerTransaction;
  const authorize = vi.fn(async () => true);
  const readOutcome = vi.fn<
    Parameters<typeof createPostgresOrdinaryRefundRequestPositionSource>[0]["readOutcome"]
  >(async () => ({
    confirmedMinor: 6000n,
    pendingMinor: 0n,
    observationCount: 1,
    historyDigest: "sha256:" + "a".repeat(64),
  }));
  const read = createPostgresOrdinaryRefundRequestPositionSource({ scope, authorize, readOutcome });
  return {
    request,
    history,
    query,
    tx,
    input,
    authorize,
    readOutcome,
    read: () => read(tx, input),
  };
}
it("binds the fully confirmed payment to its immutable order and tip components", async () => {
  const f = setup();
  expect(await f.read()).toMatchObject({
    confirmedMinor: 6000n,
    pendingMinor: 0n,
    confirmedOrderAllocationMinor: 5500n,
    confirmedTipMinor: 500n,
    unallocatedConfirmedMinor: 0n,
  });
  expect(f.readOutcome).toHaveBeenCalledWith(f.tx, {
    request: f.request,
    payment: f.request.payments[0],
    observedAt: f.input.observedAt,
  });
  expect(f.query.mock.calls[1]?.[0]).toContain("pg_advisory_xact_lock");
});
it("does not proportionally infer components for a partial confirmation", async () => {
  const f = setup();
  f.readOutcome.mockResolvedValue({
    confirmedMinor: 3000n,
    pendingMinor: 3000n,
    observationCount: 1,
    historyDigest: "sha256:" + "b".repeat(64),
  });
  expect(await f.read()).toMatchObject({
    confirmedMinor: 3000n,
    pendingMinor: 3000n,
    confirmedOrderAllocationMinor: 0n,
    confirmedTipMinor: 0n,
    unallocatedConfirmedMinor: 3000n,
  });
});
it("keeps an undispatched request entirely pending", async () => {
  const f = setup();
  f.readOutcome.mockResolvedValue(null);
  expect(await f.read()).toMatchObject({
    confirmedMinor: 0n,
    pendingMinor: 6000n,
    confirmedOrderAllocationMinor: 0n,
    confirmedTipMinor: 0n,
    unallocatedConfirmedMinor: 0n,
  });
});
it("accumulates distinct confirmed units without losing tax or tip", async () => {
  const f = setup(),
    second = ordinaryRefundRequestFixture();
  second.expectedClaimVersion = 1;
  second.requestReference = id(30);
  second.operationReference = id(31);
  second.auditReference = id(32);
  const item = second.payments[0]?.items[0];
  if (!item) throw Error("fixture");
  item.refundUnitOrdinals = [2];
  f.history.push(second);
  expect(await f.read()).toMatchObject({
    confirmedMinor: 12000n,
    confirmedOrderAllocationMinor: 11000n,
    confirmedTipMinor: 1000n,
    unallocatedConfirmedMinor: 0n,
  });
});
it("rejects duplicate claimed units across immutable requests", async () => {
  const f = setup(),
    second = ordinaryRefundRequestFixture();
  second.expectedClaimVersion = 1;
  second.requestReference = id(30);
  second.operationReference = id(31);
  f.history.push(second);
  await expect(f.read()).rejects.toThrow("ORDINARY_REFUND_HISTORY_UNAVAILABLE");
});
it("rejects a payment binding mismatch before reading its outcome", async () => {
  const f = setup();
  f.input.paymentTransactionReference = id(90);
  await expect(f.read()).rejects.toThrow("ORDINARY_REFUND_HISTORY_UNAVAILABLE");
  expect(f.readOutcome).not.toHaveBeenCalled();
});
it("rechecks authority after computing financial evidence", async () => {
  const f = setup();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.read()).rejects.toThrow("ORDINARY_REFUND_PERMISSION_DENIED");
});
