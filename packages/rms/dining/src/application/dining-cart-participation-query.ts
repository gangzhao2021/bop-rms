import {
  DiningSessionError,
  parseDiningInstant,
  parseDiningParticipant,
  parseDiningReference,
  parseDiningSession,
  parseDiningTableStartEvidence,
  type DiningInstant,
  type DiningParticipant,
  type DiningReference,
  type DiningSession,
  type DiningTableStartEvidence,
} from "../domain/dining-session.js";

export interface DiningParticipationReadSnapshot {
  readonly session: DiningSession;
  readonly participant: DiningParticipant;
  readonly table: DiningTableStartEvidence;
}
export interface DiningCartParticipation {
  readonly schemaVersion: 1;
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
export interface DiningCartParticipationOptions {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly repository: {
    /** One coherent current owner snapshot; no cache or authority inferred from the locators. */
    readCurrent(input: {
      readonly brandReference: DiningReference;
      readonly storeReference: DiningReference;
      readonly diningSessionReference: DiningReference;
      readonly participantReference: DiningReference;
      readonly observedAt: DiningInstant;
    }): Promise<DiningParticipationReadSnapshot | null>;
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

/** Internal owner facts only. Callers must separately authorize the current Guest and Cart action. */
export function createDiningCartParticipationQuery(options: DiningCartParticipationOptions) {
  const scope = closed(options.scope, ["brandReference", "storeReference"]);
  const brandReference = parseDiningReference(scope.brandReference);
  const storeReference = parseDiningReference(scope.storeReference);
  return Object.freeze({
    async resolve(value: unknown): Promise<DiningCartParticipation | null> {
      let diningSessionReference: DiningReference;
      let participantReference: DiningReference;
      try {
        const raw = closed(value, ["purpose", "diningSessionReference", "participantReference"]);
        if (raw.purpose !== "Cart") return invalid();
        diningSessionReference = parseDiningReference(raw.diningSessionReference);
        participantReference = parseDiningReference(raw.participantReference);
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
        const raw = source === null ? null : closed(source, ["session", "participant", "table"]);
        const snapshot =
          raw === null
            ? null
            : {
                session: parseDiningSession(raw.session),
                participant: parseDiningParticipant(raw.participant),
                table: parseDiningTableStartEvidence(raw.table),
              };
        const checkedAt = parseDiningInstant(options.now());
        if (checkedAt < requestedAt) return unavailable();
        if (snapshot === null) return null;
        const { session, participant, table } = snapshot;
        if (table.observedAt < requestedAt || table.observedAt > checkedAt) return unavailable();
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
          session.phase !== "Active" ||
          participant.status !== "Active" ||
          table.tableState !== "Eligible" ||
          session.startedAt > table.observedAt ||
          participant.joinedAt < session.startedAt ||
          participant.joinedAt > table.observedAt
        )
          return null;
        return Object.freeze({
          schemaVersion: 1,
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
