import { redactExpiredCheckoutContacts } from "../../packages/rms/ordering/src/index.ts";
import {
  createOutboxWorkload,
  supervisedCycleFailures,
} from "../../apps/worker/dist/outbox-workload.js";
import { isPilotRuntime } from "./pilot-environment.mjs";

/** WP-2423 Q10/Q16 (Owner-approved 30 days): daily removal, at most this many records per batch. */
export const contactRetentionBatchSize = 100;
export const contactRetentionIntervalMs = 24 * 60 * 60 * 1000;

/**
 * Once a day, remove pickup contacts and receipt emails older than the retention period from this
 * Store's checkout details (Ordering's owner operation; evidence first, nothing else changes). A
 * full batch means more are due, so the next poll continues; a partial batch ends the day's sweep.
 * Idempotent: removed records are never selected again, and a failed batch rolls back whole.
 */
export function createContactRetentionDispatcher({
  resources,
  batchSize = contactRetentionBatchSize,
  intervalMs = contactRetentionIntervalMs,
  redact = redactExpiredCheckoutContacts,
  allowed = () => isPilotRuntime() && resources.now() < resources.publicProfile.binding.validUntil,
}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500)
    throw Error("CONTACT_RETENTION_CONFIG_INVALID");
  let nextDueAt = 0;
  return Object.freeze({
    async runOnce() {
      const now = resources.now();
      if (Date.parse(now) < nextDueAt) return 0;
      if (!allowed()) throw Error("INTERNAL_CONTACT_RETENTION_UNAVAILABLE");
      const result = await resources.transactions.run((tx) =>
        redact(tx, resources.scope, {
          observedAt: now,
          limit: batchSize,
          generateRedactionReference: resources.credentials.reference,
        }),
      );
      if (
        !result ||
        !Number.isSafeInteger(result.redacted) ||
        result.redacted < 0 ||
        result.redacted > batchSize
      )
        throw Error("CONTACT_RETENTION_RESULT_INVALID");
      if (result.redacted < batchSize) nextDueAt = Date.parse(now) + intervalMs;
      return result.redacted;
    },
    stop: async () => "drained",
  });
}

export function createInternalContactRetentionWorkload(resources, onSnapshot) {
  return createOutboxWorkload({
    dispatcher: createContactRetentionDispatcher({ resources }),
    pollIntervalMs: 60_000,
    drainDeadlineMs: 25_000,
    supervision: supervisedCycleFailures,
    ...(onSnapshot ? { onSnapshot } : {}),
  });
}
