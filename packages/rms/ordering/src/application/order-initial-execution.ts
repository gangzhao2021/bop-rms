import { readClosedRecord } from "@bop/identity";
import { parseOrderingReference, parseOrderingInstant } from "../domain/cart.js";
import { OrderTerminationError } from "./order-termination-record.js";

/** Initial Order window only; does not assert Kitchen, amendment or financial eligibility. */
export function parseOrderInitialExecution(value: unknown) {
  try {
    const raw = readClosedRecord(
      value,
      [
        "brandReference",
        "storeReference",
        "orderReference",
        "orderBatchReference",
        "phase",
        "version",
        "checkpoint",
        "occurredAt",
      ],
      "ACTOR_SHAPE_INVALID",
    );
    if (!(
      (raw.phase === "Submitted" && raw.version === 1) ||
      (raw.phase === "Accepted" && raw.version === 2) ||
      (raw.phase === "Rejected" && raw.version === 2) ||
      (raw.phase === "Cancelled" && (raw.version === 2 || raw.version === 3))
    ))
      throw new Error("invalid");
    return Object.freeze({
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      orderReference: parseOrderingReference(raw.orderReference),
      orderBatchReference: parseOrderingReference(raw.orderBatchReference),
      phase: raw.phase as "Submitted" | "Accepted" | "Rejected" | "Cancelled",
      version: raw.version as number,
      checkpoint: parseOrderingReference(raw.checkpoint),
      occurredAt: parseOrderingInstant(raw.occurredAt),
    });
  } catch {
    throw new OrderTerminationError("ORDER_TERMINATION_INVALID");
  }
}
