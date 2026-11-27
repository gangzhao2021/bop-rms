import { readClosedRecord } from "@bop/identity";
import { parseOrderingHash, parseOrderingInstant, parseOrderingReference } from "../domain/cart.js";
import { parseFulfillmentCompletedEnvelope } from "./fulfillment-completed-event.js";

export class OrderFulfillmentCompletionError extends Error {
  constructor(
    readonly code:
      | "ORDER_FULFILLMENT_COMPLETION_INVALID"
      | "ORDER_FULFILLMENT_COMPLETION_CONFLICT"
      | "ORDER_FULFILLMENT_COMPLETION_UNAVAILABLE",
  ) {
    super("order fulfillment completion is unavailable");
    this.name = "OrderFulfillmentCompletionError";
  }
}
function invalid(): never {
  throw new OrderFulfillmentCompletionError("ORDER_FULFILLMENT_COMPLETION_INVALID");
}
const fields = [
  "completionReference",
  "operationReference",
  "auditReference",
  "brandReference",
  "storeReference",
  "orderReference",
  "orderBatchReference",
  "orderType",
  "phaseBefore",
  "expectedOrderVersion",
  "expectedSourceCheckpoint",
  "fulfilledOrderVersion",
  "phase",
  "closureStatus",
  "actorType",
  "actorReference",
  "purposeCode",
  "permissionCode",
  "workflowVersionReference",
  "transitionReference",
  "completedAt",
  "recordedAt",
  "sourceEvent",
  "sourceDigest",
] as const;
function code(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value))
    return invalid();
  return value;
}
/** Immutable owner fact shape, not proof that the current source or Workflow authorized a write. */
export function parseOrderFulfillmentCompletionRecord(value: unknown) {
  try {
    const raw = readClosedRecord(value, fields, "ACTOR_SHAPE_INVALID");
    const sourceEvent = parseFulfillmentCompletedEnvelope(raw.sourceEvent);
    const expectedOrderVersion = raw.expectedOrderVersion,
      fulfilledOrderVersion = raw.fulfilledOrderVersion;
    if (
      typeof expectedOrderVersion !== "number" ||
      !Number.isInteger(expectedOrderVersion) ||
      expectedOrderVersion < 2 ||
      expectedOrderVersion >= 2147483647 ||
      fulfilledOrderVersion !== expectedOrderVersion + 1 ||
      (raw.phaseBefore !== "Accepted" &&
        raw.phaseBefore !== "InProgress" &&
        raw.phaseBefore !== "Ready") ||
      raw.orderType !== "Pickup" ||
      raw.phase !== "Fulfilled" ||
      raw.closureStatus !== "Open" ||
      raw.actorType !== "System" ||
      raw.actorReference !== null
    )
      return invalid();
    const record = Object.freeze({
      completionReference: parseOrderingReference(raw.completionReference),
      operationReference: parseOrderingReference(raw.operationReference),
      auditReference: parseOrderingReference(raw.auditReference),
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      orderReference: parseOrderingReference(raw.orderReference),
      orderBatchReference: parseOrderingReference(raw.orderBatchReference),
      orderType: "Pickup" as const,
      phaseBefore: raw.phaseBefore,
      expectedOrderVersion,
      expectedSourceCheckpoint: parseOrderingReference(raw.expectedSourceCheckpoint),
      fulfilledOrderVersion: expectedOrderVersion + 1,
      phase: "Fulfilled" as const,
      closureStatus: "Open" as const,
      actorType: "System" as const,
      actorReference: null,
      purposeCode: code(raw.purposeCode),
      permissionCode: code(raw.permissionCode),
      workflowVersionReference: parseOrderingReference(raw.workflowVersionReference),
      transitionReference: parseOrderingReference(raw.transitionReference),
      completedAt: parseOrderingInstant(raw.completedAt),
      recordedAt: parseOrderingInstant(raw.recordedAt),
      sourceEvent,
      sourceDigest: parseOrderingHash(raw.sourceDigest),
    });
    if (
      record.brandReference !== sourceEvent.tenantId ||
      record.storeReference !== sourceEvent.storeId ||
      record.orderReference !== sourceEvent.payload.orderReference ||
      record.completedAt !== sourceEvent.occurredAt ||
      record.recordedAt < record.completedAt ||
      new Set([
        record.completionReference,
        record.operationReference,
        record.auditReference,
        record.orderReference,
        record.orderBatchReference,
        record.brandReference,
        record.storeReference,
        record.workflowVersionReference,
        record.transitionReference,
        record.expectedSourceCheckpoint,
        sourceEvent.eventId,
        sourceEvent.aggregateId,
        sourceEvent.payload.handoffRecordReference,
        sourceEvent.causationId,
      ]).size !== 14
    )
      return invalid();
    return record;
  } catch {
    return invalid();
  }
}
export type OrderFulfillmentCompletionRecord = ReturnType<
  typeof parseOrderFulfillmentCompletionRecord
