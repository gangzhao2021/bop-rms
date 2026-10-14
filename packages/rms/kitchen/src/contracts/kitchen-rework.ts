import type { DomainEventEnvelope, JsonObject } from "@bop/eventing";
import type { KitchenReworkReason } from "../domain/kitchen-rework.js";

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
