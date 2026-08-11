import type { DomainEventEnvelope, JsonObject } from "@bop/eventing";

export interface KitchenWorkAcceptedPayload extends JsonObject {
  readonly kitchenTicketReference: string;
  readonly kitchenWorkItemReference: string;
  readonly orderItemReference: string;
  readonly ticketVersion: string;
  readonly workItemVersion: string;
  readonly workItemStatus: "Queued";
  readonly acceptedAt: string;
}

export interface KitchenWorkStartedPayload extends JsonObject {
  readonly kitchenTicketReference: string;
  readonly kitchenWorkItemReference: string;
  readonly orderItemReference: string;
  readonly ticketVersion: string;
  readonly workItemVersion: string;
  readonly fromStatus: "Queued";
  readonly toStatus: "In Progress";
  readonly startedAt: string;
}

export interface KitchenItemProgressRecordedPayload extends JsonObject {
  readonly kitchenTicketReference: string;
  readonly kitchenWorkItemReference: string;
  readonly orderItemReference: string;
  readonly ticketVersion: string;
  readonly workItemVersion: string;
  readonly quantityDelta: number;
  readonly completedQuantity: number;
  readonly requiredQuantity: number;
  readonly fromStatus: "In Progress";
  readonly toStatus: "In Progress";
  readonly recordedAt: string;
}

export interface KitchenItemCompletedPayload extends JsonObject {
  readonly kitchenTicketReference: string;
  readonly kitchenWorkItemReference: string;
  readonly orderItemReference: string;
  readonly ticketVersion: string;
  readonly workItemVersion: string;
  readonly quantityDelta: number;
  readonly completedQuantity: number;
  readonly requiredQuantity: number;
  readonly fromStatus: "In Progress";
  readonly toStatus: "Completed";
  readonly completedAt: string;
}

type LifecycleEnvelope<
  Payload extends JsonObject,
  EventType extends string,
> = DomainEventEnvelope<Payload> & {
  readonly eventType: EventType;
  readonly schemaVersion: 1;
  readonly producerModule: "@rms/kitchen";
  readonly aggregateType: "KitchenTicket";
  readonly redactionClassification: "personal";
  readonly actor: Readonly<{ readonly type: "Actor"; readonly actorId: string }>;
  readonly replayMetadata: Readonly<{ readonly replaySafe: true }>;
};

export type KitchenWorkAcceptedEnvelope = LifecycleEnvelope<
  KitchenWorkAcceptedPayload,
  "KitchenWorkAccepted"
>;
export type KitchenWorkStartedEnvelope = LifecycleEnvelope<
  KitchenWorkStartedPayload,
  "KitchenWorkStarted"
>;
export type KitchenItemProgressRecordedEnvelope = LifecycleEnvelope<
  KitchenItemProgressRecordedPayload,
  "KitchenItemProgressRecorded"
>;
export type KitchenItemCompletedEnvelope = LifecycleEnvelope<
  KitchenItemCompletedPayload,
  "KitchenItemCompleted"
>;

export type KitchenWorkLifecycleEnvelope =
  | KitchenWorkAcceptedEnvelope
  | KitchenWorkStartedEnvelope
  | KitchenItemProgressRecordedEnvelope
  | KitchenItemCompletedEnvelope;

export const kitchenWorkAcceptedEventType = "rms.kitchen.kitchen-work-accepted.v1" as const;
export const kitchenWorkStartedEventType = "rms.kitchen.kitchen-work-started.v1" as const;
export const kitchenItemProgressRecordedEventType =
  "rms.kitchen.kitchen-item-progress-recorded.v1" as const;
export const kitchenItemCompletedEventType = "rms.kitchen.kitchen-item-completed.v1" as const;

export const kitchenWorkAcceptedEventConsumer =
  "kitchen.queue-work-accepted-projection:v1" as const;
export const kitchenWorkStartedEventConsumer = "kitchen.queue-work-started-projection:v1" as const;
export const kitchenItemProgressRecordedEventConsumer =
  "kitchen.queue-item-progress-projection:v1" as const;
export const kitchenItemCompletedEventConsumer =
  "kitchen.queue-item-completed-projection:v1" as const;

export class KitchenWorkLifecycleEventError extends Error {
  readonly code = "KITCHEN_WORK_LIFECYCLE_EVENT_INVALID" as const;

  constructor() {
    super("kitchen work lifecycle event is invalid");
    this.name = "KitchenWorkLifecycleEventError";
  }
}
