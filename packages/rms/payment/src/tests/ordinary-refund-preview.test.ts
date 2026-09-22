import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresOrdinaryRefundRequestStore } from "../infrastructure/persistence/ordinary-refund-request-store.js";
import { encodeOrdinaryRefundRequest } from "../application/ordinary-refund-request.js";
import { ordinaryRefundRequestFixture } from "./ordinary-refund-request.fixture.js";
function setup() {
  const request = ordinaryRefundRequestFixture();
  const state = { existing: [] as { record: string }[] };
  const query = vi.fn(async (sql: string) => {
    if (/INSERT|UPDATE |DELETE|SAVEPOINT/u.test(sql)) throw new Error("UNEXPECTED_WRITE");
    return {
      rows: sql.includes("clock_timestamp")
        ? [{ now: request.requestedAt }]
        : sql.includes("operation_id=$3")
          ? state.existing
          : [],
      rowCount: null,
    };
  });
  const authorize = vi.fn(async () => true),
    validateSources = vi.fn(async () => [
      {
        paymentAttemptReference: request.payments[0]?.paymentAttemptReference,
        capturedAmountMinor: 7000n,
        otherOccupiedAmountMinor: 0n,
      },
    ]);
  const store = createPostgresOrdinaryRefundRequestStore({
    scope: request,
    authorize,
    validateSources: validateSources as Parameters<
      typeof createPostgresOrdinaryRefundRequestStore
    >[0]["validateSources"],
  });
  const audit = {
    auditId: request.auditReference,
    brandId: request.brandReference,
    storeId: request.storeReference,
    actor: { type: "User", reference: request.actorReference },
    actionCode: "PAYMENT_ORDINARY_REFUND_REQUESTED",
    targetType: "PaymentRefundRequest",
    targetId: request.requestReference,
    correlationId: request.operationReference,
    occurredAt: request.requestedAt,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Restricted",
    reasonCode: request.reasonCode,
    retentionPolicyCode: "FINANCIAL_COMPLIANCE",
    retentionPolicyVersion: 1,
  };
  return {
    request,
    state,
    query,
    authorize,
    validateSources,
    run: () => store.preview({ query } as unknown as ConsumerTransaction, request, audit),
  };
}
it("validates actual sources and returns current version without recording a claim or audit", async () => {
  const f = setup();
  expect(await f.run()).toEqual({ status: "Previewed", claimVersion: 0 });
  expect(f.validateSources).toHaveBeenCalledOnce();
  expect(f.query.mock.calls.some(([sql]) => /INSERT|UPDATE |DELETE|SAVEPOINT/u.test(sql))).toBe(
    false,
  );
});
it("applies other occupied balance to previews", async () => {
  const f = setup();
  f.validateSources.mockResolvedValue([
    {
      paymentAttemptReference: f.request.payments[0]?.paymentAttemptReference,
      capturedAmountMinor: 7000n,
      otherOccupiedAmountMinor: 2000n,
    },
  ]);
  await expect(f.run()).rejects.toThrow("ORDINARY_REFUND_BALANCE_EXCEEDED");
});
it("does not preview already committed operations as a new request", async () => {
  const f = setup();
  f.state.existing = [{ record: encodeOrdinaryRefundRequest(f.request) }];
  await expect(f.run()).rejects.toThrow("ORDINARY_REFUND_REQUEST_CONFLICT");
});
it("checks current authorization after source validation", async () => {
  const f = setup();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.run()).rejects.toThrow("ORDINARY_REFUND_PERMISSION_DENIED");
});
it("rejects stale claim version before source computation", async () => {
  const f = setup();
  f.request.expectedClaimVersion = 1;
  await expect(f.run()).rejects.toThrow("ORDINARY_REFUND_REQUEST_CONFLICT");
  expect(f.validateSources).not.toHaveBeenCalled();
});
