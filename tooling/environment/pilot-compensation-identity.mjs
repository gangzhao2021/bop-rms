import process from "node:process";
import { createHash } from "node:crypto";
import {
  parsePaidWithoutFulfillableOrderDisposition,
  parsePaymentReference,
  parsePaymentDigest,
  parseProviderIdempotencyKey,
} from "../../packages/rms/payment/src/index.ts";
/** Versioned deterministic names for one InternalTest payment; never allocation or authorization. */
export function createInternalCompensationIdentity(value, now) {
  const deny = () => {
    throw new Error("INTERNAL_COMPENSATION_IDENTITY_UNAVAILABLE");
  };
  if (process.env.NODE_ENV !== "development") return deny();
  const d = parsePaidWithoutFulfillableOrderDisposition(value);
  const base = {
    environment: "Test",
    brandReference: d.brandReference,
    storeReference: d.storeReference,
    orderReference: d.orderReference,
    paymentTransactionReference: d.paymentTransactionReference,
    paymentAttemptReference: d.paymentAttemptReference,
  };
  const hash = (value) => {
    if (typeof value !== "string") return deny();
    return "sha256:" + createHash("sha256").update(value).digest("hex");
  };
  const derive = (kind) => {
    const h = hash(
        JSON.stringify({ algorithm: "BOP_INTERNAL_COMPENSATION_V1", kind, ...base }),
      ).slice(7),
      timestamp = String(d.paymentAttemptReference).replaceAll("-", "").slice(0, 12);
    return String(
      parsePaymentReference(
        timestamp.slice(0, 8) +
          "-" +
          timestamp.slice(8) +
          "-7" +
          h.slice(0, 3) +
          "-" +
          (8 + (parseInt(h[3], 16) & 3)).toString(16) +
          h.slice(4, 7) +
          "-" +
          h.slice(7, 19),
      ),
    );
  };
  const ids = Object.freeze(
    Object.fromEntries(
      ["operation", "case", "action", "refund", "event", "causation"].map((k) => [k, derive(k)]),
    ),
  );
  const exact = (input, expected) => {
    if (
      process.env.NODE_ENV !== "development" ||
      !input ||
      typeof input !== "object" ||
      Object.keys(input).length !== Object.keys(expected).length ||
      Object.keys(expected).some((k) => input[k] !== expected[k])
    )
      return deny();
  };
  const payment = {
    environment: "Test",
    paymentTransactionReference: base.paymentTransactionReference,
    paymentAttemptReference: base.paymentAttemptReference,
  };
  const action = {
    ...payment,
    compensationCaseReference: ids.case,
    purpose: "RefundPaidWithoutFulfillableOrder",
  };
  const references = Object.freeze({
    hash,
    equals: (a, b) => a === b,
    operationFor(input) {
      exact(input, { ...base, purpose: "CompensatePaidWithoutFulfillableOrder" });
      return ids.operation;
    },
    caseFor(input) {
      exact(input, {
        ...payment,
        orderReference: base.orderReference,
        reason: "PaidWithoutFulfillableOrder",
        purpose: "CompensatePaidWithoutFulfillableOrder",
      });
      return ids.case;
    },
    actionFor(input) {
      exact(input, action);
      return ids.action;
    },
    refundFor(input) {
      exact(input, {
        compensationCaseReference: ids.case,
        paymentTransactionReference: base.paymentTransactionReference,
      });
      return ids.refund;
    },
    eventFor(input) {
      exact(input, { refundReference: ids.refund });
      return ids.event;
    },
    causationFor(input) {
      exact(input, {
        compensationCaseReference: ids.case,
        paymentAttemptReference: base.paymentAttemptReference,
        source: "ProviderRetrieval",
      });
      return ids.causation;
    },
    providerIdempotencyKey(input) {
      const { amountMinor, currencyCode, actionDigest, ...binding } = input;
      exact(binding, { ...action, actionReference: ids.action });
      if (
        typeof amountMinor !== "bigint" ||
        amountMinor <= 0n ||
        amountMinor > 9223372036854775807n ||
        currencyCode !== "CAD"
      )
        return deny();
      parsePaymentDigest(actionDigest);
      return String(parseProviderIdempotencyKey("compensation-refund:" + ids.action));
    },
  });
  const audit = (kind, input, expected, actionCode, targetType, targetId) => {
    const { occurredAt, ...binding } = input;
    exact(binding, expected);
    if (
      typeof occurredAt !== "string" ||
      new Date(occurredAt).toISOString() !== occurredAt ||
      occurredAt < d.evaluatedAt ||
      occurredAt > now()
    )
      return deny();
    return {
      auditId: derive("audit:" + kind),
      brandId: base.brandReference,
      storeId: base.storeReference,
      actor: { type: "System" },
      actionCode,
      targetType,
      targetId,
      reasonCode: "PAID_WITHOUT_FULFILLABLE_ORDER",
      correlationId: ids.case,
      occurredAt,
      sourceChannel: "PAYMENT_COMPENSATION",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    };
  };
  const common = {
    caseReference: ids.case,
    brandReference: base.brandReference,
    storeReference: base.storeReference,
  };
  return Object.freeze({
    references,
    identities: ids,
    audit: Object.freeze({
      createCase: async (input) =>
        audit(
          "case",
          input,
          { ...common, paymentTransactionReference: base.paymentTransactionReference },
          "PAYMENT_COMPENSATION_CASE_OPENED",
          "PaymentCompensationCase",
          ids.case,
        ),
      createAction: async (input) =>
        audit(
          "action",
          input,
          {
            ...common,
            actionReference: ids.action,
            paymentTransactionReference: base.paymentTransactionReference,
          },
          "PAYMENT_COMPENSATION_REFUND_CLAIMED",
          "PaymentCompensationAction",
          ids.action,
        ),
      createRefund: async (input) =>
        audit(
          "refund",
          input,
          { ...common, refundReference: ids.refund },
          "PAYMENT_COMPENSATION_REFUND_CONFIRMED",
          "PaymentRefund",
          ids.refund,
        ),
    }),
  });
}
