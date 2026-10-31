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
    // WP-2423 Q6 step 2a: up to 100 staff item cancellations may follow acceptance, each one
    // revision; the Order stays Accepted until it is cancelled or completed.
    const version = raw.version;
    const afterAcceptance =
      typeof version === "number" && Number.isSafeInteger(version) && version >= 2;
    if (!(
      (raw.phase === "Submitted" && version === 1) ||
      (raw.phase === "Accepted" && afterAcceptance && (version as number) <= 102) ||
      (raw.phase === "Rejected" && version === 2) ||
      (raw.phase === "Cancelled" && afterAcceptance && (version as number) <= 103)
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
