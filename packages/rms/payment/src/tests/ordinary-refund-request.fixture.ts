export const refundRequestId = (n: number) =>
  "01909980-0000-7000-8000-" + n.toString(16).padStart(12, "0");
export function ordinaryRefundRequestFixture(at = "2026-09-13T10:00:00.000Z") {
  const id = refundRequestId;
  return {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    requestReference: id(5),
    operationReference: id(6),
    actorReference: id(7),
    auditReference: id(8),
    expectedClaimVersion: 0,
    policyVersion: "PILOT_ORDINARY_REFUND_V1",
    allocationVersion: "ORDINARY_REFUND_ALLOCATION_V1",
    reasonCode: "CUSTOMER_REQUEST",
    requestedAt: at,
    currencyCode: "CAD",
    amountMinor: 6000n,
    payments: [
      {
        paymentTransactionReference: id(9),
        paymentIntentReference: id(10),
        paymentAttemptReference: id(11),
        firstCaptureReference: id(12),
        sourceReference: id(13),
        sourceDigest: "sha256:" + "a".repeat(64),
        items: [
          {
            orderItemReference: id(14),
            refundUnitOrdinals: [1],
            components: {
              netAmountMinor: 5000n,
              taxAmountMinor: 500n,
              tipAmountMinor: 500n,
              serviceChargeAmountMinor: 0n,
              serviceChargeTaxAmountMinor: 0n,
            },
          },
        ],
      },
    ],
  };
}

export const cancellationClaimFixture = () => ({
  kind: "Cancellation",
  cancellationReference: refundRequestId(40),
  cancellationDigest: "sha256:" + "c".repeat(64),
});
/** One batch payment, tip excluded: 5000 net + 500 tax. */
export function cancellationRequestFixture(at = "2026-09-13T10:00:00.000Z") {
  const base = ordinaryRefundRequestFixture(at);
  const payment = base.payments[0];
  const item = payment?.items[0];
  if (!payment || !item) throw new Error("FIXTURE_MISSING");
  return {
    ...base,
    amountMinor: 5500n,
    payments: [
      {
        ...payment,
        items: [{ ...item, components: { ...item.components, tipAmountMinor: 0n } }],
      },
    ],
    claim: cancellationClaimFixture(),
  };
}

export function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("FIXTURE_MISSING");
  return value;
}
