import type { DomainEventEnvelope, JsonObject } from "@bop/eventing";

export interface FulfillmentCompletedPayload extends JsonObject {
  readonly fulfillmentReference: string;
  readonly orderReference: string;
  readonly handoffRecordReference: string;
  readonly storeReference: string;
  /** WP-2423: InPerson when staff verified a customer whose pickup proof expired or was never issued. */
  readonly verificationMethod: "Opaque" | "HumanCode" | "InPerson";
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
