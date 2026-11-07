import type { ConsumerRetryPort } from "./retry-scheduler.js";
import {
  claimOutboxBatch,
  loadOutboxEnvelope,
  claimConsumerRetryBatch,
  completeConsumerRetry,
  markOutboxPublished,
  markOutboxFailed,
  scheduleParkedOutboxBatch,
  recordConsumerFailureDecision,
  resolveRetry,
  type RecordDeliveryDecisionInput,
} from "@bop/eventing";
import type { ConsumerDeliveryPort, ConsumerFailureRecorder } from "./consumer-delivery.js";
import type { AuthorizedDispatchScope, OutboxDispatchPort } from "./outbox-dispatcher.js";
import type { ParkedOutboxRetryPort } from "./outbox-retry-scheduler.js";

/** Public owner APIs only, with current scope authorization on every transaction. */
export function createPersistentEventingPorts(options: {
  readonly database: ConsumerDeliveryPort;
  authorizeScope(scope: AuthorizedDispatchScope): Promise<boolean>;
  now(): string;
  random(): number;
  outboxIdentities(
    eventId: string,
    attemptNumber: number,
  ): Pick<RecordDeliveryDecisionInput, "attemptId" | "deadLetterId" | "idempotencyKey">;
  consumerIdentities(input: Parameters<ConsumerFailureRecorder["recordFailure"]>[0]): Pick<
    RecordDeliveryDecisionInput,
    "attemptId" | "deadLetterId" | "idempotencyKey"
  > & {
    readonly scheduleId: string;
  };
}) {
  const database: ConsumerDeliveryPort = {
    async transaction(scope, work) {
      if ((await options.authorizeScope(scope)) !== true)
        throw new Error("EVENTING_SCOPE_UNAUTHORIZED");
      return options.database.transaction(scope, work);
    },
  };
  const dispatch: OutboxDispatchPort = {
    claim: (scope, input) => database.transaction(scope, (tx) => claimOutboxBatch(tx, input)),
    complete: (scope, input) => database.transaction(scope, (tx) => markOutboxPublished(tx, input)),
    fail: (scope, input) => database.transaction(scope, (tx) => markOutboxFailed(tx, input)),
  };
  const parkedRetries: ParkedOutboxRetryPort = {
    schedule: (scope, input) =>
      database.transaction(scope, async (tx) => {
        const results = await scheduleParkedOutboxBatch(tx, {
          ...input,
          now: options.now(),
          random: () => options.random(),
          identities: (eventId, attemptNumber) => options.outboxIdentities(eventId, attemptNumber),
        });
        if (results.some((result) => result.status === "conflict"))
          throw new Error("OUTBOX_RETRY_DECISION_CONFLICT");
        return results;
      }),
  };
  const failureRecorder: ConsumerFailureRecorder = {
    recordFailure: (input) =>
      database.transaction(input.scope, async (tx) => {
        const result = await recordConsumerFailureDecision(tx, {
          ...options.consumerIdentities(input),
          ...input.scope,
          eventId: input.eventId,
          consumerName: input.consumerName,
          attemptNumber: input.attemptNumber,
          safeCode: input.errorCode,
          resolution: resolveRetry({
            path: "consumer",
            actualAttemptNumber: input.attemptNumber,
            firstAttemptAt: input.firstAttemptAt,
            now: options.now(),
            random: options.random(),
            safeCode: input.errorCode,
          }),
        });
        if (result.status === "conflict") throw new Error("CONSUMER_RETRY_DECISION_CONFLICT");
      }),
  };
  const consumerRetries: ConsumerRetryPort = {
    claim: (scope, input) =>
      database.transaction(scope, (tx) => claimConsumerRetryBatch(tx, input)),
    loadEnvelope: (scope, eventId) =>
      database.transaction(scope, (tx) => loadOutboxEnvelope(tx, eventId)),
    complete: (scope, input) =>
      database.transaction(scope, (tx) => completeConsumerRetry(tx, input)),
  };
  return Object.freeze({ database, dispatch, parkedRetries, failureRecorder, consumerRetries });
}
