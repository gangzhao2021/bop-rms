import {
  DiningSessionError,
  parseDiningIdentityAdmission,
  parseDiningInstant,
  parseDiningParticipant,
  parseDiningSession,
  parseDiningTableStartEvidence,
  type DiningIdentityAdmission,
} from "./dining-session.js";

function invalid(): never {
  throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
}
function data(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const entries = Reflect.ownKeys(value).map((key) => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !field?.enumerable || !("value" in field)) return invalid();
    return [key, field.value] as const;
  });
  return Object.fromEntries(entries);
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}

/** Pure owner transition. Callers must authorize the exact Guest and atomically revalidate facts. */
export function consumeDiningIdentityAdmission(value: unknown): DiningIdentityAdmission {
  let admission;
  let session;
  let participant;
  let table;
  let expectedAdmissionVersion;
  let expectedSessionVersion;
  let observedAt;
  try {
    const raw = data(value);
    const keys = [
      "admission",
      "session",
      "participant",
      "table",
      "expectedAdmissionVersion",
      "expectedSessionVersion",
      "observedAt",
    ];
    if (Object.keys(raw).length !== keys.length || keys.some((key) => !Object.hasOwn(raw, key)))
      return invalid();
    admission = parseDiningIdentityAdmission(data(raw.admission));
    session = parseDiningSession(data(raw.session));
    participant = parseDiningParticipant(data(raw.participant));
    table = parseDiningTableStartEvidence(data(raw.table));
    expectedAdmissionVersion = version(raw.expectedAdmissionVersion);
    expectedSessionVersion = version(raw.expectedSessionVersion);
    observedAt = parseDiningInstant(raw.observedAt);
  } catch {
    return invalid();
  }
  if (admission.version !== expectedAdmissionVersion || session.version !== expectedSessionVersion)
    throw new DiningSessionError("DINING_SESSION_VERSION_CONFLICT");
  if (
    admission.status !== "Active" ||
    admission.version !== 1 ||
    session.phase !== "Active" ||
    session.version < 2 ||
    session.hostParticipantReference === null ||
    participant.status !== "Active" ||
    participant.version !== 1 ||
    admission.diningSessionReference !== session.diningSessionReference ||
    participant.diningSessionReference !== session.diningSessionReference ||
    admission.participantReference !== participant.participantReference ||
    admission.storeReference !== session.storeReference ||
    admission.tableReference !== session.tableReference ||
    admission.tableAssignmentVersion !== session.tableAssignmentVersion ||
    table.brandReference !== session.brandReference ||
    table.storeReference !== session.storeReference ||
    table.tableReference !== session.tableReference ||
    table.assignmentVersion !== session.tableAssignmentVersion ||
    table.tableState !== "Eligible" ||
    table.activeDiningSessionReference !== session.diningSessionReference ||
    table.observedAt !== observedAt ||
    admission.issuedAt !== participant.joinedAt ||
    admission.issuedAt < session.startedAt ||
    admission.issuedAt > observedAt
  )
    throw new DiningSessionError("DINING_SESSION_UNAVAILABLE");
  return parseDiningIdentityAdmission({
    ...admission,
    status: "Consumed",
    version: 2,
    consumedAt: observedAt,
  });
}
