import { readClosedRecord } from "@bop/identity";
import {
  validateDomainEventEnvelope,
  type DomainEventEnvelope,
  type JsonObject,
} from "@bop/eventing";
import { parseOrderingReference, parseOrderingHash } from "../domain/cart.js";

export interface OrderSubmittedPayload extends JsonObject {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly submissionReference: string;
  readonly sourceSnapshotDigest: string;
  readonly itemCount: number;
  readonly batchSequence: number;
}
export type OrderSubmittedEnvelope = DomainEventEnvelope<OrderSubmittedPayload>;
export function parseOrderSubmittedEnvelope(value: unknown): OrderSubmittedEnvelope {
  try {
    const envelope = validateDomainEventEnvelope(value as OrderSubmittedEnvelope);
    const raw = readClosedRecord(envelope.payload, [
      "orderReference",
      "orderBatchReference",
      "submissionReference",
      "sourceSnapshotDigest",
      "itemCount",
      "batchSequence",
    ]);
    const payload = Object.freeze({
      orderReference: parseOrderingReference(raw.orderReference),
      orderBatchReference: parseOrderingReference(raw.orderBatchReference),
      submissionReference: parseOrderingReference(raw.submissionReference),
      sourceSnapshotDigest: parseOrderingHash(raw.sourceSnapshotDigest),
      itemCount: raw.itemCount as number,
      batchSequence: raw.batchSequence as number,
    });
    if (
      envelope.eventType !== "OrderSubmitted" ||
      envelope.schemaVersion !== 1 ||
      envelope.producerModule !== "@rms/ordering" ||
      envelope.storeId === undefined ||
      envelope.aggregateType !== "Order" ||
      envelope.aggregateId !== payload.orderReference ||
      envelope.causationId !== payload.submissionReference ||
      envelope.aggregateVersion < 1n ||
      envelope.aggregateVersion > 2147483647n ||
      envelope.actor.type !== "System" ||
      envelope.redactionClassification !== "indirect_identifier" ||
      envelope.replayMetadata.replaySafe !== true ||
      Object.keys(envelope.replayMetadata).length !== 1 ||
      !Number.isSafeInteger(payload.itemCount) ||
      payload.itemCount < 1 ||
      payload.itemCount > 100 ||
      !Number.isSafeInteger(payload.batchSequence) ||
      payload.batchSequence < 1 ||
      payload.batchSequence > Number(envelope.aggregateVersion)
    )
      throw new Error();
    return Object.freeze({ ...envelope, payload }) as OrderSubmittedEnvelope;
  } catch {
    throw new Error("ORDER_SUBMITTED_EVENT_INVALID");
  }
}
