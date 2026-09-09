import { parseDiningJoinCapability, type DiningJoinCapability } from "@bop/public-capability";
import {
  parseDiningSession,
  parseDiningParticipant,
  parseDiningIdentityAdmission,
  parseDiningReference,
  parseDiningHash,
  type DiningSession,
} from "../contracts/dining-session.js";
import type { DiningJoinRecord } from "./ports/dining-session-ports.js";
import { captureSessionData, sessionDependency } from "./dining-session-snapshot.js";

/** Validates an original committed Join, never inferring current identity from its locators. */
export function parseDiningJoinRecord(
  value: unknown,
  expected: {
    readonly operationReference: string;
    readonly session: DiningSession;
    readonly consumedCapability: DiningJoinCapability;
    readonly maximumSessionVersion: number;
    readonly exactConsumedAt: boolean;
    readonly observedAt: string;
  },
): DiningJoinRecord {
  try {
    const captured = captureSessionData(value);
    const keys = [
      "session",
      "participant",
      "admission",
      "capability",
      "operationReference",
      "operationIntentHash",
    ];
    if (
      captured === null ||
      typeof captured !== "object" ||
      Array.isArray(captured) ||
      Object.keys(captured).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(captured, key))
    )
      return sessionDependency();
    const raw = captured as Record<string, unknown>;
    const session = parseDiningSession(raw.session);
    const participant = parseDiningParticipant(raw.participant);
    const admission = parseDiningIdentityAdmission(raw.admission);
    const capability = parseDiningJoinCapability(raw.capability);
    const operationReference = parseDiningReference(raw.operationReference);
    const operationIntentHash = parseDiningHash(raw.operationIntentHash);
    const current = expected.session;
    const expectedCapability = expected.consumedCapability;
    if (
      operationReference !== expected.operationReference ||
      session.diningSessionReference !== current.diningSessionReference ||
      session.brandReference !== current.brandReference ||
      session.storeReference !== current.storeReference ||
      session.tableReference !== current.tableReference ||
      session.tableAssignmentVersion !== current.tableAssignmentVersion ||
      session.startedByActorReference !== current.startedByActorReference ||
      session.startedAt !== current.startedAt ||
      session.phase !== "Active" ||
      session.version < 2 ||
      (session.version === 2 &&
        session.hostParticipantReference !== participant.participantReference) ||
      session.version > expected.maximumSessionVersion ||
      session.hostParticipantReference !==
        (current.hostParticipantReference ?? participant.participantReference) ||
      participant.diningSessionReference !== session.diningSessionReference ||
      participant.status !== "Active" ||
      participant.version !== 1 ||
      participant.joinedAt < session.startedAt ||
      participant.joinedAt > expected.observedAt ||
      admission.diningSessionReference !== session.diningSessionReference ||
      admission.participantReference !== participant.participantReference ||
      admission.storeReference !== session.storeReference ||
      admission.tableReference !== session.tableReference ||
      admission.tableAssignmentVersion !== session.tableAssignmentVersion ||
      admission.operationReference !== operationReference ||
      admission.operationIntentHash !== operationIntentHash ||
      admission.status !== "Active" ||
      admission.version !== 1 ||
      admission.issuedAt !== participant.joinedAt ||
      capability.status !== "Consumed" ||
      capability.version < 2 ||
      capability.consumedAt === null ||
      String(capability.consumedAt) !== participant.joinedAt ||
      (expected.exactConsumedAt && capability.consumedAt !== expectedCapability.consumedAt) ||
      JSON.stringify({ ...capability, consumedAt: null }) !==
        JSON.stringify({ ...expectedCapability, consumedAt: null })
    )
      return sessionDependency();
    return Object.freeze({
      session,
      participant,
      admission,
      capability,
      operationReference,
      operationIntentHash,
    });
  } catch {
    return sessionDependency();
  }
}
