import { parseDiningJoinCapability, parseDiningJoinMoveAssignment } from "@bop/public-capability";
import { parseDiningSession } from "../contracts/dining-session.js";
import { parseDiningSessionMoveRecord } from "./dining-move-record.js";
import { captureSessionData, sessionDependency } from "./dining-session-snapshot.js";
import type { DiningMovedJoinState } from "./ports/dining-session-ports.js";
import type { DiningTablePorts, DiningSessionMoveRecord } from "./ports/dining-table-ports.js";

/** Scoped owner facts; current Staff authority and transactional revalidation remain mandatory. */
export function parseMovedJoinState(
  value: unknown,
  references: DiningTablePorts["references"],
  scope: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly diningSessionReference: string;
  },
): DiningMovedJoinState {
  try {
    const captured = captureSessionData(value);
    if (captured === null || typeof captured !== "object" || Array.isArray(captured))
      return sessionDependency();
    const raw = captured as Record<string, unknown>;
    if (
      Object.keys(raw).length !== 3 ||
      !["session", "capability", "move"].every((key) => Object.hasOwn(raw, key))
    )
      return sessionDependency();
    const session = parseDiningSession(raw.session);
    const capability = parseDiningJoinCapability(raw.capability);
    const move = parseDiningSessionMoveRecord(raw.move, references);
    if (
      session.diningSessionReference !== scope.diningSessionReference ||
      session.brandReference !== scope.brandReference ||
      session.storeReference !== scope.storeReference ||
      session.phase !== "Active" ||
      move.session.diningSessionReference !== session.diningSessionReference ||
      move.session.brandReference !== session.brandReference ||
      move.session.storeReference !== session.storeReference ||
      move.session.tableReference !== session.tableReference ||
      move.session.tableAssignmentVersion !== session.tableAssignmentVersion ||
      move.session.startedAt !== session.startedAt ||
      move.session.startedByActorReference !== session.startedByActorReference ||
      move.session.version > session.version ||
      (move.session.version === session.version &&
        JSON.stringify(move.session) !== JSON.stringify(session)) ||
      String(capability.storeReference) !== session.storeReference ||
      String(capability.diningSessionReference) !== session.diningSessionReference ||
      (String(capability.tableReference) === session.tableReference &&
        capability.assignmentVersion === session.tableAssignmentVersion)
    )
      return sessionDependency();
    return Object.freeze({ session, capability, move });
  } catch {
    return sessionDependency();
  }
}

export function movedJoinAssignment(move: DiningSessionMoveRecord) {
  return parseDiningJoinMoveAssignment({
    moveOperationReference: move.operationReference,
    storeReference: move.session.storeReference,
    diningSessionReference: move.session.diningSessionReference,
    tableReference: move.session.tableReference,
    assignmentVersion: move.session.tableAssignmentVersion,
    sessionVersion: move.session.version,
    movedAt: move.command.observedAt,
  });
}
