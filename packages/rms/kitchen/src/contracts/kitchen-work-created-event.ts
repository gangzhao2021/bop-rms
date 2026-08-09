import type { DomainEventEnvelope, JsonObject } from "@bop/eventing";

export interface KitchenWorkCreatedPayload extends JsonObject {
  readonly kitchenTicketReference: string;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly confirmationReference: string;
  readonly workItemCount: number;
  readonly aggregateVersion: number;
  readonly createdAt: string;
}

export type KitchenWorkCreatedEnvelope = DomainEventEnvelope<KitchenWorkCreatedPayload> & {
  readonly eventType: "KitchenWorkCreated";
};

export const kitchenWorkCreatedEventType = "rms.kitchen.kitchen-work-created.v1" as const;
export const kitchenWorkCreatedEventConsumer = "kitchen.queue-projection:v1" as const;

export class KitchenWorkCreatedEventError extends Error {
  readonly code = "KITCHEN_WORK_CREATED_EVENT_INVALID" as const;

  constructor() {
    super("kitchen work created event is invalid");
    this.name = "KitchenWorkCreatedEventError";
  }
}
