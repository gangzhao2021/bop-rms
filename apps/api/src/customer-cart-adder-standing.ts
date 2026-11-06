import type { CanonicalInstant, GuestSession } from "@bop/identity";
import { parseCanonicalInstant } from "@bop/identity";
import type { CartAdderStandingPort } from "@rms/ordering";

/**
 * WP-2423 (same-table-ordering): whether the phone that added a table line can still act at this
 * table, derived from the very binding check every cart command runs (Identity session usable,
 * current table QR and table, Dining participant still Active and at this session). A participant
 * is `AtTable` while any live Guest Session bound to it passes that check, and `Gone` otherwise:
 * removed by staff (Left), table QR replaced, moved without its phone following, or its session
 * ended. If a later move keeps a phone's session valid at the new table, it stays `AtTable` here
 * without any change. A listing failure throws (callers fail closed).
 */
export function createCustomerCartAdderStanding(options: {
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
}): CartAdderStandingPort {
  const port: CartAdderStandingPort = {
    async standing(input: Parameters<CartAdderStandingPort["standing"]>[0]) {
      const observedAt = parseCanonicalInstant(input.observedAt);
      const participants = [...new Set(input.participantReferences.map(String))];
      if (participants.length === 0) return Object.freeze([]);
      const sessions = await options.sessions.listBound(
        Object.freeze({
          diningSessionReference: String(input.diningSessionReference),
          participantReferences: Object.freeze(participants),
          observedAt,
        }),
      );
      const atTable = new Set<string>();
      // Sequential: the binding check may share one caller transaction.
      for (const session of sessions) {
        const participant = String(session.diningParticipantReference);
        if (atTable.has(participant) || !participants.includes(participant)) continue;
        if ((await options.binding.validate(session, observedAt)) === "Current")
          atTable.add(participant);
      }
      return Object.freeze(
        participants.map((participantReference) =>
          Object.freeze({
            participantReference,
            standing: atTable.has(participantReference) ? "AtTable" : "Gone",
          }),
        ),
      );
    },
  };
  return Object.freeze(port);
}
