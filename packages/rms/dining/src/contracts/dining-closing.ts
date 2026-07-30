import { createTaskRecord, type TaskRecord } from "@bop/task";

import {
  parseDiningHash,
  parseDiningInstant,
  parseDiningReference,
  parseDiningSession,
  type DiningHash,
  type DiningInstant,
  type DiningReference,
  type DiningSession,
} from "./dining-session.js";
import { DiningClosingError } from "../domain/dining-closing.js";

export {
  DiningClosingError,
  diningClosingErrorCodes,
  type DiningClosingErrorCode,
} from "../domain/dining-closing.js";

export const diningBatchExecutionStates = [
  "Pending",
  "Accepted",
  "KitchenActive",
  "Fulfilled",
  "Rejected",
  "Cancelled",
] as const;
export type DiningBatchExecutionState = (typeof diningBatchExecutionStates)[number];

export const diningFinancialClasses = [
  "Settled",
  "ProviderConfirmedRefund",
  "AuthorizedWriteOff",
  "OtherControlledFinal",
  "Unpaid",
  "Indeterminate",
] as const;
export type DiningFinancialClass = (typeof diningFinancialClasses)[number];

export interface DiningBatchClosureSummary {
  readonly batchReference: DiningReference;
  readonly executionState: DiningBatchExecutionState;
}

export interface DiningOrderClosureSummary {
  readonly orderReference: DiningReference;
  readonly orderClosureStatus: "Open" | "Closed";
  readonly batches: readonly DiningBatchClosureSummary[];
  readonly financialClass: DiningFinancialClass;
  readonly ownerFinalityReference: DiningReference | null;
  readonly ownerDecidedAt: DiningInstant | null;
}

export interface DiningClosureEvidence {
  readonly diningSessionReference: DiningReference;
  readonly brandReference: DiningReference;
  readonly storeReference: DiningReference;
  readonly evidenceVersion: number;
  readonly evidenceDigest: DiningHash;
  readonly observedAt: DiningInstant;
  readonly orders: readonly DiningOrderClosureSummary[];
}

export interface DiningExceptionTaskReceipt {
  readonly orderReference: DiningReference;
  readonly evidenceVersion: number;
  readonly intentHash: DiningHash;
  readonly task: TaskRecord;
}

export interface DiningClosingOperationRecord {
  readonly action: "Begin" | "Cancel" | "Finalize";
  readonly session: DiningSession;
  readonly operationReference: DiningReference;
  readonly operationIntentHash: DiningHash;
  readonly closureEvidenceDigest: DiningHash | null;
  readonly taskReferences: readonly DiningReference[];
}

function invalid(): never {
  throw new DiningClosingError("DINING_CLOSING_INPUT_INVALID");
}

export function exactObject(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const ownKeys = Reflect.ownKeys(value);
    const allowed = new Set(keys);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      ownKeys.length !== keys.length ||
      keys.some((key) => !ownKeys.includes(key)) ||
      ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))
    )
      return invalid();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      )
        return invalid();
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof DiningClosingError) throw error;
    return invalid();
  }
}

export function parsePositiveDiningVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== "string" || !values.includes(value as T[number])) return invalid();
  return value as T[number];
}

export function parseDiningBatchClosureSummary(value: unknown): DiningBatchClosureSummary {
  const input = exactObject(value, ["batchReference", "executionState"]);
  return Object.freeze({
    batchReference: parseDiningReference(input.batchReference),
    executionState: oneOf(input.executionState, diningBatchExecutionStates),
  });
}

