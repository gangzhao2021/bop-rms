import type { DomainEventEnvelope, JsonObject } from "@bop/eventing";

export interface FulfillmentCompletedPayload extends JsonObject {
  readonly fulfillmentReference: string;
  readonly orderReference: string;
  readonly handoffRecordReference: string;
  readonly storeReference: string;
  readonly verificationMethod: "Opaque" | "HumanCode";
  readonly completedAt: string;
}

export type FulfillmentCompletedEnvelope = DomainEventEnvelope<FulfillmentCompletedPayload> & {
  readonly eventType: "FulfillmentCompleted";
  readonly schemaVersion: 1;
  readonly producerModule: "@rms/fulfillment";
  readonly aggregateType: "Fulfillment";
  readonly redactionClassification: "indirect_identifier";
  readonly actor: Readonly<{ readonly type: "System" }>;
  readonly replayMetadata: Readonly<{ readonly replaySafe: true }>;
};
