import { captureSessionData, sessionDependency } from "./dining-session-snapshot.js";
import { parseDiningJoinCapability } from "@bop/public-capability";
import {
  parseDiningHash,
  parseDiningReference,
  parseDiningSession,
} from "../contracts/dining-session.js";
import type { DiningRegenerationRecord, DiningStartRecord } from "./ports/dining-session-ports.js";

function record(value: unknown, keys: readonly string[]) {
  const captured = captureSessionData(value);
  if (
    captured === null ||
    typeof captured !== "object" ||
    Array.isArray(captured) ||
    Object.keys(captured).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(captured, key))
  )
    return sessionDependency();
  return captured as Record<string, unknown>;
}

export interface StaffRecordScope {
  readonly operationReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly tableReference: string;
  readonly assignmentVersion: number;
  readonly observedAt: string;
}

export function parseStaffStartRecord(
  value: unknown,
  scope: StaffRecordScope & {
    readonly actorReference: string;
  },
): DiningStartRecord {
  try {
    const raw = record(value, [
      "session",
      "capability",
      "operationReference",
      "operationIntentHash",
    ]);
    const session = parseDiningSession(raw.session);
    const capability = parseDiningJoinCapability(raw.capability);
    const operationReference = parseDiningReference(raw.operationReference);
    const operationIntentHash = parseDiningHash(raw.operationIntentHash);
    if (
      operationReference !== scope.operationReference ||
      session.brandReference !== scope.brandReference ||
      session.storeReference !== scope.storeReference ||
      session.tableReference !== scope.tableReference ||
      session.tableAssignmentVersion !== scope.assignmentVersion ||
      session.startedByActorReference !== scope.actorReference ||
      session.phase !== "Active" ||
      session.version !== 1 ||
      session.hostParticipantReference !== null ||
      session.startedAt > scope.observedAt ||
      capability.storeReference !== scope.storeReference ||
      capability.tableReference !== scope.tableReference ||
      capability.assignmentVersion !== scope.assignmentVersion ||
      String(capability.diningSessionReference) !== session.diningSessionReference ||
      capability.status !== "Active" ||
      capability.version !== 1 ||
      capability.generation !== 1 ||
      String(capability.issuedAt) !== session.startedAt
    )
      return sessionDependency();
    return Object.freeze({ session, capability, operationReference, operationIntentHash });
  } catch {
    return sessionDependency();
  }
}

export function parseStaffRegenerationRecord(
  value: unknown,
  scope: StaffRecordScope & { readonly diningSessionReference: string },
): DiningRegenerationRecord {
  try {
    const raw = record(value, ["capability", "operationReference", "operationIntentHash"]);
    const capability = parseDiningJoinCapability(raw.capability);
    const operationReference = parseDiningReference(raw.operationReference);
    const operationIntentHash = parseDiningHash(raw.operationIntentHash);
    if (
      operationReference !== scope.operationReference ||
      capability.storeReference !== scope.storeReference ||
      capability.tableReference !== scope.tableReference ||
      capability.assignmentVersion !== scope.assignmentVersion ||
      capability.diningSessionReference !== scope.diningSessionReference ||
      capability.status !== "Active" ||
      capability.version !== 1 ||
      capability.generation < 2 ||
      capability.issuedAt > scope.observedAt
    )
      return sessionDependency();
    return Object.freeze({ capability, operationReference, operationIntentHash });
  } catch {
    return sessionDependency();
  }
}
