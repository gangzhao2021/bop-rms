import { parseDiningJoinCapability } from "@bop/public-capability";
import {
  parseDiningHash,
  parseDiningIdentityAdmission,
  parseDiningParticipant,
  parseDiningReference,
  parseDiningSession,
  parseDiningTableStartEvidence,
} from "../domain/dining-session.js";
import { parseDiningJoinRecord } from "./dining-join-record.js";
import { captureSessionData, sessionDependency } from "./dining-session-snapshot.js";
import type {
  DiningAdmissionConsumptionRecord,
  DiningAdmissionSnapshot,
} from "./ports/dining-admission-ports.js";

export function closedAdmissionData(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const copy = captureSessionData(value);
  if (
    copy === null ||
    typeof copy !== "object" ||
    Array.isArray(copy) ||
    Object.keys(copy).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(copy, key))
  )
    return sessionDependency();
  return copy as Record<string, unknown>;
}
export function sameAdmissionData(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function parseDiningAdmissionSnapshot(value: unknown): DiningAdmissionSnapshot {
  try {
    const raw = closedAdmissionData(value, [
      "session",
      "participant",
      "admission",
      "table",
      "join",
      "joinedGuestSessionReference",
    ]);
    const session = parseDiningSession(raw.session);
    const participant = parseDiningParticipant(raw.participant);
    const admission = parseDiningIdentityAdmission(raw.admission);
    const table = parseDiningTableStartEvidence(raw.table);
    const joinedGuestSessionReference = parseDiningReference(raw.joinedGuestSessionReference);
    const original = closedAdmissionData(raw.join, [
      "session",
      "participant",
      "admission",
      "capability",
      "operationReference",
      "operationIntentHash",
    ]);
    const originalSession = parseDiningSession(original.session);
    const capability = parseDiningJoinCapability(original.capability);
    const join = parseDiningJoinRecord(original, {
      operationReference: parseDiningReference(original.operationReference),
      session: originalSession,
      consumedCapability: capability,
      maximumSessionVersion: originalSession.version,
      exactConsumedAt: true,
      observedAt: capability.consumedAt ?? "",
    });
    if (
      String(capability.diningSessionReference) !== originalSession.diningSessionReference ||
      String(capability.storeReference) !== originalSession.storeReference ||
      String(capability.tableReference) !== originalSession.tableReference ||
      capability.assignmentVersion !== originalSession.tableAssignmentVersion ||
      capability.version !== 2 ||
      String(capability.issuedAt) < originalSession.startedAt ||
      session.diningSessionReference !== originalSession.diningSessionReference ||
      session.brandReference !== originalSession.brandReference ||
      session.storeReference !== originalSession.storeReference ||
      session.startedAt !== originalSession.startedAt ||
      session.startedByActorReference !== originalSession.startedByActorReference ||
      session.version < originalSession.version ||
      (session.version === originalSession.version &&
        !sameAdmissionData(session, originalSession)) ||
      !sameAdmissionData(
        { ...participant, status: "Active", version: 1, leftAt: null },
        join.participant,
      ) ||
      !sameAdmissionData(
        { ...admission, status: "Active", version: 1, consumedAt: null },
        join.admission,
      ) ||
      (admission.status === "Active" ? admission.version !== 1 : admission.version !== 2)
    )
      return sessionDependency();
    return Object.freeze({
      session,
      participant,
      admission,
      table,
      join,
      joinedGuestSessionReference,
    });
  } catch {
    return sessionDependency();
  }
}
export function parseDiningAdmissionConsumptionRecord(
  value: unknown,
): DiningAdmissionConsumptionRecord {
  try {
    const raw = closedAdmissionData(value, [
      "operationReference",
      "operationIntentHash",
      "guestSessionReference",
      "admission",
    ]);
    const admission = parseDiningIdentityAdmission(raw.admission);
    if (admission.status !== "Consumed" || admission.version !== 2 || admission.consumedAt === null)
      return sessionDependency();
    return Object.freeze({
      operationReference: parseDiningReference(raw.operationReference),
      operationIntentHash: parseDiningHash(raw.operationIntentHash),
      guestSessionReference: parseDiningReference(raw.guestSessionReference),
      admission,
    });
  } catch {
    return sessionDependency();
  }
}
