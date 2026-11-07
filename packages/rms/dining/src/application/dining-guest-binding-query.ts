import {
  DiningSessionError,
  parseDiningInstant,
  parseDiningParticipant,
  parseDiningReference,
  parseDiningSession,
  parseDiningTableStartEvidence,
  parseDiningIdentityAdmission,
  type DiningIdentityAdmission,
  type DiningInstant,
  type DiningParticipant,
  type DiningReference,
  type DiningSession,
  type DiningTableStartEvidence,
} from "../domain/dining-session.js";

import { captureSessionData } from "./dining-session-snapshot.js";

export interface DiningGuestBindingReadSnapshot {
  readonly admission: DiningIdentityAdmission;
  readonly session: DiningSession;
  readonly participant: DiningParticipant;
  readonly table: DiningTableStartEvidence;
  /**
   * WP-2423 (table-move-payment): Dining's first recorded Move of this session off the table the
   * phone joined at, after it joined; null when the party was not moved since. Optional for owner
   * snapshots read before it existed (they cannot follow a move).
   */
  readonly followedMove?: {
    readonly fromTableReference: DiningReference;
    readonly movedAt: DiningInstant;
  } | null;
}
export interface DiningGuestBindingEvidence {
  readonly schemaVersion: 1;
  readonly phase: "Active" | "Closing";
  readonly brandReference: DiningReference;
  readonly storeReference: DiningReference;
  readonly diningSessionReference: DiningReference;
  readonly participantReference: DiningReference;
  readonly tableReference: DiningReference;
  readonly tableAssignmentVersion: number;
  readonly diningSessionVersion: number;
  readonly participantVersion: number;
  readonly observedAt: DiningInstant;
}
/**
 * WP-2423 (same-table-ordering): what Dining has recorded about a participant leaving its table.
 * `Left`: the participant left or staff removed it. `Moved`: staff moved the party off the table
 * this phone joined at before the phone joined, so the phone does not follow it. `Present`: Dining
 * records neither. `joinedTableQr` is the current QR of the table the phone joined at (its version
 * and whether it is turned on), so a caller can tell a replaced or turned-off code from an outage.
 */
export interface DiningParticipantDeparture {
  readonly participantReference: DiningReference;
  readonly departure: "Left" | "Moved" | "Present";
  readonly joinedTableQr: { readonly version: number; readonly active: boolean };
}
export interface DiningParticipantDepartureSource {
  /** Recorded facts only; a participant Dining has no row for is left out. Failures throw. */
  readDepartures(input: {
    readonly brandReference: DiningReference;
    readonly storeReference: DiningReference;
    readonly diningSessionReference: DiningReference;
    readonly participantReferences: readonly DiningReference[];
  }): Promise<readonly DiningParticipantDeparture[]>;
}
export interface DiningGuestBindingOptions {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly repository: Partial<DiningParticipantDepartureSource> & {
    /** One coherent current owner snapshot; no cache or authority inferred from the locators. */
    readCurrent(input: {
      readonly brandReference: DiningReference;
      readonly storeReference: DiningReference;
      readonly diningSessionReference: DiningReference;
      readonly participantReference: DiningReference;
      readonly observedAt: DiningInstant;
    }): Promise<DiningGuestBindingReadSnapshot | null>;
  };
  readonly now: () => string;
}
function invalid(): never {
  throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
}
function unavailable(): never {
  throw new DiningSessionError("DINING_SESSION_DEPENDENCY_UNAVAILABLE");
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const fields = Reflect.ownKeys(value);
  if (
    fields.length !== keys.length ||
    fields.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
    result[key] = descriptor.value;
  }
  return result;
}

type BindingPurpose =
  "GuestSessionBinding" | "DiningHostSubmission" | "DiningParticipantSubmission";

