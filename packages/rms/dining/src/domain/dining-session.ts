export const diningSessionErrorCodes = [
  "DINING_SESSION_INPUT_INVALID",
  "DINING_SESSION_UNAVAILABLE",
  "DINING_SESSION_PERMISSION_DENIED",
  "DINING_SESSION_VERSION_CONFLICT",
  "DINING_SESSION_IDEMPOTENCY_CONFLICT",
  "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
] as const;
export type DiningSessionErrorCode = (typeof diningSessionErrorCodes)[number];

export class DiningSessionError extends Error {
  readonly code: DiningSessionErrorCode;

  constructor(code: DiningSessionErrorCode) {
    super(
      code === "DINING_SESSION_INPUT_INVALID"
        ? "dining session input is invalid"
        : "dining session is unavailable",
    );
    this.name = "DiningSessionError";
    this.code = code;
  }
}

export type DiningReference = string & { readonly __diningReference: unique symbol };
export type DiningHash = string & { readonly __diningHash: unique symbol };
export type DiningInstant = string & { readonly __diningInstant: unique symbol };
export type DiningSessionPhase = "Active" | "Closing" | "Closed" | "Cancelled";
export type DiningParticipantStatus = "Active" | "Left";
export type DiningIdentityAdmissionStatus = "Active" | "Consumed";

export interface DiningSession {
  readonly diningSessionReference: DiningReference;
  readonly brandReference: DiningReference;
  readonly storeReference: DiningReference;
  readonly tableReference: DiningReference;
  readonly tableAssignmentVersion: number;
  readonly phase: DiningSessionPhase;
  readonly version: number;
  readonly startedByActorReference: DiningReference;
  readonly startedAt: DiningInstant;
  readonly hostParticipantReference: DiningReference | null;
}

export interface DiningParticipant {
  readonly participantReference: DiningReference;
  readonly diningSessionReference: DiningReference;
  readonly status: DiningParticipantStatus;
  readonly version: number;
  readonly joinedAt: DiningInstant;
  readonly leftAt: DiningInstant | null;
}

export interface DiningIdentityAdmission {
  readonly admissionReference: DiningReference;
  readonly diningSessionReference: DiningReference;
  readonly participantReference: DiningReference;
  readonly storeReference: DiningReference;
  readonly tableReference: DiningReference;
  readonly tableAssignmentVersion: number;
  readonly operationReference: DiningReference;
  readonly operationIntentHash: DiningHash;
  readonly status: DiningIdentityAdmissionStatus;
  readonly version: number;
  readonly issuedAt: DiningInstant;
  readonly consumedAt: DiningInstant | null;
}

export interface DiningTableStartEvidence {
  readonly brandReference: DiningReference;
  readonly storeReference: DiningReference;
  readonly tableReference: DiningReference;
  readonly assignmentVersion: number;
  readonly tableState: "Eligible" | "Unavailable";
  readonly activeDiningSessionReference: DiningReference | null;
  readonly observedAt: DiningInstant;
}

export interface DiningGuestContextEvidence {
  readonly guestSessionReference: DiningReference;
  readonly diningState: "ContextOnly" | "DiningBound";
  readonly channel: "DineIn" | "Pickup";
  readonly storeReference: DiningReference;
  readonly tableReference: DiningReference | null;
  readonly observedAt: DiningInstant;
}

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hashPattern = /^[0-9a-f]{64}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function invalid(): never {
  throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
}

function closed(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return invalid();
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    ) {
      return invalid();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return invalid();
      }
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof DiningSessionError) throw error;
    return invalid();
  }
}

export function parseDiningReference(value: unknown): DiningReference {
  if (typeof value !== "string" || !uuidV7Pattern.test(value)) return invalid();
  return value as DiningReference;
}

export function parseDiningHash(value: unknown): DiningHash {
  if (typeof value !== "string" || !hashPattern.test(value)) return invalid();
  return value as DiningHash;
}

export function parseDiningInstant(value: unknown): DiningInstant {
  if (typeof value !== "string" || !instantPattern.test(value)) return invalid();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return invalid();
  }
  return value as DiningInstant;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}

export function parseDiningSession(value: unknown): DiningSession {
  const raw = closed(value, [
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
  ]);
  if (
    raw.phase !== "Active" &&
    raw.phase !== "Closing" &&
    raw.phase !== "Closed" &&
    raw.phase !== "Cancelled"
  ) {
    return invalid();
  }
  return Object.freeze({
    diningSessionReference: parseDiningReference(raw.diningSessionReference),
    brandReference: parseDiningReference(raw.brandReference),
    storeReference: parseDiningReference(raw.storeReference),
    tableReference: parseDiningReference(raw.tableReference),
    tableAssignmentVersion: positiveInteger(raw.tableAssignmentVersion),
    phase: raw.phase,
    version: positiveInteger(raw.version),
    startedByActorReference: parseDiningReference(raw.startedByActorReference),
    startedAt: parseDiningInstant(raw.startedAt),
    hostParticipantReference:
      raw.hostParticipantReference === null
        ? null
        : parseDiningReference(raw.hostParticipantReference),
  });
}

