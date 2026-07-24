import type {
  ClaimedConsumerRetry,
  ConsumerOutcome,
  DomainEventEnvelope,
  RetryTelemetryEvent,
} from "@bop/eventing";
import type { AuthorizedDispatchScope } from "./outbox-dispatcher.js";
import type { ConsumerDeliveryWorker } from "./consumer-delivery.js";

export interface ConsumerRetryPort {
  claim(
    scope: AuthorizedDispatchScope,
    input: {
      readonly batchSize: number;
      readonly leaseDurationSeconds: number;
      readonly leaseOwner: string;
      readonly leaseToken: string;
      readonly now: string;
    },
  ): Promise<readonly ClaimedConsumerRetry[]>;
  complete(
    scope: AuthorizedDispatchScope,
    input: {
      readonly scheduleId: string;
      readonly leaseToken: string;
      readonly expectedVersion: bigint;
      readonly outcome: "completed" | "dead_lettered";
    },
  ): Promise<"completed" | "conflict">;
  loadEnvelope(
    scope: AuthorizedDispatchScope,
    eventId: string,
  ): Promise<DomainEventEnvelope | null>;
}

export interface RetrySchedulerTelemetry {
  record(event: RetryTelemetryEvent): void;
}

const noopTelemetry: RetrySchedulerTelemetry = { record: () => undefined };

export class ConsumerRetryScheduler {
  #cursor = 0;

  constructor(
    private readonly dependencies: {
      readonly delivery: ConsumerDeliveryWorker;
      readonly leaseOwner: string;
      readonly newLeaseToken: () => string;
      readonly now: () => string;
      readonly retries: ConsumerRetryPort;
      readonly scopes: readonly AuthorizedDispatchScope[];
      readonly telemetry?: RetrySchedulerTelemetry;
    },
  ) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(dependencies.leaseOwner))
      throw new TypeError("leaseOwner must be an opaque safe identifier");
    if (dependencies.scopes.length === 0) throw new TypeError("at least one scope is required");
  }

  async runOnce(): Promise<number> {
    let remaining = 100;
    let handled = 0;
    for (let offset = 0; offset < this.dependencies.scopes.length && remaining > 0; offset += 1) {
      const scope =
        this.dependencies.scopes[(this.#cursor + offset) % this.dependencies.scopes.length];
      if (!scope) continue;
      const now = this.dependencies.now();
      const claimed = await this.dependencies.retries.claim(scope, {
        batchSize: Math.min(25, remaining),
        leaseDurationSeconds: 300,
        leaseOwner: this.dependencies.leaseOwner,
        leaseToken: this.dependencies.newLeaseToken(),
        now,
      });
      remaining -= claimed.length;
      for (const retry of claimed) await this.#deliver(scope, retry, now);
      handled += claimed.length;
    }
    this.#cursor = (this.#cursor + 1) % this.dependencies.scopes.length;
    return handled;
  }

  async #deliver(
    scope: AuthorizedDispatchScope,
    retry: ClaimedConsumerRetry,
    now: string,
  ): Promise<void> {
    const firstAttemptAt = new Date(Date.parse(retry.deadlineAt) - 86_400_000).toISOString();
    const expired = Date.parse(now) >= Date.parse(retry.deadlineAt);
    const envelope = expired
      ? null
      : await this.dependencies.retries.loadEnvelope(scope, retry.eventId);
    let outcome: ConsumerOutcome;
    if (expired || !envelope) {
      outcome = {
        status: expired ? "retry_required" : "rejected",
        errorCode: expired ? "CONSUMER_TEMPORARY_FAILURE" : "EVENT_TYPE_UNSUPPORTED",
      };
      await this.dependencies.delivery.recordDeferredFailure({
        attemptNumber: retry.attemptCount,
        consumerName: retry.consumerName,
        errorCode: outcome.errorCode,
        eventId: retry.eventId,
        firstAttemptAt,
        scope,
      });
    } else {
      outcome = await this.dependencies.delivery.deliver(
        retry.consumerName,
        envelope,
        Math.min(8, retry.attemptCount + 1),
        firstAttemptAt,
      );
    }
    const completed = outcome.status === "processed" || outcome.status === "duplicate_completed";
    const result = completed
      ? await this.dependencies.retries.complete(scope, {
          scheduleId: retry.scheduleId,
          leaseToken: retry.leaseToken,
          expectedVersion: retry.version,
          outcome: "completed",
        })
      : "completed";
    const failureClass = completed
      ? "retryable"
      : "errorCode" in outcome && outcome.errorCode === "COMMIT_OUTCOME_UNKNOWN"
        ? "commit_unknown"
        : "errorCode" in outcome && outcome.errorCode === "AGGREGATE_ORDER_GAP"
          ? "ordering_gap"
          : "errorCode" in outcome && outcome.errorCode === "CONSUMER_TEMPORARY_FAILURE"
            ? "retryable"
            : "non_retryable";
    const terminal =
      expired ||
      failureClass === "non_retryable" ||
      (failureClass !== "commit_unknown" && retry.attemptCount >= 7);
    this.telemetry.record({
      path: "consumer",
      failureClass,
      safeCode: "errorCode" in outcome ? outcome.errorCode : "RETRY_COMPLETED",
      attemptBucket:
        retry.attemptCount === 1
          ? "1"
          : retry.attemptCount <= 3
            ? "2-3"
            : retry.attemptCount <= 7
              ? "4-7"
              : "8",
      delayBucket: "none",
      outcome:
        result === "conflict"
          ? "conflict"
          : completed
            ? "completed"
            : terminal
              ? "dead_lettered"
              : "errorCode" in outcome && outcome.errorCode === "COMMIT_OUTCOME_UNKNOWN"
                ? "reconciliation_required"
                : "retry_scheduled",
    });
  }

  private get telemetry(): RetrySchedulerTelemetry {
    return this.dependencies.telemetry ?? noopTelemetry;
  }
}
