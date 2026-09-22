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
