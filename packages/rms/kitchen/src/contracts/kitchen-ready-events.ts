import type { DomainEventEnvelope, JsonObject } from "@bop/eventing";

export interface KitchenItemReadyPayload extends JsonObject {
  readonly kitchenTicketReference: string;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly orderItemReference: string;
  readonly readyResultReference: string;
  readonly readyQuantity: number;
  readonly requiredQuantity: number;
  readonly readyAt: string;
}

export interface KitchenOrderReadyPayload extends JsonObject {
  readonly kitchenTicketReference: string;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly readyItemCount: number;
  readonly itemCount: number;
  readonly readyAt: string;
}

type ReadyEnvelope<
  Payload extends JsonObject,
  EventType extends string,
> = DomainEventEnvelope<Payload> & {
  readonly eventType: EventType;
  readonly schemaVersion: 1;
  readonly producerModule: "@rms/kitchen";
  readonly redactionClassification: "indirect_identifier";
  readonly actor: Readonly<{ readonly type: "System" }>;
  readonly replayMetadata: Readonly<{ readonly replaySafe: true }>;
};

export type KitchenItemReadyEnvelope = ReadyEnvelope<
  KitchenItemReadyPayload,
  "KitchenItemReady"
> & { readonly aggregateType: "KitchenOrderItemReadyResult"; readonly aggregateVersion: 1n };

export type KitchenOrderReadyEnvelope = ReadyEnvelope<
  KitchenOrderReadyPayload,
  "KitchenOrderReady"
> & { readonly aggregateType: "KitchenTicket" };

export type KitchenReadyEnvelope = KitchenItemReadyEnvelope | KitchenOrderReadyEnvelope;

export interface KitchenReadyEventBundle {
  readonly itemEvent: KitchenItemReadyEnvelope;
  readonly orderEvent: KitchenOrderReadyEnvelope | null;
}

export const kitchenItemReadyEventType = "rms.kitchen.kitchen-item-ready.v1" as const;
export const kitchenOrderReadyEventType = "rms.kitchen.kitchen-order-ready.v1" as const;
export const kitchenItemReadyEventConsumer = "fulfillment.kitchen-item-ready:v1" as const;
export const kitchenOrderReadyEventConsumer = "fulfillment.kitchen-order-ready:v1" as const;

export class KitchenReadyEventError extends Error {
  readonly code = "KITCHEN_READY_EVENT_INVALID" as const;

  constructor() {
    super("kitchen ready event is invalid");
    this.name = "KitchenReadyEventError";
  }
}
