import { readClosedRecord } from "@bop/identity";
import { parseOrderingReference, parseOrderingHash, parseOrderingInstant } from "../domain/cart.js";

export class OrderTerminationError extends Error {
  constructor(
    readonly code:
      "ORDER_TERMINATION_INVALID" | "ORDER_TERMINATION_CONFLICT" | "ORDER_TERMINATION_UNAVAILABLE",
  ) {
    super("order termination is unavailable");
    this.name = "OrderTerminationError";
  }
}
const fields = [
  "terminationReference",
  "operationReference",
  "brandReference",
  "storeReference",
  "orderReference",
  "orderBatchReference",
  "expectedOrderVersion",
  "terminatedOrderVersion",
  "expectedSourceCheckpoint",
  "previousPhase",
  "phase",
  "actorType",
  "actorReference",
  "purposeCode",
  "permissionCode",
  "reasonCode",
  "workflowVersionReference",
  "transitionReference",
  "sourceDigest",
  "terminatedAt",
] as const;

/** Initial-window termination, separate from cancellation request, Kitchen loss and Payment refund. */
export function parseOrderTerminationRecord(value: unknown) {
  try {
    const raw = readClosedRecord(value, fields, "ACTOR_SHAPE_INVALID");
    const expected = raw.expectedOrderVersion,
      next = raw.terminatedOrderVersion;
    if (
      typeof expected !== "number" ||
      !Number.isInteger(expected) ||
      expected < 1 ||
      typeof next !== "number" ||
      !Number.isInteger(next) ||
      next > 2147483647 ||
      next !== expected + 1 ||
      (raw.previousPhase !== "Submitted" && raw.previousPhase !== "Accepted") ||
      (raw.phase !== "Cancelled" && raw.phase !== "Rejected") ||
      (raw.phase === "Rejected" && raw.previousPhase !== "Submitted") ||
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
      terminationReference: parseOrderingReference(raw.terminationReference),
      operationReference: parseOrderingReference(raw.operationReference),
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      orderReference: parseOrderingReference(raw.orderReference),
      orderBatchReference: parseOrderingReference(raw.orderBatchReference),
      expectedOrderVersion: expected,
      terminatedOrderVersion: next,
      expectedSourceCheckpoint: parseOrderingReference(raw.expectedSourceCheckpoint),
      previousPhase: raw.previousPhase,
      phase: raw.phase,
      actorType: raw.actorType,
      actorReference: raw.actorType === "User" ? parseOrderingReference(raw.actorReference) : null,
      purposeCode: code(raw.purposeCode),
      permissionCode: code(raw.permissionCode),
      reasonCode: code(raw.reasonCode),
      workflowVersionReference: parseOrderingReference(raw.workflowVersionReference),
      transitionReference: parseOrderingReference(raw.transitionReference),
      sourceDigest: parseOrderingHash(raw.sourceDigest),
      terminatedAt: parseOrderingInstant(raw.terminatedAt),
    });
  } catch {
    throw new OrderTerminationError("ORDER_TERMINATION_INVALID");
  }
}
export type OrderTerminationRecord = ReturnType<typeof parseOrderTerminationRecord>;
