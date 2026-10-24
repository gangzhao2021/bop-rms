import {
  paymentWebhookRawEvidenceRetention,
  purgeExpiredPaymentWebhookRawEvidence,
} from "../../packages/rms/payment/src/index.ts";
import {
  createOutboxWorkload,
  supervisedCycleFailures,
} from "../../apps/worker/dist/outbox-workload.js";
import { isPilotRuntime } from "./pilot-environment.mjs";

/** DEC-STRIPE-PILOT-WIRING: raw Stripe webhook bytes are Restricted evidence kept 30 days. */
export const webhookEvidenceRetentionBatchSize = 100;
export const webhookEvidenceRetentionIntervalMs = 24 * 60 * 60 * 1000;

/**
 * Once a day, delete this Store's raw webhook evidence whose 30-day retention has ended (Payment's
 * owner operation). The receipt row (event identity, evidence digest, times) and its processing
 * record stay; the database refuses any earlier deletion. A full batch means more are due, so the
 * next poll continues; a partial batch ends the day's sweep. Idempotent; a failed batch rolls back.
 * Runs in both environments: with the simulator there is simply nothing to delete.
 */
export function createWebhookEvidenceRetentionDispatcher({
  resources,
  batchSize = webhookEvidenceRetentionBatchSize,
  intervalMs = webhookEvidenceRetentionIntervalMs,
  purge = purgeExpiredPaymentWebhookRawEvidence,
  allowed = () => isPilotRuntime() && resources.now() < resources.publicProfile.binding.validUntil,
}) {
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > paymentWebhookRawEvidenceRetention.maximumBatch
  )
    throw Error("WEBHOOK_EVIDENCE_RETENTION_CONFIG_INVALID");
  let nextDueAt = 0;
  return Object.freeze({
    async runOnce() {
      const now = resources.now();
      if (Date.parse(now) < nextDueAt) return 0;
      if (!allowed()) throw Error("WEBHOOK_EVIDENCE_RETENTION_UNAVAILABLE");
      const result = await resources.transactions.run((tx) =>
        purge(
          tx,
          {
            brandReference: resources.scope.brandReference,
            storeReference: resources.scope.storeReference,
          },
          { observedAt: now, limit: batchSize },
        ),
      );
      if (
        !result ||
        !Number.isSafeInteger(result.purged) ||
        result.purged < 0 ||
        result.purged > batchSize
      )
        throw Error("WEBHOOK_EVIDENCE_RETENTION_RESULT_INVALID");
      if (result.purged < batchSize) nextDueAt = Date.parse(now) + intervalMs;
      return result.purged;
    },
    stop: async () => "drained",
  });
}

export function createInternalWebhookEvidenceRetentionWorkload(resources, onSnapshot) {
  return createOutboxWorkload({
    dispatcher: createWebhookEvidenceRetentionDispatcher({ resources }),
    pollIntervalMs: 60_000,
    drainDeadlineMs: 25_000,
    supervision: supervisedCycleFailures,
    ...(onSnapshot ? { onSnapshot } : {}),
  });
}