>;
/** JSONB may reorder every object; semantic identity must not depend on insertion order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === "bigint") return entry.toString();
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const object = entry as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(object)
          .sort()
          .map((key) => [key, object[key]]),
      );
    }
    return entry;
  });
}
export function orderFulfillmentCompletionBinding(value: unknown): string {
  const record = parseOrderFulfillmentCompletionRecord(value);
  return canonicalJson({
    kind: "OrderFulfillmentCompletion:v1",
    ...Object.fromEntries(
      fields.filter((key) => key !== "sourceDigest").map((key) => [key, record[key]]),
    ),
  });
}
export function createOrderFulfillmentCompletionRecord(
  value: unknown,
  sha256: (value: string) => string,
): OrderFulfillmentCompletionRecord {
  try {
    const input = readClosedRecord(
      value,
      fields.filter((key) => key !== "sourceDigest"),
      "ACTOR_SHAPE_INVALID",
    );
    const candidate = parseOrderFulfillmentCompletionRecord({
      ...input,
      sourceDigest: "sha256:" + "0".repeat(64),
    });
    return parseOrderFulfillmentCompletionRecord({
      ...candidate,
      sourceDigest: sha256(orderFulfillmentCompletionBinding(candidate)),
    });
  } catch {
    return invalid();
  }
}
export function validateOrderFulfillmentCompletionRecord(
  value: unknown,
  sha256: (value: string) => string,
): OrderFulfillmentCompletionRecord {
  try {
    const record = parseOrderFulfillmentCompletionRecord(value);
    if (sha256(orderFulfillmentCompletionBinding(record)) !== record.sourceDigest) return invalid();
    return record;
  } catch {
    return invalid();
  }
}
export function encodeOrderFulfillmentCompletionRecord(
  value: unknown,
  sha256: (value: string) => string,
): string {
  const record = validateOrderFulfillmentCompletionRecord(value, sha256);
  return canonicalJson({ recordVersion: 1, record });
}
export function decodeOrderFulfillmentCompletionRecord(
  value: unknown,
  sha256: (value: string) => string,
): OrderFulfillmentCompletionRecord {
  try {
    if (typeof value !== "string") return invalid();
    const envelope = JSON.parse(value);
    if (
      !envelope ||
      typeof envelope !== "object" ||
      Array.isArray(envelope) ||
      Object.keys(envelope).length !== 2 ||
      envelope.recordVersion !== 1 ||
      !Object.hasOwn(envelope, "record")
    )
      return invalid();
    const version = envelope.record?.sourceEvent?.aggregateVersion;
    if (
      typeof version !== "string" ||
      !/^[1-9][0-9]{0,18}$/.test(version) ||
      BigInt(version) > 9223372036854775807n
    )
      return invalid();
    envelope.record.sourceEvent.aggregateVersion = BigInt(version);
    return validateOrderFulfillmentCompletionRecord(envelope.record, sha256);
  } catch {
    return invalid();
  }
}
