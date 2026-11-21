import { readClosedRecord } from "@bop/identity";
import { parseOrderingReference, parseOrderingHash, parseOrderingInstant } from "../domain/cart.js";

export class OrderAcceptanceRecordError extends Error {
  constructor(
    readonly code:
      | "ORDER_ACCEPTANCE_RECORD_INVALID"
      | "ORDER_ACCEPTANCE_RECORD_CONFLICT"
      | "ORDER_ACCEPTANCE_RECORD_UNAVAILABLE",
  ) {
    super("order acceptance record is unavailable");
    this.name = "OrderAcceptanceRecordError";
  }
}

const fields = [
  "acceptanceReference",
  "operationReference",
  "brandReference",
  "storeReference",
  "orderReference",
  "orderBatchReference",
  "expectedOrderVersion",
  "acceptedOrderVersion",
  "actorType",
  "actorReference",
  "purposeCode",
  "permissionCode",
  "reasonCode",
  "workflowVersionReference",
  "transitionReference",
  "sourceDigest",
  "acceptedAt",
] as const;

/** General merchant/system acceptance history; not terminal authorization or confirmation. */
export function parseOrderAcceptanceRecord(value: unknown) {
  try {
    const raw = readClosedRecord(value, fields, "ACTOR_SHAPE_INVALID");
    const expected = raw.expectedOrderVersion,
      accepted = raw.acceptedOrderVersion;
    if (
      typeof expected !== "number" ||
      !Number.isInteger(expected) ||
      expected < 1 ||
      typeof accepted !== "number" ||
      !Number.isInteger(accepted) ||
      accepted > 2147483647 ||
      accepted !== expected + 1 ||
      (raw.actorType !== "User" && raw.actorType !== "System") ||
      (raw.actorType === "System" && raw.actorReference !== null) ||
      (raw.actorType === "User" && raw.actorReference === null)
    )
      throw new Error("invalid");
    const code = (value: unknown) => {
      if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value))
        throw new Error("invalid");
      return value;
    };
    return Object.freeze({
      acceptanceReference: parseOrderingReference(raw.acceptanceReference),
      operationReference: parseOrderingReference(raw.operationReference),
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      orderReference: parseOrderingReference(raw.orderReference),
      orderBatchReference: parseOrderingReference(raw.orderBatchReference),
      expectedOrderVersion: expected,
      acceptedOrderVersion: accepted,
      actorType: raw.actorType,
      actorReference: raw.actorType === "User" ? parseOrderingReference(raw.actorReference) : null,
      purposeCode: code(raw.purposeCode),
      permissionCode: code(raw.permissionCode),
      reasonCode: code(raw.reasonCode),
      workflowVersionReference: parseOrderingReference(raw.workflowVersionReference),
      transitionReference: parseOrderingReference(raw.transitionReference),
      sourceDigest: parseOrderingHash(raw.sourceDigest),
      acceptedAt: parseOrderingInstant(raw.acceptedAt),
    });
  } catch {
    throw new OrderAcceptanceRecordError("ORDER_ACCEPTANCE_RECORD_INVALID");
  }
}
export type OrderAcceptanceRecord = ReturnType<typeof parseOrderAcceptanceRecord>;
