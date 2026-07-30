export const diningClosingErrorCodes = [
  "DINING_CLOSING_INPUT_INVALID",
  "DINING_CLOSING_UNAVAILABLE",
  "DINING_CLOSING_PERMISSION_DENIED",
  "DINING_CLOSING_PHASE_CONFLICT",
  "DINING_CLOSING_VERSION_CONFLICT",
  "DINING_CLOSING_IDEMPOTENCY_CONFLICT",
  "DINING_CLOSING_BATCH_NOT_TERMINAL",
  "DINING_CLOSING_FINANCIAL_EVIDENCE_INVALID",
  "DINING_CLOSING_TASK_REQUIRED",
  "DINING_CLOSING_DEPENDENCY_UNAVAILABLE",
] as const;
export type DiningClosingErrorCode = (typeof diningClosingErrorCodes)[number];

export class DiningClosingError extends Error {
  readonly code: DiningClosingErrorCode;

  constructor(code: DiningClosingErrorCode) {
    super(
      code === "DINING_CLOSING_INPUT_INVALID"
        ? "dining closing input is invalid"
        : "dining closing is unavailable",
    );
    this.name = "DiningClosingError";
    this.code = code;
  }
}

interface ClosingSession {
  readonly diningSessionReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly tableReference: string;
  readonly tableAssignmentVersion: number;
  readonly phase: "Active" | "Closing" | "Closed" | "Cancelled";
  readonly version: number;
  readonly startedByActorReference: string;
  readonly startedAt: string;
  readonly hostParticipantReference: string | null;
}

interface ClosingOrder {
  readonly batches: readonly { readonly executionState: string }[];
  readonly financialClass: string;
}

interface ClosingEvidence<TOrder extends ClosingOrder = ClosingOrder> {
  readonly diningSessionReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly orders: readonly TOrder[];
}

const sessionKeys = [
  "diningSessionReference",
  "brandReference",
  "storeReference",
  "tableReference",
  "tableAssignmentVersion",
  "phase",
  "version",
  "startedByActorReference",
  "startedAt",
  "hostParticipantReference",
] as const;
const phases = new Set(["Active", "Closing", "Closed", "Cancelled"]);
const terminalExecution = new Set(["Fulfilled", "Rejected", "Cancelled"]);

function validSession<T extends ClosingSession>(value: T): T {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== sessionKeys.length ||
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !sessionKeys.includes(key as never),
    ) ||
    !phases.has(value.phase) ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1
  )
    throw new DiningClosingError("DINING_CLOSING_INPUT_INVALID");
  return value;
}

export function mayAdmitNewBatch<T extends ClosingSession>(session: T): boolean {
  return validSession(session).phase === "Active";
}

export function beginDiningClosing<T extends ClosingSession>(session: T): T {
  const current = validSession(session);
  if (current.phase !== "Active") throw new DiningClosingError("DINING_CLOSING_PHASE_CONFLICT");
  return Object.freeze({ ...current, phase: "Closing", version: current.version + 1 }) as T;
}

export function cancelDiningClosing<T extends ClosingSession>(
  session: T,
  reversibility: "Reversible" | "Irreversible" | "Indeterminate" | "Unavailable",
): T {
  const current = validSession(session);
  if (current.phase !== "Closing") throw new DiningClosingError("DINING_CLOSING_PHASE_CONFLICT");
  if (reversibility !== "Reversible") throw new DiningClosingError("DINING_CLOSING_UNAVAILABLE");
  return Object.freeze({ ...current, phase: "Active", version: current.version + 1 }) as T;
}

export function unresolvedDiningOrders<TOrder extends ClosingOrder>(
  evidence: ClosingEvidence<TOrder>,
): readonly TOrder[] {
  for (const order of evidence.orders) {
    if (order.batches.some((batch) => !terminalExecution.has(batch.executionState)))
      throw new DiningClosingError("DINING_CLOSING_BATCH_NOT_TERMINAL");
  }
  return Object.freeze(
    evidence.orders.filter(
      (order) => order.financialClass === "Unpaid" || order.financialClass === "Indeterminate",
    ),
  );
}

export function finalizeDiningClosing<T extends ClosingSession>(
  session: T,
  evidence: ClosingEvidence,
  taskReceiptCount: number,
): T {
  const current = validSession(session);
  if (current.phase !== "Closing") throw new DiningClosingError("DINING_CLOSING_PHASE_CONFLICT");
  if (
    evidence.diningSessionReference !== current.diningSessionReference ||
    evidence.brandReference !== current.brandReference ||
    evidence.storeReference !== current.storeReference
  )
    throw new DiningClosingError("DINING_CLOSING_UNAVAILABLE");
  const unresolved = unresolvedDiningOrders(evidence);
  if (taskReceiptCount !== unresolved.length)
    throw new DiningClosingError("DINING_CLOSING_TASK_REQUIRED");
  return Object.freeze({ ...current, phase: "Closed", version: current.version + 1 }) as T;
}
