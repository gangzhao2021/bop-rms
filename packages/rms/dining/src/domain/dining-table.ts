import {
  parseDiningInstant,
  parseDiningReference,
  parseDiningSession,
  type DiningInstant,
  type DiningReference,
  type DiningSession,
} from "./dining-session.js";

export type DiningTableLifecycle = "Draft" | "Published";
export type DiningTableQrStatus = "Inactive" | "Active" | "Revoked";
export type DiningTableOperationalState = "Available" | "TemporarilyBlocked";
export type DiningTableCode = string & { readonly __diningTableCode: unique symbol };

export interface DiningTable {
  readonly tableReference: DiningReference;
  readonly tenantReference: DiningReference;
  readonly brandReference: DiningReference;
  readonly storeReference: DiningReference;
  readonly stableLabel: string;
  readonly areaReference: DiningReference;
  readonly areaCode: DiningTableCode;
  readonly capacity: number;
  readonly accessibilityAttributes: readonly DiningTableCode[];
  readonly lifecycle: DiningTableLifecycle;
  readonly qrStatus: DiningTableQrStatus;
  readonly qrVersion: number;
  readonly operationalState: DiningTableOperationalState;
  readonly blockReasonCode: DiningTableCode | null;
  readonly activeDiningSessionReference: DiningReference | null;
  readonly aggregateVersion: number;
  readonly createdAt: DiningInstant;
  readonly observedAt: DiningInstant;
}

export type DiningTableErrorCode =
  | "DINING_TABLE_INPUT_INVALID"
  | "DINING_TABLE_TRANSITION_INVALID"
  | "DINING_TABLE_CAPACITY_CONFLICT"
  | "DINING_TABLE_SESSION_CONFLICT";

export class DiningTableError extends Error {
  constructor(readonly code: DiningTableErrorCode) {
    super("Dining Table is unavailable");
    this.name = "DiningTableError";
  }
}

const fail = (code: DiningTableErrorCode): never => {
  throw new DiningTableError(code);
};
const codePattern = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const safeLabel = /^[^\p{Cc}\p{Cf}<>{}$]{1,40}$/u;

function closed(value: unknown, keys: readonly string[]) {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return fail("DINING_TABLE_INPUT_INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        return fail("DINING_TABLE_INPUT_INVALID");
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof DiningTableError) throw error;
    return fail("DINING_TABLE_INPUT_INVALID");
  }
}

export function parseDiningTableCode(value: unknown): DiningTableCode {
  if (typeof value !== "string" || !codePattern.test(value))
    return fail("DINING_TABLE_INPUT_INVALID");
  return value as DiningTableCode;
}

function positive(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
    return fail("DINING_TABLE_INPUT_INVALID");
  return value as number;
}

export function createDiningTable(value: unknown): DiningTable {
  const raw = closed(value, [
    "tableReference",
    "tenantReference",
    "brandReference",
    "storeReference",
    "stableLabel",
    "areaReference",
    "areaCode",
    "capacity",
    "accessibilityAttributes",
    "lifecycle",
    "qrStatus",
    "qrVersion",
    "operationalState",
    "blockReasonCode",
    "activeDiningSessionReference",
    "aggregateVersion",
    "createdAt",
    "observedAt",
  ]);
  if (
    typeof raw.stableLabel !== "string" ||
    !safeLabel.test(raw.stableLabel) ||
    raw.stableLabel.trim() !== raw.stableLabel ||
    !Array.isArray(raw.accessibilityAttributes) ||
    raw.accessibilityAttributes.length > 16 ||
    (raw.lifecycle !== "Draft" && raw.lifecycle !== "Published") ||
    !["Inactive", "Active", "Revoked"].includes(raw.qrStatus as string) ||
    !["Available", "TemporarilyBlocked"].includes(raw.operationalState as string)
  )
    return fail("DINING_TABLE_INPUT_INVALID");
  const attributes = raw.accessibilityAttributes.map(parseDiningTableCode).sort();
  const blockReason =
    raw.blockReasonCode === null ? null : parseDiningTableCode(raw.blockReasonCode);
  if (
    new Set(attributes).size !== attributes.length ||
    (raw.lifecycle === "Draft" &&
      (raw.qrStatus !== "Inactive" ||
        raw.operationalState !== "Available" ||
        raw.activeDiningSessionReference !== null)) ||
    (raw.operationalState === "TemporarilyBlocked") !== (blockReason !== null) ||
    (raw.qrStatus === "Inactive" && raw.qrVersion !== 0) ||
    (raw.qrStatus !== "Inactive" &&
      (!Number.isSafeInteger(raw.qrVersion) || (raw.qrVersion as number) < 1))
  )
    return fail("DINING_TABLE_INPUT_INVALID");
  return Object.freeze({
    tableReference: parseDiningReference(raw.tableReference),
    tenantReference: parseDiningReference(raw.tenantReference),
    brandReference: parseDiningReference(raw.brandReference),
    storeReference: parseDiningReference(raw.storeReference),
    stableLabel: raw.stableLabel,
    areaReference: parseDiningReference(raw.areaReference),
    areaCode: parseDiningTableCode(raw.areaCode),
    capacity: positive(raw.capacity, 1000),
    accessibilityAttributes: Object.freeze(attributes),
    lifecycle: raw.lifecycle,
    qrStatus: raw.qrStatus as DiningTableQrStatus,
    qrVersion: raw.qrVersion as number,
    operationalState: raw.operationalState as DiningTableOperationalState,
    blockReasonCode: blockReason,
    activeDiningSessionReference:
      raw.activeDiningSessionReference === null
        ? null
        : parseDiningReference(raw.activeDiningSessionReference),
    aggregateVersion: positive(raw.aggregateVersion),
    createdAt: parseDiningInstant(raw.createdAt),
    observedAt: parseDiningInstant(raw.observedAt),
  });
}

