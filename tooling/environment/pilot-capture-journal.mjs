import process from "node:process";
import {
  parsePaymentInstant,
  parsePaymentReference,
  parseProviderReference,
} from "../../packages/rms/payment/src/index.ts";
/** Provider-first discovery for the local simulator; no internal Payment fact is inferred. */
export function createInternalCaptureJournalSource(db, { authorize }) {
  const fail = () => {
    throw Error("SIMULATION_CAPTURE_JOURNAL_UNAVAILABLE");
  };
  return async (input) => {
    try {
      if (process.env.NODE_ENV !== "development") return fail();
      const scope = {
        brandReference: String(parsePaymentReference(input.brandReference)),
        storeReference: String(parsePaymentReference(input.storeReference)),
        environment: input.environment,
      };
      const observedAt = parsePaymentInstant(input.observedAt),
        after =
          input.afterProviderIntentReference === null
            ? null
            : String(parseProviderReference(input.afterProviderIntentReference));
      if (
        scope.environment !== "Test" ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100 ||
        new Date(observedAt).toISOString() !== observedAt ||
        observedAt > new Date().toISOString() ||
        (await authorize(scope)) !== true
      )
        return fail();
      const rows = db
        .prepare(
          "SELECT i.reference,i.operation,i.attempt,i.amount,i.created_at,o.transaction_reference,o.occurred_at FROM intent i JOIN outcome o ON o.reference=i.reference WHERE i.brand=? AND i.store=? AND o.status='Captured' AND o.occurred_at<=? AND (? IS NULL OR i.reference>?) ORDER BY i.reference LIMIT ?",
        )
        .all(scope.brandReference, scope.storeReference, observedAt, after, after, input.limit + 1);
      const records = rows.slice(0, input.limit).map((row) => {
        const providerIntentReference = String(parseProviderReference(row.reference)),
          providerTransactionReference = String(parseProviderReference(row.transaction_reference)),
          createdAt = parsePaymentInstant(row.created_at),
          occurredAt = parsePaymentInstant(row.occurred_at);
        if (
          !providerIntentReference.startsWith("pi_") ||
          !providerTransactionReference.startsWith("ch_") ||
          typeof row.amount !== "string" ||
          !/^[1-9][0-9]{0,7}$/.test(row.amount) ||
          createdAt > occurredAt ||
          occurredAt > observedAt
        )
          return fail();
        return Object.freeze({
          ...scope,
          providerIntentReference,
          providerTransactionReference,
          paymentOperationReference: String(parsePaymentReference(row.operation)),
          paymentAttemptReference: String(parsePaymentReference(row.attempt)),
          amount: Object.freeze({ amountMinor: BigInt(row.amount), currencyCode: "CAD" }),
          createdAt,
          occurredAt,
        });
      });
      if ((await authorize(scope)) !== true || process.env.NODE_ENV !== "development")
        return fail();
      return Object.freeze({
        records: Object.freeze(records),
        observedAt,
        nextAfterProviderIntentReference:
          rows.length > input.limit ? records.at(-1).providerIntentReference : null,
      });
    } catch {
      return fail();
    }
  };
}
