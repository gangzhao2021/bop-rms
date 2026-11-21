import { exactPaymentObject, parsePaymentInstant } from "./payment-intent-creation.js";
import { parsePaymentReference } from "./payment-provider-adapter.js";
export class ReconciliationFollowUpError extends Error {
  constructor(
    readonly code:
      | "RECONCILIATION_FOLLOW_UP_INVALID"
      | "RECONCILIATION_FOLLOW_UP_CONFLICT"
      | "RECONCILIATION_FOLLOW_UP_PERMISSION_DENIED"
      | "RECONCILIATION_FOLLOW_UP_UNAVAILABLE",
  ) {
    super(code);
    this.name = "ReconciliationFollowUpError";
  }
}
const invalid = (): never => {
  throw new ReconciliationFollowUpError("RECONCILIATION_FOLLOW_UP_INVALID");
};
const scopeFields = [
  "tenantReference",
  "brandReference",
  "storeReference",
  "exceptionReference",
] as const;
function scope(raw: Record<string, unknown>) {
  return {
    tenantReference: parsePaymentReference(raw.tenantReference),
    brandReference: parsePaymentReference(raw.brandReference),
    storeReference: parsePaymentReference(raw.storeReference),
    exceptionReference: parsePaymentReference(raw.exceptionReference),
  };
}
function version(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value >= Number.MAX_SAFE_INTEGER
  )
    return invalid();
  return value;
}
export function parseReconciliationFollowUp(value: unknown) {
  try {
    const raw = exactPaymentObject(value, [
      ...scopeFields,
      "version",
      "status",
      "acknowledgedByReference",
      "ownerReference",
      "openedAt",
      "updatedAt",
    ]);
    if (!["Open", "Acknowledged", "Assigned"].includes(String(raw.status))) return invalid();
    const acknowledgedByReference =
      raw.acknowledgedByReference === null
        ? null
        : parsePaymentReference(raw.acknowledgedByReference);
    const ownerReference =
      raw.ownerReference === null ? null : parsePaymentReference(raw.ownerReference);
    if (
      (raw.status === "Open" && (acknowledgedByReference !== null || ownerReference !== null)) ||
      (raw.status === "Acknowledged" &&
        (acknowledgedByReference === null || ownerReference !== null)) ||
      (raw.status === "Assigned" && ownerReference === null)
    )
      return invalid();
    const openedAt = parsePaymentInstant(raw.openedAt),
      updatedAt = parsePaymentInstant(raw.updatedAt);
    if (openedAt > updatedAt) return invalid();
    return Object.freeze({
      ...scope(raw),
      version: version(raw.version),
      status: raw.status as "Open" | "Acknowledged" | "Assigned",
      acknowledgedByReference,
      ownerReference,
      openedAt,
      updatedAt,
    });
  } catch {
    return invalid();
  }
}
export function parseReconciliationFollowUpCommand(value: unknown) {
  try {
    const raw = exactPaymentObject(value, [
      ...scopeFields,
      "expectedVersion",
      "operationReference",
      "actorReference",
      "action",
      "assigneeReference",
      "occurredAt",
    ]);
    if (raw.action !== "Acknowledge" && raw.action !== "Assign") return invalid();
    if ((raw.action === "Acknowledge") !== (raw.assigneeReference === null)) return invalid();
    return Object.freeze({
      ...scope(raw),
      expectedVersion: version(raw.expectedVersion),
      operationReference: parsePaymentReference(raw.operationReference),
      actorReference: parsePaymentReference(raw.actorReference),
      action: raw.action as "Acknowledge" | "Assign",
      assigneeReference:
        raw.assigneeReference === null ? null : parsePaymentReference(raw.assigneeReference),
      occurredAt: parsePaymentInstant(raw.occurredAt),
    });
  } catch {
    return invalid();
  }
}
/** Pure owner transition. Caller must authorize the named Actor/assignee and persist
 * under one version/idempotency fence with Audit. This never resolves a financial difference.
 */
export function transitionReconciliationFollowUp(currentValue: unknown, commandValue: unknown) {
  const current = parseReconciliationFollowUp(currentValue),
    command = parseReconciliationFollowUpCommand(commandValue);
  if (
    scopeFields.some((field) => current[field] !== command[field]) ||
    current.version !== command.expectedVersion ||
    command.occurredAt < current.updatedAt
  )
    throw new ReconciliationFollowUpError("RECONCILIATION_FOLLOW_UP_CONFLICT");
  const ownerReference =
    command.action === "Assign" ? command.assigneeReference : current.ownerReference;
  const acknowledgedByReference =
    command.action === "Acknowledge"
      ? (current.acknowledgedByReference ?? command.actorReference)
      : current.acknowledgedByReference;
  return parseReconciliationFollowUp({
    ...current,
    version: current.version + 1,
    ownerReference,
    acknowledgedByReference,
    status: ownerReference !== null ? "Assigned" : "Acknowledged",
    updatedAt: command.occurredAt,
  });
}
