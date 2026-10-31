import {
  parseCanonicalInstant,
  parsePublicCapabilityScopeReference,
  PublicCapabilityError,
  readClosedCapabilityRecord,
  type CanonicalInstant,
  type PublicCapabilityScopeReference,
} from "./public-capability-policy.js";
import {
  parseDiningJoinCapability,
  type DiningJoinCapability,
} from "./dining-join-capability-policy.js";

/** Dining-owned facts, not authority. Callers must verify committed history and current scope. */
export interface DiningJoinMoveAssignment {
  readonly moveOperationReference: PublicCapabilityScopeReference;
  readonly storeReference: PublicCapabilityScopeReference;
  readonly diningSessionReference: PublicCapabilityScopeReference;
  readonly tableReference: PublicCapabilityScopeReference;
  readonly assignmentVersion: number;
  readonly sessionVersion: number;
  readonly movedAt: CanonicalInstant;
}

function integer(value: unknown, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new PublicCapabilityError("PUBLIC_CAPABILITY_INPUT_INVALID");
  return value as number;
}

export function parseDiningJoinMoveAssignment(value: unknown): DiningJoinMoveAssignment {
  const raw = readClosedCapabilityRecord(value, [
    "moveOperationReference",
    "storeReference",
    "diningSessionReference",
    "tableReference",
    "assignmentVersion",
    "sessionVersion",
    "movedAt",
  ]);
  return Object.freeze({
    moveOperationReference: parsePublicCapabilityScopeReference(raw.moveOperationReference),
    storeReference: parsePublicCapabilityScopeReference(raw.storeReference),
    diningSessionReference: parsePublicCapabilityScopeReference(raw.diningSessionReference),
    tableReference: parsePublicCapabilityScopeReference(raw.tableReference),
    assignmentVersion: integer(raw.assignmentVersion, 2),
    sessionVersion: integer(raw.sessionVersion, 2),
    movedAt: parseCanonicalInstant(raw.movedAt),
  });
}

/** Pure transition only; Dining must serialize current Staff/Session/Move facts with persistence. */
export function reissueDiningJoinCapabilityAfterMove(value: unknown): Readonly<{
  previous: DiningJoinCapability;
  current: DiningJoinCapability;
}> {
  const raw = readClosedCapabilityRecord(value, [
    "previous",
    "replacement",
    "assignment",
    "currentPepperVersion",
    "observedAt",
  ]);
  const previous = parseDiningJoinCapability(raw.previous);
  const replacement = parseDiningJoinCapability(raw.replacement);
  const assignment = parseDiningJoinMoveAssignment(raw.assignment);
  const pepperVersion = integer(raw.currentPepperVersion);
  const observedAt = parseCanonicalInstant(raw.observedAt);
  if (
    previous.status === "Revoked" ||
    (previous.status === "Consumed" &&
      (previous.consumedAt === null || previous.consumedAt > observedAt)) ||
    (previous.status === "Expired" && previous.expiresAt > observedAt) ||
    previous.issuedAt > observedAt ||
    assignment.movedAt > observedAt ||
    assignment.storeReference !== previous.storeReference ||
    assignment.diningSessionReference !== previous.diningSessionReference ||
    (assignment.tableReference === previous.tableReference &&
      assignment.assignmentVersion === previous.assignmentVersion) ||
    replacement.storeReference !== assignment.storeReference ||
    replacement.diningSessionReference !== assignment.diningSessionReference ||
    replacement.tableReference !== assignment.tableReference ||
    replacement.assignmentVersion !== assignment.assignmentVersion ||
    replacement.kind !== previous.kind ||
    replacement.status !== "Active" ||
    replacement.version !== 1 ||
    replacement.pepperVersion !== pepperVersion ||
    replacement.issuedAt !== observedAt ||
    replacement.generation !== previous.generation + 1 ||
    replacement.capabilityReference === previous.capabilityReference ||
    replacement.selectorHash === previous.selectorHash
  )
    throw new PublicCapabilityError("PUBLIC_CAPABILITY_STATE_INVALID");
  return Object.freeze({
    previous:
      previous.status === "Active"
        ? parseDiningJoinCapability({
            ...previous,
            status: "Revoked",
            version: previous.version + 1,
            revokedAt: observedAt,
          })
        : previous,
    current: replacement,
  });
}
