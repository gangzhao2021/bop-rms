import { readClosedRecord } from "@bop/identity";
import { parseOrderingInstant, parseOrderingReference } from "./cart.js";
const fail = (): never => {
  throw new Error("ORDER_CLOSURE_EVIDENCE_INVALID");
};
const finalStates = ["Fulfilled", "Rejected", "Cancelled"];
function code(value: unknown, choices: readonly string[]) {
  if (typeof value !== "string" || !choices.includes(value)) return fail();
  return value;
}
function count(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail();
  return value;
}
function array(value: unknown): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length === 0 ||
    value.length > 10000 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const field = Object.getOwnPropertyDescriptor(value, String(i));
    if (!field || !("value" in field) || !field.enumerable) return fail();
    return field.value;
  });
}
/** Internal rule over server-composed, current owning-Domain facts. Callers must
 * validate scope/version, completeness and retain all owner fences until commit.
 * Eligible is not a persisted closure, Payment finality or permission to mutate. */
export function evaluateOrderClosureEligibility(value: unknown) {
  try {
    const raw = readClosedRecord(value, [
      "brandReference",
      "storeReference",
      "orderReference",
      "orderVersion",
      "observedAt",
      "inventoryComplete",
      "batches",
      "items",
      "fulfillmentState",
      "pendingAmendmentCount",
      "pendingCancellationCount",
      "criticalBlockingTaskCount",
      "financialFinality",
    ]);
    const scope = {
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      orderReference: parseOrderingReference(raw.orderReference),
    };
    const orderVersion = count(raw.orderVersion),
      observedAt = parseOrderingInstant(raw.observedAt);
    if (orderVersion === null || orderVersion < 1 || typeof raw.inventoryComplete !== "boolean")
      return fail();
    const batches = new Map<string, string>();
    for (const entry of array(raw.batches)) {
      const row = readClosedRecord(entry, ["batchReference", "state"]),
        reference = parseOrderingReference(row.batchReference);
      if (batches.has(reference)) return fail();
      batches.set(
        reference,
        code(row.state, [...finalStates, "Pending", "Accepted", "InProgress", "Unknown"]),
      );
    }
    const items = new Set<string>(),
      coveredBatches = new Set<string>();
    let itemFinal = true;
    for (const entry of array(raw.items)) {
      const row = readClosedRecord(entry, ["itemReference", "batchReference", "state"]),
        reference = parseOrderingReference(row.itemReference),
        batch = parseOrderingReference(row.batchReference);
      if (items.has(reference) || !batches.has(batch)) return fail();
      items.add(reference);
      coveredBatches.add(batch);
      const state = code(row.state, [
        ...finalStates,
        "Pending",
        "Accepted",
        "InProgress",
        "Unknown",
      ]);
      if (!finalStates.includes(state)) itemFinal = false;
    }
    if (coveredBatches.size !== batches.size) return fail();
    const fulfillment = code(raw.fulfillmentState, [
        ...finalStates,
        "Pending",
        "InProgress",
        "Unknown",
      ]),
      amendments = count(raw.pendingAmendmentCount),
      cancellations = count(raw.pendingCancellationCount),
      tasks = count(raw.criticalBlockingTaskCount);
    let financialComplete = false;
    if (raw.financialFinality !== null) {
      const fact = readClosedRecord(raw.financialFinality, [
        "orderReference",
        "class",
        "ownerFinalityReference",
        "decidedAt",
      ]);
      if (parseOrderingReference(fact.orderReference) !== scope.orderReference) return fail();
      code(fact.class, [
        "Settled",
        "ProviderConfirmedRefund",
        "AuthorizedWriteOff",
        "OtherControlledFinal",
      ]);
      parseOrderingReference(fact.ownerFinalityReference);
      if (parseOrderingInstant(fact.decidedAt) > observedAt) return fail();
      financialComplete = true;
    }
    const reasons: string[] = [];
    if (
      !raw.inventoryComplete ||
      amendments === null ||
      cancellations === null ||
      tasks === null ||
      fulfillment === "Unknown" ||
      [...batches.values()].includes("Unknown")
    )
      reasons.push("EVIDENCE_INCOMPLETE");
    if (!itemFinal || [...batches.values()].some((state) => !finalStates.includes(state)))
      reasons.push("EXECUTION_NOT_FINAL");
    if (!finalStates.includes(fulfillment)) reasons.push("FULFILLMENT_NOT_FINAL");
    if (amendments !== null && amendments > 0) reasons.push("AMENDMENT_PENDING");
    if (cancellations !== null && cancellations > 0) reasons.push("CANCELLATION_PENDING");
    if (tasks !== null && tasks > 0) reasons.push("CRITICAL_TASK_BLOCKING");
    if (!financialComplete) reasons.push("FINANCIAL_FINALITY_REQUIRED");
    return Object.freeze({
      ...scope,
      orderVersion,
      observedAt,
      eligible: reasons.length === 0,
      reasons: Object.freeze(reasons),
    });
  } catch {
    return fail();
  }
}
