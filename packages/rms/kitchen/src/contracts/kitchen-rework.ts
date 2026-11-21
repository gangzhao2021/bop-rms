import type { DomainEventEnvelope, JsonObject } from "@bop/eventing";
import type { KitchenReworkCancelReason, KitchenReworkReason } from "../domain/kitchen-rework.js";

export * from "../domain/kitchen-rework.js";

export interface KitchenReworkCreatedPayload extends JsonObject {
  readonly kitchenReworkItemReference: string;
  readonly kitchenTicketReference: string;
  readonly originalKitchenWorkItemReference: string;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly orderItemReference: string;
  readonly reasonCode: KitchenReworkReason;
  readonly quantity: number;
  readonly wasteApplies: boolean;
  readonly createdAt: string;
}

export type KitchenReworkCreatedEnvelope = DomainEventEnvelope<KitchenReworkCreatedPayload> & {
  readonly eventType: "KitchenReworkCreated";
  readonly schemaVersion: 1;
  readonly producerModule: "@rms/kitchen";
  readonly aggregateType: "KitchenReworkItem";
  readonly redactionClassification: "personal";
  readonly actor: Readonly<{ readonly type: "Actor"; readonly actorId: string }>;
  readonly replayMetadata: Readonly<{ readonly replaySafe: true }>;
};

/**
 * DEC-KITCHEN-REWORK cancel (2026-10-18): an open remake is not made after all. Carries the
 * creation event so Inventory finds the remake's waste record; no staff note, customer or health
 * fact.
 */
export interface KitchenReworkCancelledPayload extends JsonObject {
  readonly kitchenReworkItemReference: string;
  readonly kitchenTicketReference: string;
  readonly originalKitchenWorkItemReference: string;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly orderItemReference: string;
  readonly reasonCode: KitchenReworkReason;
  readonly cancelReasonCode: KitchenReworkCancelReason;
  readonly quantity: number;
  readonly wasteApplies: boolean;
  readonly createdEventReference: string;
  readonly cancelledAt: string;
}

export type KitchenReworkCancelledEnvelope = DomainEventEnvelope<KitchenReworkCancelledPayload> & {
  readonly eventType: "KitchenReworkCancelled";
  readonly schemaVersion: 1;
  readonly producerModule: "@rms/kitchen";
  readonly aggregateType: "KitchenReworkItem";
  readonly redactionClassification: "personal";
  readonly actor: Readonly<{ readonly type: "Actor"; readonly actorId: string }>;
  readonly replayMetadata: Readonly<{ readonly replaySafe: true }>;
};
