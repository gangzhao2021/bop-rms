import {
  consumeEventInTransaction,
  type ConsumerOutcome,
  type ConsumerRegistry,
  type ConsumerTransaction,
  ConsumerTransactionRollback,
  type DomainEventEnvelope,
} from "@bop/eventing";

export interface ConsumerDeliveryPort {
  transaction<T>(
    scope: { readonly brandId: string; readonly storeId?: string },
    work: (transaction: ConsumerTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface ConsumerFailureRecorder {
  recordFailure(input: {
    readonly attemptNumber: number;
    readonly consumerName: string;
    readonly errorCode: Extract<ConsumerOutcome, { readonly errorCode: string }>["errorCode"];
    readonly eventId: string;
    readonly firstAttemptAt: string;
    readonly scope: { readonly brandId: string; readonly storeId?: string };
  }): Promise<void>;
}

export class ConsumerDeliveryPersistenceError extends Error {
  constructor(
    readonly errorCode: "COMMIT_OUTCOME_UNKNOWN" | "CONSUMER_TEMPORARY_FAILURE",
    options?: { readonly cause?: unknown },
  ) {
    super(errorCode, options);
    this.name = "ConsumerDeliveryPersistenceError";
  }
}

export interface ConsumerDeliveryTelemetry {
  record(event: {
    readonly consumerAlias: string;
    readonly durationMs: number;
    readonly errorCode?: Extract<ConsumerOutcome, { readonly errorCode: string }>["errorCode"];
    readonly eventAlias: string;
    readonly result: ConsumerOutcome["status"];
  }): void;
}

const noopTelemetry: ConsumerDeliveryTelemetry = { record: () => undefined };

export class ConsumerDeliveryWorker {
  constructor(
    private readonly dependencies: {
      readonly database: ConsumerDeliveryPort;
      readonly failureRecorder?: ConsumerFailureRecorder;
      readonly nowMs?: () => number;
      readonly registry: ConsumerRegistry;
      readonly telemetry?: ConsumerDeliveryTelemetry;
    },
  ) {}

  async recordDeferredFailure(input: {
    readonly attemptNumber: number;
    readonly consumerName: string;
    readonly errorCode: Extract<ConsumerOutcome, { readonly errorCode: string }>["errorCode"];
    readonly eventId: string;
    readonly firstAttemptAt: string;
    readonly scope: { readonly brandId: string; readonly storeId?: string };
  }): Promise<void> {
    if (!this.dependencies.failureRecorder)
      throw new Error("CONSUMER_FAILURE_RECORDER_REQUIRED_FOR_DEFERRED_FAILURE");
    await this.dependencies.failureRecorder.recordFailure(input);
  }

  async deliver(
    consumerName: string,
    envelope: DomainEventEnvelope,
    attemptNumber = 1,
    firstAttemptAt?: string,
  ): Promise<ConsumerOutcome> {
    if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > 8)
      throw new TypeError("attemptNumber must be an integer between 1 and 8");
    const startedAt = this.nowMs();
    const resolvedFirstAttemptAt = firstAttemptAt ?? new Date(startedAt).toISOString();
    if (!Number.isFinite(Date.parse(resolvedFirstAttemptAt)))
      throw new TypeError("firstAttemptAt must be an ISO instant");
    const resolved = this.dependencies.registry.resolve(consumerName, envelope);
    if ("errorCode" in resolved) {
      const outcome = { status: "rejected" as const, errorCode: resolved.errorCode };
      if (this.dependencies.failureRecorder)
        await this.recordDeferredFailure({
          attemptNumber: 0,
          consumerName: /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*:v[1-9][0-9]*$/u.test(consumerName)
            ? consumerName
            : "unregistered:v1",
          errorCode: outcome.errorCode,
          eventId: envelope.eventId,
          firstAttemptAt: resolvedFirstAttemptAt,
          scope: {
            brandId: envelope.tenantId,
            ...(envelope.storeId ? { storeId: envelope.storeId } : {}),
          },
        });
      this.record("unknown", "unsupported", outcome, startedAt);
      return outcome;
    }
    const consumerAlias = resolved.registration.consumerName;
    const eventAlias = `${resolved.registration.eventType}:v${envelope.schemaVersion}`;
    try {
      const outcome = await this.dependencies.database.transaction(
        { brandId: envelope.tenantId, ...(envelope.storeId ? { storeId: envelope.storeId } : {}) },
        async (transaction) =>
          await consumeEventInTransaction(transaction, resolved.registration, envelope),
      );
      this.record(consumerAlias, eventAlias, outcome, startedAt);
      return outcome;
    } catch (error) {
      let outcome: ConsumerOutcome =
        error instanceof ConsumerTransactionRollback
          ? error.outcome
          : {
              status: "retry_required" as const,
              errorCode:
                error instanceof ConsumerDeliveryPersistenceError
                  ? error.errorCode
                  : ("CONSUMER_TEMPORARY_FAILURE" as const),
            };
      if (outcome.errorCode === "COMMIT_OUTCOME_UNKNOWN") {
        try {
          outcome = await this.dependencies.database.transaction(
            {
              brandId: envelope.tenantId,
              ...(envelope.storeId ? { storeId: envelope.storeId } : {}),
            },
            async (transaction) =>
              await consumeEventInTransaction(transaction, resolved.registration, envelope),
          );
        } catch {
          outcome = {
            status: "retry_required",
            errorCode: "COMMIT_OUTCOME_UNKNOWN",
          };
        }
      }
      if ("errorCode" in outcome && this.dependencies.failureRecorder)
        await this.recordDeferredFailure({
          attemptNumber,
          consumerName: resolved.registration.consumerName,
          errorCode: outcome.errorCode,
          eventId: envelope.eventId,
          firstAttemptAt: resolvedFirstAttemptAt,
          scope: {
            brandId: envelope.tenantId,
            ...(envelope.storeId ? { storeId: envelope.storeId } : {}),
          },
        });
      this.record(consumerAlias, eventAlias, outcome, startedAt);
      return outcome;
    }
  }

  private get nowMs(): () => number {
    return this.dependencies.nowMs ?? Date.now;
  }

  private get telemetry(): ConsumerDeliveryTelemetry {
    return this.dependencies.telemetry ?? noopTelemetry;
  }

  private record(
    consumerAlias: string,
    eventAlias: string,
    outcome: ConsumerOutcome,
    startedAt: number,
  ): void {
    this.telemetry.record({
      consumerAlias,
      durationMs: Math.max(0, this.nowMs() - startedAt),
      eventAlias,
      result: outcome.status,
      ...("errorCode" in outcome ? { errorCode: outcome.errorCode } : {}),
    });
  }
}
