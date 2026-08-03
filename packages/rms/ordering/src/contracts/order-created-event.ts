import type { DomainEventEnvelope, JsonObject } from "@bop/eventing";

export interface OrderCreatedPayload extends JsonObject {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly submissionReference: string;
  readonly businessDate: string;
  readonly sourceSnapshotDigest: string;
  readonly itemCount: number;
}

export type OrderCreatedEnvelope = DomainEventEnvelope<OrderCreatedPayload>;
