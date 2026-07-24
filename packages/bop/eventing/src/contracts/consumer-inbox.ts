import type { DomainEventEnvelope } from "./domain-event-envelope.js";

export const consumerErrorCodes = [
  "CONSUMER_UNKNOWN",
  "EVENT_TYPE_UNSUPPORTED",
  "EVENT_SCHEMA_VERSION_UNSUPPORTED",
  "TENANT_SCOPE_DENIED",
  "AGGREGATE_ORDER_GAP",
  "CONSUMER_REJECTED",
  "CONSUMER_TEMPORARY_FAILURE",
  "COMMIT_OUTCOME_UNKNOWN",
] as const;
export type ConsumerErrorCode = (typeof consumerErrorCodes)[number];
export type ConsumerOutcome =
  | { readonly status: "processed" | "duplicate_completed" }
  | { readonly status: "rejected" | "retry_required"; readonly errorCode: ConsumerErrorCode };
export class ConsumerTransactionRollback extends Error {
  constructor(
    readonly outcome: Extract<ConsumerOutcome, { status: "rejected" | "retry_required" }>,
  ) {
    super(outcome.errorCode);
    this.name = "ConsumerTransactionRollback";
  }
}
export interface ConsumerTransaction {
  query<Row = Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
  ): Promise<{ readonly rowCount: number | null; readonly rows: readonly Row[] }>;
}
export interface ConsumerRegistration {
  readonly consumerName: string;
  readonly consumerVersion: number;
  readonly eventType: string;
  readonly schemaVersions: readonly number[];
  readonly ownerModule: `@bop/${string}` | `@rms/${string}`;
  readonly tenantScope: "brand" | "store";
  readonly ordering: "aggregate" | "none";
  readonly sideEffect: string;
  readonly replaySafe: boolean;
  readonly handler: (input: {
    readonly envelope: DomainEventEnvelope;
    readonly transaction: ConsumerTransaction;
  }) => Promise<
    | undefined
    | { readonly status: "completed"; readonly resultHash?: string }
    | { readonly status: "rejected" | "retry_required"; readonly errorCode: ConsumerErrorCode }
  >;
}
