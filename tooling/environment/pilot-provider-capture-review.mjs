import process from "node:process";
import { createHash } from "node:crypto";
import {
  createPostgresProviderCaptureExceptionStore,
  parsePaymentReference,
  parsePaymentInstant,
  parseProviderCaptureReconciliationEvidence,
} from "../../packages/rms/payment/src/index.ts";
const json = (value) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const hash = (value) => createHash("sha256").update(json(value)).digest("hex");
const identity = (kind, entry, account) => {
  const h = hash([
      kind,
      entry.brandReference,
      entry.storeReference,
      account,
      entry.environment,
      entry.providerTransactionReference,
    ]),
    stamp = Date.parse(entry.occurredAt).toString(16).padStart(12, "0");
  return String(
    parsePaymentReference(
      stamp.slice(0, 8) +
        "-" +
        stamp.slice(8) +
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
/** Discovery is Provider-first; only owner-approved unmatched evidence is appended. */
export function createInternalProviderCaptureReview({
  resources: r,
  simulator,
  providerAccountReference,
}) {
  const fail = () => {
    throw Error("INTERNAL_PROVIDER_CAPTURE_REVIEW_UNAVAILABLE");
  };
  const account = String(parsePaymentReference(providerAccountReference)),
    scope = {
      tenantReference: String(parsePaymentReference(r.publicProfile.binding.tenantReference)),
      brandReference: String(parsePaymentReference(r.scope.brandReference)),
      storeReference: String(parsePaymentReference(r.scope.storeReference)),
    };
  const active = () =>
    process.env.NODE_ENV === "development" &&
    simulator.simulation === true &&
    r.publicProfile.binding.brandReference === scope.brandReference &&
    r.publicProfile.binding.storeReference === scope.storeReference &&
    parsePaymentInstant(r.now()) < parsePaymentInstant(r.publicProfile.binding.validUntil);
  if (!active() || typeof simulator.readCaptureJournal !== "function") return fail();
  let cursor = null,
    cutoff = null,
    running = false;
  const read = (after, observedAt) =>
    simulator.readCaptureJournal({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      environment: "Test",
      observedAt,
      afterProviderIntentReference: after,
      limit: 5,
    });
  const evidence = (entry, observedAt) =>
    parseProviderCaptureReconciliationEvidence({
      brandReference: entry.brandReference,
      storeReference: entry.storeReference,
      providerAccountReference: account,
      environment: entry.environment,
      providerIntentReference: entry.providerIntentReference,
      providerTransactionReference: entry.providerTransactionReference,
      paymentOperationReference: entry.paymentOperationReference,
      paymentAttemptReference: entry.paymentAttemptReference,
      amount: entry.amount,
      occurredAt: entry.occurredAt,
      observedAt,
      evidenceDigest: "sha256:" + hash(entry),
    });
  return async () => {
    if (running || !active()) return fail();
    running = true;
    try {
      cutoff ??= parsePaymentInstant(r.now());
      const page = await read(cursor, cutoff);
      if (!Array.isArray(page.records) || page.records.length > 5 || page.observedAt !== cutoff)
        return fail();
      let previous = cursor;
      for (const entry of page.records) {
        if (
          entry.brandReference !== scope.brandReference ||
          entry.storeReference !== scope.storeReference ||
          entry.environment !== "Test" ||
          (previous !== null && entry.providerIntentReference <= previous)
        )
          return fail();
        previous = entry.providerIntentReference;
      }
      if (
        page.nextAfterProviderIntentReference !== null &&
        (page.records.length !== 5 || page.nextAfterProviderIntentReference !== previous)
      )
        return fail();
      const counts = { created: 0, alreadyRecorded: 0, operationPresent: 0 };
      for (const entry of page.records) {
        const value = evidence(entry, cutoff),
          candidateReference = identity("ProviderCaptureCandidate", entry, account),
          exceptionReference = identity("ProviderCaptureException", entry, account);
        const owner = createPostgresProviderCaptureExceptionStore({
          scope,
          providerAccountReference: account,
          environment: "Test",
          authorize: async () => active(),
          verifyEvidence: async (_tx, current) => {
            if (!active()) return false;
            const fresh = await read(cursor, cutoff);
            const matches = fresh.records.filter(
              (v) => v.providerTransactionReference === entry.providerTransactionReference,
            );
            return (
              matches.length === 1 &&
              json(evidence(matches[0], cutoff)) === json(current) &&
              active()
            );
          },
          audit: async () => ({
            auditId: r.credentials.reference(),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "System" },
            actionCode: "PAYMENT_PROVIDER_CAPTURE_UNMATCHED",
            targetType: "PaymentReconciliationException",
            targetId: exceptionReference,
            correlationId: candidateReference,
            occurredAt: value.observedAt,
            reasonCode: "PROVIDER_CAPTURE_WITHOUT_INTERNAL_OPERATION",
            sourceChannel: "INTERNAL_TEST",
            dataClassification: "Restricted",
            retentionPolicyCode: "PAYMENT_AUDIT",
            retentionPolicyVersion: 1,
          }),
        });
        const result = await r.transactions.run((tx) =>
          owner.record(tx, { candidateReference, exceptionReference, evidence: value }),
        );
        if (result.status === "Created") counts.created++;
        else if (result.status === "AlreadyRecorded") counts.alreadyRecorded++;
        else if (result.status === "OperationPresent") counts.operationPresent++;
        else return fail();
      }
      if (!active()) return fail();
      cursor = page.nextAfterProviderIntentReference;
      const scanComplete = cursor === null;
      if (scanComplete) cutoff = null;
      return { scannedCount: page.records.length, ...counts, scanComplete };
    } finally {
      running = false;
    }
  };
}