export function parseDiningOrderClosureSummary(value: unknown): DiningOrderClosureSummary {
  const input = exactObject(value, [
    "orderReference",
    "orderClosureStatus",
    "batches",
    "financialClass",
    "ownerFinalityReference",
    "ownerDecidedAt",
  ]);
  if (!Array.isArray(input.batches) || input.batches.length === 0) return invalid();
  const batches = Object.freeze(input.batches.map(parseDiningBatchClosureSummary));
  if (new Set(batches.map((batch) => batch.batchReference)).size !== batches.length)
    return invalid();
  const financialClass = oneOf(input.financialClass, diningFinancialClasses);
  const ownerFinalityReference =
    input.ownerFinalityReference === null
      ? null
      : parseDiningReference(input.ownerFinalityReference);
  const ownerDecidedAt =
    input.ownerDecidedAt === null ? null : parseDiningInstant(input.ownerDecidedAt);
  const unresolved = financialClass === "Unpaid" || financialClass === "Indeterminate";
  const orderClosureStatus = oneOf(input.orderClosureStatus, ["Open", "Closed"] as const);
  if (
    (unresolved &&
      (orderClosureStatus !== "Open" ||
        ownerFinalityReference !== null ||
        ownerDecidedAt !== null)) ||
    (!unresolved &&
      (orderClosureStatus !== "Closed" ||
        ownerFinalityReference === null ||
        ownerDecidedAt === null))
  )
    throw new DiningClosingError("DINING_CLOSING_FINANCIAL_EVIDENCE_INVALID");
  return Object.freeze({
    orderReference: parseDiningReference(input.orderReference),
    orderClosureStatus,
    batches,
    financialClass,
    ownerFinalityReference,
    ownerDecidedAt,
  });
}

export function parseDiningClosureEvidence(value: unknown): DiningClosureEvidence {
  const input = exactObject(value, [
    "diningSessionReference",
    "brandReference",
    "storeReference",
    "evidenceVersion",
    "evidenceDigest",
    "observedAt",
    "orders",
  ]);
  if (!Array.isArray(input.orders)) return invalid();
  const orders = Object.freeze(input.orders.map(parseDiningOrderClosureSummary));
  if (new Set(orders.map((order) => order.orderReference)).size !== orders.length) return invalid();
  const observedAt = parseDiningInstant(input.observedAt);
  if (
    orders.some(
      (order) =>
        order.ownerDecidedAt !== null && Date.parse(order.ownerDecidedAt) > Date.parse(observedAt),
    )
  )
    throw new DiningClosingError("DINING_CLOSING_FINANCIAL_EVIDENCE_INVALID");
  return Object.freeze({
    diningSessionReference: parseDiningReference(input.diningSessionReference),
    brandReference: parseDiningReference(input.brandReference),
    storeReference: parseDiningReference(input.storeReference),
    evidenceVersion: parsePositiveDiningVersion(input.evidenceVersion),
    evidenceDigest: parseDiningHash(input.evidenceDigest),
    observedAt,
    orders,
  });
}

export function parseDiningExceptionTaskReceipt(value: unknown): DiningExceptionTaskReceipt {
  const input = exactObject(value, ["orderReference", "evidenceVersion", "intentHash", "task"]);
  try {
    return Object.freeze({
      orderReference: parseDiningReference(input.orderReference),
      evidenceVersion: parsePositiveDiningVersion(input.evidenceVersion),
      intentHash: parseDiningHash(input.intentHash),
      task: createTaskRecord(input.task),
    });
  } catch (error) {
    if (error instanceof DiningClosingError) throw error;
    throw new DiningClosingError("DINING_CLOSING_TASK_REQUIRED");
  }
}

export function parseDiningClosingOperationRecord(value: unknown): DiningClosingOperationRecord {
  const input = exactObject(value, [
    "action",
    "session",
    "operationReference",
    "operationIntentHash",
    "closureEvidenceDigest",
    "taskReferences",
  ]);
  if (!Array.isArray(input.taskReferences)) return invalid();
  const taskReferences = Object.freeze(input.taskReferences.map(parseDiningReference));
  if (new Set(taskReferences).size !== taskReferences.length) return invalid();
  return Object.freeze({
    action: oneOf(input.action, ["Begin", "Cancel", "Finalize"] as const),
    session: parseDiningSession(input.session),
    operationReference: parseDiningReference(input.operationReference),
    operationIntentHash: parseDiningHash(input.operationIntentHash),
    closureEvidenceDigest:
      input.closureEvidenceDigest === null ? null : parseDiningHash(input.closureEvidenceDigest),
    taskReferences,
  });
}