/** Current binding facts only. Identity must authenticate its exact Session; this grants no Cart write authority. */
function createBindingQuery(options: DiningGuestBindingOptions, purpose: BindingPurpose) {
  const submission = purpose !== "GuestSessionBinding";
  const scope = closed(options.scope, ["brandReference", "storeReference"]);
  const brandReference = parseDiningReference(scope.brandReference);
  const storeReference = parseDiningReference(scope.storeReference);
  return Object.freeze({
    async resolve(value: unknown): Promise<DiningGuestBindingEvidence | null> {
      let diningSessionReference: DiningReference;
      let participantReference: DiningReference;
      let tableReference: DiningReference;
      try {
        const raw = closed(value, [
          "purpose",
          "diningSessionReference",
          "participantReference",
          "tableReference",
        ]);
        if (raw.purpose !== purpose) return invalid();
        diningSessionReference = parseDiningReference(raw.diningSessionReference);
        participantReference = parseDiningReference(raw.participantReference);
        tableReference = parseDiningReference(raw.tableReference);
      } catch {
        return invalid();
      }
      try {
        const requestedAt = parseDiningInstant(options.now());
        const source = await options.repository.readCurrent(
          Object.freeze({
            brandReference,
            storeReference,
            diningSessionReference,
            participantReference,
            observedAt: requestedAt,
          }),
        );
        // Own dependency data before calling the clock again, which may be an injected callback.
        const copied = source === null ? null : captureSessionData(source);
        const raw =
          copied === null
            ? null
            : closed(
                copied,
                copied !== null &&
                  typeof copied === "object" &&
                  Object.hasOwn(copied, "followedMove")
                  ? ["session", "participant", "table", "admission", "followedMove"]
                  : ["session", "participant", "table", "admission"],
              );
        const move =
          raw === null || raw.followedMove === undefined || raw.followedMove === null
            ? null
            : closed(raw.followedMove, ["fromTableReference", "movedAt"]);
        const snapshot =
          raw === null
            ? null
            : {
                admission: parseDiningIdentityAdmission(raw.admission),
                session: parseDiningSession(raw.session),
                participant: parseDiningParticipant(raw.participant),
                table: parseDiningTableStartEvidence(raw.table),
                followedMove:
                  move === null
                    ? null
                    : {
                        fromTableReference: parseDiningReference(move.fromTableReference),
                        movedAt: parseDiningInstant(move.movedAt),
                      },
              };
        const checkedAt = parseDiningInstant(options.now());
        if (checkedAt < requestedAt) return unavailable();
        if (snapshot === null) return null;
        const { session, participant, table, admission, followedMove } = snapshot;
        if (table.observedAt < requestedAt || table.observedAt > checkedAt) return unavailable();
        // WP-2423 (table-move-payment): a phone that joined before staff moved its party follows the
        // party. The caller names the table the phone joined at (its code) or the table the party
        // sits at now; either way the admission's table must be the one the recorded Move left.
        const notMoved =
          session.tableReference === tableReference &&
          admission.tableReference === tableReference &&
          admission.tableAssignmentVersion === session.tableAssignmentVersion;
        const followed =
          followedMove !== null &&
          (tableReference === admission.tableReference ||
            tableReference === session.tableReference) &&
          (session.tableReference !== admission.tableReference ||
            session.tableAssignmentVersion !== admission.tableAssignmentVersion) &&
          followedMove.fromTableReference === admission.tableReference &&
          admission.consumedAt !== null &&
          followedMove.movedAt >= admission.consumedAt &&
          followedMove.movedAt <= table.observedAt;
        if (
          session.brandReference !== brandReference ||
          session.storeReference !== storeReference ||
          session.diningSessionReference !== diningSessionReference ||
          participant.participantReference !== participantReference ||
          participant.diningSessionReference !== diningSessionReference ||
          table.brandReference !== brandReference ||
          table.storeReference !== storeReference ||
          table.tableReference !== session.tableReference ||
          table.assignmentVersion !== session.tableAssignmentVersion ||
          table.activeDiningSessionReference !== diningSessionReference ||
          (session.phase !== "Active" && session.phase !== "Closing") ||
          session.version < 2 ||
          !(notMoved || followed) ||
          admission.status !== "Consumed" ||
          admission.version !== 2 ||
          admission.consumedAt === null ||
          admission.consumedAt > table.observedAt ||
          admission.diningSessionReference !== diningSessionReference ||
          admission.participantReference !== participantReference ||
          admission.storeReference !== storeReference ||
          admission.issuedAt !== participant.joinedAt ||
          admission.consumedAt < admission.issuedAt ||
          (submission && session.phase !== "Active") ||
          (purpose === "DiningHostSubmission" &&
            session.hostParticipantReference !== participantReference) ||
          participant.status !== "Active" ||
          table.tableState !== "Eligible" ||
          session.startedAt > table.observedAt ||
          participant.joinedAt < session.startedAt ||
          participant.joinedAt > table.observedAt
        )
          return null;
        return Object.freeze({
          schemaVersion: 1,
          phase: session.phase,
          brandReference,
          storeReference,
          diningSessionReference,
          participantReference,
          tableReference: session.tableReference,
          tableAssignmentVersion: table.assignmentVersion,
          diningSessionVersion: session.version,
          participantVersion: participant.version,
          observedAt: table.observedAt,
        });
      } catch {
        return unavailable();
      }
    },
  });
}

/** Current guest binding facts; deliberately permits Closing for history access. */
export function createDiningGuestBindingQuery(options: DiningGuestBindingOptions) {
  return createBindingQuery(options, "GuestSessionBinding");
}

/** Current Active-session Host facts for a new Batch. Identity must independently
 * authenticate the exact participant; final write must retain owner row fences.
 * This query does not prove current Order, Cart, Inventory or Payment eligibility.
 */
export function createDiningHostSubmissionQuery(options: DiningGuestBindingOptions) {
  return createBindingQuery(options, "DiningHostSubmission");
}

/** DEC-DINING-ANY-PARTICIPANT-SUBMIT: current Active-session facts for any active (not left)
 * participant submitting the table's Cart as a new Batch; the submitter owns its payment. Same
 * Identity/fence obligations as the Host query; one checkout at a time stays with the Cart version
 * and the Dining checkout commitment fences, not with the Host role.
 */
export function createDiningParticipantSubmissionQuery(options: DiningGuestBindingOptions) {
  return createBindingQuery(options, "DiningParticipantSubmission");
}
