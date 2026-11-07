import { readClosedRecord } from "@bop/identity";
import { parseOrderingReference, parseOrderingInstant, parseOrderingHash } from "./cart.js";
const fail = (): never => {
  throw new Error("ORDER_BATCH_CHECKOUT_EXPIRY_INVALID");
};
const identityFields = [
  "tenantReference",
  "brandReference",
  "storeReference",
  "orderReference",
  "orderBatchReference",
  "submissionReference",
  "commitmentReference",
  "paymentOperationReference",
] as const;
const fields = [
  ...identityFields,
  "recordReference",
  "previousRecordReference",
  "version",
  "paymentRequestedAt",
  "capacityExpiresAt",
  "observedAt",
  "evidenceDigest",
  "paymentEvidence",
  "status",
] as const;

/** Internal owner evidence, never client authorization or proof of cancellation,
 * refund or stock release. Paid and uncertain batches remain distinct.
 */
export function parseOrderBatchCheckoutExpiry(value: unknown) {
  try {
    const raw = readClosedRecord(value, fields);
    const identity = Object.fromEntries(
      identityFields.map((key) => [key, parseOrderingReference(raw[key])]),
    ) as Record<(typeof identityFields)[number], ReturnType<typeof parseOrderingReference>>;
    const version = raw.version;
    if (version !== 1 && version !== 2) return fail();
    const previousRecordReference =
      raw.previousRecordReference === null
        ? null
        : parseOrderingReference(raw.previousRecordReference);
    const recordReference = parseOrderingReference(raw.recordReference);
    if (
      (version === 1) !== (previousRecordReference === null) ||
      previousRecordReference === recordReference
    )
      return fail();
    const paymentRequestedAt = parseOrderingInstant(raw.paymentRequestedAt);
    const capacityExpiresAt = parseOrderingInstant(raw.capacityExpiresAt);
    const observedAt = parseOrderingInstant(raw.observedAt);
    if (
      Date.parse(capacityExpiresAt) - Date.parse(paymentRequestedAt) !== 1800000 ||
      observedAt < capacityExpiresAt
    )
      return fail();
    const paymentEvidence =
      raw.paymentEvidence === null
        ? null
        : (() => {
            const evidence = readClosedRecord(raw.paymentEvidence, [
              "paymentIntentReference",
              "paymentAttemptReference",
              "paymentEventReference",
              "outcome",
              "occurredAt",
            ]);
            if (evidence.outcome !== "Succeeded" && evidence.outcome !== "Failed") return fail();
            const occurredAt = parseOrderingInstant(evidence.occurredAt);
            if (occurredAt < paymentRequestedAt || occurredAt > observedAt) return fail();
            return Object.freeze({
              paymentIntentReference: parseOrderingReference(evidence.paymentIntentReference),
              paymentAttemptReference: parseOrderingReference(evidence.paymentAttemptReference),
              paymentEventReference: parseOrderingReference(evidence.paymentEventReference),
              outcome: evidence.outcome,
              occurredAt,
            });
          })();
    const status =
      paymentEvidence === null
        ? ("AwaitingPaymentResolution" as const)
        : paymentEvidence.outcome === "Failed"
          ? ("PaymentFailed" as const)
          : paymentEvidence.occurredAt < capacityExpiresAt
            ? ("PaidBeforeDeadline" as const)
            : ("LatePayment" as const);
    if (raw.status !== status || (version === 2 && paymentEvidence === null)) return fail();
    return Object.freeze({
      ...identity,
      recordReference,
      previousRecordReference,
      version,
      paymentRequestedAt,
      capacityExpiresAt,
      observedAt,
      evidenceDigest: parseOrderingHash(raw.evidenceDigest),
      paymentEvidence,
      status,
    });
  } catch {
    return fail();
  }
}
export type OrderBatchCheckoutExpiry = ReturnType<typeof parseOrderBatchCheckoutExpiry>;

/** A complete tiny history, not a lock. Writer must serialize by batch/payment
 * operation and verify the underlying owner facts before appending.
 */
export function resolveOrderBatchCheckoutExpiryHistory(value: unknown) {
  try {
    if (!Array.isArray(value) || value.length > 2) return fail();
    const records = value.map(parseOrderBatchCheckoutExpiry);
    const first = records[0];
    if (first === undefined) return null;
    if (first.version !== 1) return fail();
    const next = records[1];
    if (next) {
      if (
        first.status !== "AwaitingPaymentResolution" ||
        next.version !== 2 ||
        next.previousRecordReference !== first.recordReference ||
        next.observedAt < first.observedAt ||
        identityFields.some((key) => first[key] !== next[key]) ||
        first.paymentRequestedAt !== next.paymentRequestedAt ||
        first.capacityExpiresAt !== next.capacityExpiresAt
      )
        return fail();
    }
    return next ?? first;
  } catch {
    return fail();
  }
}
