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
      readonly nowMs?: () => number;
      readonly registry: ConsumerRegistry;
      readonly telemetry?: ConsumerDeliveryTelemetry;
    },
  ) {}
  async deliver(consumerName: string, envelope: DomainEventEnvelope): Promise<ConsumerOutcome> {
    const startedAt = this.nowMs();
    const resolved = this.dependencies.registry.resolve(consumerName, envelope);
    if ("errorCode" in resolved) {
      const outcome = { status: "rejected" as const, errorCode: resolved.errorCode };
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
      const outcome =
        error instanceof ConsumerTransactionRollback
          ? error.outcome
          : {
              status: "retry_required" as const,
              errorCode:
                error instanceof ConsumerDeliveryPersistenceError
                  ? error.errorCode
                  : ("CONSUMER_TEMPORARY_FAILURE" as const),
            };
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
