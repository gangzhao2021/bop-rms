import type { DomainEventEnvelope, JsonObject } from "@bop/eventing";
import type {
  KitchenStaleTicketCloseReason,
  KitchenStaleTicketOpenStatus,
} from "../domain/kitchen-stale-ticket.js";

export * from "../domain/kitchen-stale-ticket.js";

export interface KitchenTicketClosedWorkItem extends JsonObject {
  readonly kitchenWorkItemReference: string;
  readonly orderItemReference: string;
  readonly status: KitchenStaleTicketOpenStatus;
  readonly requiredQuantity: number;
  readonly completedQuantity: number;
}

/** No staff, customer or health fact: references, reason, business day and the open work only. */
export interface KitchenTicketClosedPayload extends JsonObject {
  readonly kitchenTicketReference: string;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly reasonCode: KitchenStaleTicketCloseReason;
  readonly foodMade: boolean;
  readonly orderBusinessDate: string;
  readonly ticketVersion: string;
  readonly openWorkItems: readonly KitchenTicketClosedWorkItem[];
  readonly closedAt: string;
}

export type KitchenTicketClosedEnvelope = DomainEventEnvelope<KitchenTicketClosedPayload> & {
  readonly eventType: "KitchenTicketClosed";
  readonly schemaVersion: 1;
  readonly producerModule: "@rms/kitchen";
  readonly aggregateType: "KitchenTicket";
  readonly redactionClassification: "personal";
  readonly actor: Readonly<{ readonly type: "Actor"; readonly actorId: string }>;
  readonly replayMetadata: Readonly<{ readonly replaySafe: true }>;
};
