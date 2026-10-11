import type { DomainEventEnvelope, JsonObject } from "@bop/eventing";

/** WP-2423 Q6: staff cancel a paid batch before the kitchen starts any of its work. */
export const kitchenBatchCancellationErrorCodes = [
  "KITCHEN_WORK_STARTED",
  "KITCHEN_CANCELLATION_UNAVAILABLE",
] as const;
export type KitchenBatchCancellationErrorCode = (typeof kitchenBatchCancellationErrorCodes)[number];

export class KitchenBatchCancellationError extends Error {
  constructor(readonly code: KitchenBatchCancellationErrorCode) {
    super(
      code === "KITCHEN_WORK_STARTED"
        ? "kitchen work has already started"
        : "kitchen cancellation is unavailable",
    );
    this.name = "KitchenBatchCancellationError";
  }
}

export const kitchenWorkCancellationReasonCode = "ORDER_CANCELLED_BEFORE_PREPARATION" as const;
export const kitchenWorkCancellationActionCode = "KITCHEN_WORK_CANCELLED" as const;
export const kitchenWorkCancellationSourceChannel = "MERCHANT_WEB" as const;
export const kitchenWorkCancelledEventConsumer =
  "kitchen.queue-work-cancelled-projection:v1" as const;
export const kitchenWorkCancelledEventType = "rms.kitchen.kitchen-work-cancelled.v1" as const;

export type KitchenBatchCancellationResult =
  | {
      readonly status: "Cancelled" | "AlreadyCancelled";
      readonly kitchenTicketReference: string;
      readonly workItemCount: number;
      readonly evidenceDigest: string;
    }
  | { readonly status: "NoKitchenWork"; readonly evidenceDigest: string };

/** One append-only row per cancelled work item; all rows of one cancellation share the batch facts. */
export interface KitchenWorkCancellationRecord {
  readonly cancellationReference: string;
  readonly operationReference: string;
  readonly ticketReference: string;
  readonly workItemReference: string;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly orderItemReference: string;
  readonly beforeStatus: "Queued" | "Held";
  readonly expectedTicketVersion: bigint;
  readonly resultTicketVersion: bigint;
  readonly expectedWorkItemVersion: bigint;
  readonly resultWorkItemVersion: bigint;
  readonly actorReference: string;
  readonly orderCancellationReference: string;
  readonly evidenceDigest: string;
  readonly eventReference: string;
  readonly auditReference: string;
  readonly cancelledAt: string;
}

export interface KitchenWorkCancelledItem extends JsonObject {
  readonly kitchenWorkItemReference: string;
  readonly orderItemReference: string;
  readonly fromStatus: "Queued" | "Held";
  readonly toStatus: "Cancelled";
  readonly workItemVersion: string;
}

export interface KitchenWorkCancelledPayload extends JsonObject {
  readonly kitchenTicketReference: string;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly orderCancellationReference: string;
  readonly ticketVersion: string;
  readonly reasonCode: typeof kitchenWorkCancellationReasonCode;
  readonly workItems: readonly KitchenWorkCancelledItem[];
  readonly cancelledAt: string;
}

export type KitchenWorkCancelledEnvelope = DomainEventEnvelope<KitchenWorkCancelledPayload> & {
  readonly eventType: "KitchenWorkCancelled";
  readonly schemaVersion: 1;
  readonly producerModule: "@rms/kitchen";
  readonly aggregateType: "KitchenTicket";
  readonly redactionClassification: "personal";
  readonly actor: Readonly<{ readonly type: "Actor"; readonly actorId: string }>;
  readonly replayMetadata: Readonly<{ readonly replaySafe: true }>;
};
