import type { DomainEventEnvelope, JsonObject } from "@bop/eventing";

export interface OrderConfirmedPayload extends JsonObject {
  readonly confirmationReference: string;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly sourceSnapshotDigest: string;
  readonly confirmedAt: string;
}

export type OrderConfirmedEnvelope = DomainEventEnvelope<OrderConfirmedPayload> & {
  readonly eventType: "OrderConfirmed";
};
