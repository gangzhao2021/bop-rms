import { readClosedRecord } from "@bop/identity";
import { parseOrderingReference, parseOrderingInstant } from "./cart.js";
import { parseOrderCancellationRequest } from "./order-cancellation-request.js";
const fail = (): never => {
  throw new Error("ORDER_CANCELLATION_EVIDENCE_INVALID");
};
/** Owner append eligibility only: current authorization and full request history
 * are independently required. Approval never executes cancellation or refund. */
export function evaluateOrderCancellationRequestEligibility(request: unknown, evidence: unknown) {
  try {
    const record = parseOrderCancellationRequest(request),
      raw = readClosedRecord(evidence, [
        "brandReference",
        "storeReference",
        "orderReference",
        "orderVersion",
        "observedAt",
        "phase",
        "closureStatus",
        "kitchenEvidenceComplete",
        "everStarted",
        "execution",
      ]);
    const brand = parseOrderingReference(raw.brandReference),
      store = parseOrderingReference(raw.storeReference),
      order = parseOrderingReference(raw.orderReference),
      at = parseOrderingInstant(raw.observedAt);
    if (
      brand !== record.brandReference ||
      store !== record.storeReference ||
      order !== record.orderReference ||
      !Number.isSafeInteger(raw.orderVersion) ||
      (raw.orderVersion as number) < 1 ||
      (raw.orderVersion as number) > 2147483647 ||
      at < record.occurredAt ||
      typeof raw.phase !== "string" ||
      ![
        "Submitted",
        "Accepted",
        "InProgress",
        "Ready",
        "Fulfilled",
        "Rejected",
        "Cancelled",
      ].includes(raw.phase) ||
      !["Open", "Closed", null].includes(raw.closureStatus as string | null) ||
      typeof raw.kitchenEvidenceComplete !== "boolean" ||
      typeof raw.everStarted !== "boolean"
    )
      return fail();
    const execution =
      raw.execution === null
        ? null
        : readClosedRecord(raw.execution, [
            "reference",
            "expectedOrderVersion",
            "terminatedOrderVersion",
            "occurredAt",
          ]);
    if (execution) {
      parseOrderingReference(execution.reference);
      if (
        parseOrderingInstant(execution.occurredAt) > at ||
        !Number.isSafeInteger(execution.expectedOrderVersion) ||
        (execution.expectedOrderVersion as number) < 1 ||
        execution.terminatedOrderVersion !== (execution.expectedOrderVersion as number) + 1
      )
        return fail();
    }
    const reasons: string[] = [];
    if (record.status === "Executed") {
      if (
        raw.phase !== "Cancelled" ||
        !execution ||
        execution.reference !== record.executionReference ||
        execution.expectedOrderVersion !== record.expectedOrderVersion ||
        execution.terminatedOrderVersion !== raw.orderVersion ||
        String(execution.occurredAt) < record.requestedAt ||
        String(execution.occurredAt) > record.occurredAt
      )
        reasons.push("CANCELLATION_EXECUTION_UNPROVEN");
    } else {
      if (raw.orderVersion !== record.expectedOrderVersion) reasons.push("ORDER_VERSION_CHANGED");
      if (record.status !== "Rejected") {
        if (raw.closureStatus !== "Open") reasons.push("ORDER_NOT_KNOWN_OPEN");
        if (["Fulfilled", "Rejected", "Cancelled"].includes(raw.phase))
          reasons.push("ORDER_EXECUTION_FINAL");
        if (record.status === "Approved" && !raw.kitchenEvidenceComplete)
          reasons.push("KITCHEN_EVIDENCE_INCOMPLETE");
      }
    }
    return Object.freeze({
      eligible: reasons.length === 0,
      reasons: Object.freeze(reasons),
      lossEvidenceRequired: raw.everStarted && record.status === "Approved",
    });
  } catch {
    return fail();
  }
}
