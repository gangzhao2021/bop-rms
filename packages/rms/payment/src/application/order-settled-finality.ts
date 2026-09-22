import { exactPaymentObject, parsePaymentInstant } from "./payment-intent-creation.js";
import { parsePaymentReference } from "./payment-provider-adapter.js";
import { assessOrderSettlement } from "../domain/order-settlement.js";
export const settledFinalityColumns = {
  finalityReference: "finality_id",
  operationReference: "operation_id",
  tenantReference: "tenant_id",
  brandReference: "brand_id",
  storeReference: "store_id",
  providerAccountReference: "provider_account_id",
  environment: "environment",
  orderReference: "order_id",
  orderVersion: "order_version",
  orderCheckpoint: "order_checkpoint",
  classification: "classification",
  currencyCode: "currency_code",
  pricedOrderTotalMinor: "priced_order_total_minor",
  capturedMinor: "captured_minor",
  capturedOrderAllocationMinor: "captured_order_allocation_minor",
  capturedTipMinor: "captured_tip_minor",
  orderEvidenceDigest: "order_evidence_digest",
  paymentEvidenceDigest: "payment_evidence_digest",
  decidedAt: "decided_at",
} as const;
export function parseOrderSettledFinality(value: unknown) {
  const fail = (): never => {
    throw new Error("ORDER_SETTLED_FINALITY_INVALID");
  };
  try {
    const raw = exactPaymentObject(value, Object.keys(settledFinalityColumns));
    if (
      raw.classification !== "Settled" ||
      raw.currencyCode !== "CAD" ||
      !["Test", "Live"].includes(String(raw.environment)) ||
      !Number.isSafeInteger(raw.orderVersion) ||
      (raw.orderVersion as number) < 1 ||
      (raw.orderVersion as number) > 2147483647
    )
      return fail();
    const amount = (value: unknown) => {
      if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/u.test(value)) return fail();
      return value;
    };
    const pricedOrderTotalMinor = amount(raw.pricedOrderTotalMinor),
      capturedMinor = amount(raw.capturedMinor),
      capturedOrderAllocationMinor = amount(raw.capturedOrderAllocationMinor),
      capturedTipMinor = amount(raw.capturedTipMinor);
    if (
      assessOrderSettlement({
        currencyCode: "CAD",
        pricedOrderTotalMinor: BigInt(pricedOrderTotalMinor),
        capturedMinor: BigInt(capturedMinor),
        capturedOrderAllocationMinor: BigInt(capturedOrderAllocationMinor),
        capturedTipMinor: BigInt(capturedTipMinor),
        confirmedRefundMinor: 0n,
        pendingRefundMinor: 0n,
        unresolvedAttemptCount: 0,
        pendingAmendmentCount: 0,
      }).classification !== "Settled"
    )
      return fail();
    const digest = (value: unknown) => {
      if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) return fail();
      return value;
    };
    return Object.freeze({
      finalityReference: parsePaymentReference(raw.finalityReference),
      operationReference: parsePaymentReference(raw.operationReference),
      tenantReference: parsePaymentReference(raw.tenantReference),
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
      providerAccountReference: parsePaymentReference(raw.providerAccountReference),
      environment: raw.environment as "Test" | "Live",
      orderReference: parsePaymentReference(raw.orderReference),
      orderVersion: raw.orderVersion as number,
      orderCheckpoint: parsePaymentReference(raw.orderCheckpoint),
      classification: "Settled" as const,
      currencyCode: "CAD" as const,
      pricedOrderTotalMinor,
      capturedMinor,
      capturedOrderAllocationMinor,
      capturedTipMinor,
      orderEvidenceDigest: digest(raw.orderEvidenceDigest),
      paymentEvidenceDigest: digest(raw.paymentEvidenceDigest),
      decidedAt: parsePaymentInstant(raw.decidedAt),
    });
  } catch {
    return fail();
  }
}
export type OrderSettledFinality = ReturnType<typeof parseOrderSettledFinality>;