export function parseDiningParticipant(value: unknown): DiningParticipant {
  const raw = closed(value, [
    "participantReference",
    "diningSessionReference",
    "status",
    "version",
    "joinedAt",
    "leftAt",
  ]);
  if (raw.status !== "Active" && raw.status !== "Left") return invalid();
  const joinedAt = parseDiningInstant(raw.joinedAt);
  const leftAt = raw.leftAt === null ? null : parseDiningInstant(raw.leftAt);
  if (
    (raw.status === "Active" && leftAt !== null) ||
    (raw.status === "Left" && (leftAt === null || Date.parse(leftAt) < Date.parse(joinedAt)))
  ) {
    return invalid();
  }
  return Object.freeze({
    participantReference: parseDiningReference(raw.participantReference),
    diningSessionReference: parseDiningReference(raw.diningSessionReference),
    status: raw.status,
    version: positiveInteger(raw.version),
    joinedAt,
    leftAt,
  });
}

export function parseDiningIdentityAdmission(value: unknown): DiningIdentityAdmission {
  const raw = closed(value, [
    "admissionReference",
    "diningSessionReference",
    "participantReference",
    "storeReference",
    "tableReference",
    "tableAssignmentVersion",
    "operationReference",
    "operationIntentHash",
    "status",
    "version",
    "issuedAt",
    "consumedAt",
  ]);
  if (raw.status !== "Active" && raw.status !== "Consumed") return invalid();
  const issuedAt = parseDiningInstant(raw.issuedAt);
  const consumedAt = raw.consumedAt === null ? null : parseDiningInstant(raw.consumedAt);
  if (
    (raw.status === "Active" && consumedAt !== null) ||
    (raw.status === "Consumed" &&
      (consumedAt === null || Date.parse(consumedAt) < Date.parse(issuedAt)))
  ) {
    return invalid();
  }
  return Object.freeze({
    admissionReference: parseDiningReference(raw.admissionReference),
    diningSessionReference: parseDiningReference(raw.diningSessionReference),
    participantReference: parseDiningReference(raw.participantReference),
    storeReference: parseDiningReference(raw.storeReference),
    tableReference: parseDiningReference(raw.tableReference),
    tableAssignmentVersion: positiveInteger(raw.tableAssignmentVersion),
    operationReference: parseDiningReference(raw.operationReference),
    operationIntentHash: parseDiningHash(raw.operationIntentHash),
    status: raw.status,
    version: positiveInteger(raw.version),
    issuedAt,
    consumedAt,
  });
}

export function parseDiningTableStartEvidence(value: unknown): DiningTableStartEvidence {
  const raw = closed(value, [
    "brandReference",
    "storeReference",
    "tableReference",
    "assignmentVersion",
    "tableState",
    "activeDiningSessionReference",
    "observedAt",
  ]);
  if (raw.tableState !== "Eligible" && raw.tableState !== "Unavailable") return invalid();
  return Object.freeze({
    brandReference: parseDiningReference(raw.brandReference),
    storeReference: parseDiningReference(raw.storeReference),
    tableReference: parseDiningReference(raw.tableReference),
    assignmentVersion: positiveInteger(raw.assignmentVersion),
    tableState: raw.tableState,
    activeDiningSessionReference:
      raw.activeDiningSessionReference === null
        ? null
        : parseDiningReference(raw.activeDiningSessionReference),
    observedAt: parseDiningInstant(raw.observedAt),
  });
}

export function parseDiningGuestContextEvidence(value: unknown): DiningGuestContextEvidence {
  const raw = closed(value, [
    "guestSessionReference",
    "diningState",
    "channel",
    "storeReference",
    "tableReference",
    "observedAt",
  ]);
  if (
    (raw.diningState !== "ContextOnly" && raw.diningState !== "DiningBound") ||
    (raw.channel !== "DineIn" && raw.channel !== "Pickup")
  ) {
    return invalid();
  }
  const tableReference =
    raw.tableReference === null ? null : parseDiningReference(raw.tableReference);
  if ((raw.channel === "DineIn") !== (tableReference !== null)) return invalid();
  return Object.freeze({
    guestSessionReference: parseDiningReference(raw.guestSessionReference),
    diningState: raw.diningState,
    channel: raw.channel,
    storeReference: parseDiningReference(raw.storeReference),
    tableReference,
    observedAt: parseDiningInstant(raw.observedAt),
  });
}