export function replaceDiningTableDraft(
  current: DiningTable,
  input: {
    readonly stableLabel: string;
    readonly areaReference: DiningReference;
    readonly areaCode: DiningTableCode;
    readonly capacity: number;
    readonly accessibilityAttributes: readonly DiningTableCode[];
    readonly observedAt: DiningInstant;
  },
) {
  if (current.lifecycle !== "Draft") return fail("DINING_TABLE_TRANSITION_INVALID");
  return createDiningTable({
    ...current,
    ...input,
    aggregateVersion: current.aggregateVersion + 1,
  });
}

export function transitionDiningTable(
  current: DiningTable,
  action: "Publish" | "IssueQr" | "RevokeQr" | "SetBlock" | "ClearBlock",
  observedAt: DiningInstant,
  reasonCode: DiningTableCode | null = null,
) {
  const next: Record<string, unknown> = { ...current, observedAt };
  if (action === "Publish" && current.lifecycle === "Draft") next.lifecycle = "Published";
  else if (action === "IssueQr" && current.lifecycle === "Published") {
    next.qrStatus = "Active";
    next.qrVersion = current.qrVersion + 1;
  } else if (action === "RevokeQr" && current.qrStatus === "Active") {
    next.qrStatus = "Revoked";
    next.qrVersion = current.qrVersion + 1;
  } else if (
    action === "SetBlock" &&
    current.lifecycle === "Published" &&
    current.operationalState === "Available" &&
    reasonCode !== null
  ) {
    next.operationalState = "TemporarilyBlocked";
    next.blockReasonCode = reasonCode;
  } else if (
    action === "ClearBlock" &&
    current.operationalState === "TemporarilyBlocked" &&
    reasonCode === null
  ) {
    next.operationalState = "Available";
    next.blockReasonCode = null;
  } else return fail("DINING_TABLE_TRANSITION_INVALID");
  next.aggregateVersion = current.aggregateVersion + 1;
  return createDiningTable(next);
}

export function moveActiveDiningSession(
  sessionInput: DiningSession,
  sourceInput: DiningTable,
  targetInput: DiningTable,
  partySize: number,
  observedAt: DiningInstant,
) {
  const session = parseDiningSession(sessionInput);
  const source = createDiningTable(sourceInput);
  const target = createDiningTable(targetInput);
  if (
    session.phase !== "Active" ||
    session.brandReference !== source.brandReference ||
    session.brandReference !== target.brandReference ||
    source.tenantReference !== target.tenantReference ||
    source.brandReference !== target.brandReference ||
    session.storeReference !== source.storeReference ||
    session.storeReference !== target.storeReference ||
    session.tableReference !== source.tableReference ||
    source.activeDiningSessionReference !== session.diningSessionReference ||
    target.activeDiningSessionReference !== null ||
    target.lifecycle !== "Published" ||
    target.operationalState !== "Available"
  )
    return fail("DINING_TABLE_SESSION_CONFLICT");
  const size = positive(partySize, 1000);
  if (target.capacity < size) return fail("DINING_TABLE_CAPACITY_CONFLICT");
  return Object.freeze({
    session: parseDiningSession({
      ...session,
      tableReference: target.tableReference,
      tableAssignmentVersion: target.aggregateVersion + 1,
      version: session.version + 1,
    }),
    sourceTable: createDiningTable({
      ...source,
      activeDiningSessionReference: null,
      aggregateVersion: source.aggregateVersion + 1,
      observedAt,
    }),
    targetTable: createDiningTable({
      ...target,
      activeDiningSessionReference: session.diningSessionReference,
      aggregateVersion: target.aggregateVersion + 1,
      observedAt,
    }),
  });
}

/** Staff start retains the supplied assignment fact while advancing the occupied Table aggregate. */
export function assignStartedDiningSession(
  sessionInput: DiningSession,
  tableInput: DiningTable,
  expectedAssignmentVersion: number,
): DiningTable {
  const session = parseDiningSession(sessionInput);
  const table = createDiningTable(tableInput);
  if (
    !Number.isSafeInteger(expectedAssignmentVersion) ||
    expectedAssignmentVersion < 1 ||
    table.aggregateVersion !== expectedAssignmentVersion ||
    session.tableAssignmentVersion !== expectedAssignmentVersion ||
    session.brandReference !== table.brandReference ||
    session.storeReference !== table.storeReference ||
    session.tableReference !== table.tableReference ||
    session.phase !== "Active" ||
    session.version !== 1 ||
    session.hostParticipantReference !== null ||
    table.observedAt < table.createdAt ||
    session.startedAt < table.observedAt ||
    table.activeDiningSessionReference !== null ||
    table.lifecycle !== "Published" ||
    table.operationalState !== "Available"
  )
    return fail("DINING_TABLE_SESSION_CONFLICT");
  return createDiningTable({
    ...table,
    activeDiningSessionReference: session.diningSessionReference,
    aggregateVersion: table.aggregateVersion + 1,
    observedAt: session.startedAt,
  });
}
