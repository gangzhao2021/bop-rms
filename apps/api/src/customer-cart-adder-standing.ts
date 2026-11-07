import type { CanonicalInstant, GuestSession } from "@bop/identity";
import { parseCanonicalInstant } from "@bop/identity";
import type { CartAdderStandingPort } from "@rms/ordering";
import type { DiningParticipantDepartureSource } from "@rms/dining";

/**
 * WP-2423 (same-table-ordering): whether the phone that added a table line can still act at this
 * table. Three answers, and only a recorded fact may say a phone has left:
 *
 * - `AtTable`: a live Guest Session bound to that participant passes the very binding check every
 *   cart command runs.
 * - `Gone`: an owner read succeeded and records the departure: Identity has no live session for it
 *   (its session ended), Dining records it Left (staff removed it) or moved its party off the table
 *   it joined at without it, or the code each of its sessions scanned was replaced or turned off.
 * - `Unknown`: neither could be shown. The binding check failing says nothing by itself (its owners
 *   answer "Unavailable" for a timeout or a lock wait too), so the line stays its adder's.
 *
 * A listing failure throws (callers fail closed). A departure read failure answers `Unknown`.
 *
 * `check: "Recorded"` (the polled table cart view) skips the binding check: one Identity listing
 * and one Dining read for any number of phones, so a busy table's polling stays bounded. It never
 * answers `AtTable`; the remove command runs the full check at its own instant.
 */
export function createCustomerCartAdderStanding(options: {
  readonly scope: Readonly<{ brandReference: string; storeReference: string }>;
  readonly sessions: {
    listBound(input: {
      readonly diningSessionReference: string;
      readonly participantReferences: readonly string[];
      readonly observedAt: string;
    }): Promise<readonly GuestSession[]>;
  };
  readonly binding: {
    validate(session: GuestSession, observedAt: CanonicalInstant): Promise<string>;
  };
  /** Dining's recorded departures; without it no phone is ever `Gone` short of its session ending. */
  readonly departures?: DiningParticipantDepartureSource;
}): CartAdderStandingPort {
  const port: CartAdderStandingPort = {
    async standing(input: Parameters<CartAdderStandingPort["standing"]>[0]) {
      const observedAt = parseCanonicalInstant(input.observedAt);
      const participants = [...new Set(input.participantReferences.map(String))];
      if (participants.length === 0) return Object.freeze([]);
      const diningSessionReference = String(input.diningSessionReference);
      const sessions = await options.sessions.listBound(
        Object.freeze({
          diningSessionReference,
          participantReferences: Object.freeze(participants),
          observedAt,
        }),
      );
      const byParticipant = new Map<string, GuestSession[]>();
      for (const session of sessions) {
        const participant = String(session.diningParticipantReference);
        if (!participants.includes(participant)) continue;
        byParticipant.set(participant, [...(byParticipant.get(participant) ?? []), session]);
      }
      const answers = new Map<string, "AtTable" | "Gone" | "Unknown">();
      const undecided: string[] = [];
      const recordedOnly = input.check === "Recorded";
      // Sequential: the binding check may share one caller transaction.
      for (const participant of participants) {
        const own = byParticipant.get(participant) ?? [];
        // Identity read the live sessions and found none: this phone's session ended.
        if (own.length === 0) {
          answers.set(participant, "Gone");
          continue;
        }
        if (recordedOnly) {
          undecided.push(participant);
          continue;
        }
        let current = false;
        for (const session of own) {
          try {
            if ((await options.binding.validate(session, observedAt)) === "Current") {
              current = true;
              break;
            }
          } catch {
            // Could not check this session: decided below by recorded facts only.
          }
        }
        if (current) answers.set(participant, "AtTable");
        else undecided.push(participant);
      }
      if (undecided.length > 0 && options.departures !== undefined) {
        try {
          const facts = await options.departures.readDepartures(
            Object.freeze({
              brandReference: options.scope.brandReference,
              storeReference: options.scope.storeReference,
              diningSessionReference,
              participantReferences: Object.freeze(undecided),
            }) as Parameters<DiningParticipantDepartureSource["readDepartures"]>[0],
          );
          for (const fact of Array.isArray(facts) ? facts : []) {
            const participant = String(fact.participantReference);
            if (!undecided.includes(participant) || answers.has(participant)) continue;
            const own = byParticipant.get(participant) ?? [];
            const codeRetired =
              own.length > 0 &&
              (fact.joinedTableQr.active !== true ||
                own.every(
                  (session) =>
                    Number.isSafeInteger(session.qrRevocationVersion) &&
                    session.qrRevocationVersion < fact.joinedTableQr.version,
                ));
            if (fact.departure === "Left" || fact.departure === "Moved" || codeRetired)
              answers.set(participant, "Gone");
          }
        } catch {
          // Could not read Dining's facts: every undecided phone stays `Unknown`.
        }
      }
      return Object.freeze(
        participants.map((participantReference) =>
          Object.freeze({
            participantReference,
            standing: answers.get(participantReference) ?? "Unknown",
          }),
        ),
      );
    },
  };
  return Object.freeze(port);
}
