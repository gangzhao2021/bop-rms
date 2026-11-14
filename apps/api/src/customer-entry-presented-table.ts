import {
  GuestSessionService,
  type GuestSession,
  type GuestSessionServiceOptions,
} from "@bop/identity";
import { parseDiningInstant, parseDiningReference } from "@rms/dining";
import {
  createCustomerDiningSessionBinding,
  type CustomerDiningBindingCompositionOptions,
} from "./customer-dining-binding-composition.js";
import type { CustomerEntryPresentedTable } from "./customer-entry.js";

export interface CustomerEntryPresentedSessions {
  resolve(input: {
    readonly sessionCredential: unknown;
    readonly activity: "Background";
    readonly observedAt: unknown;
  }): Promise<GuestSession>;
}

/**
 * The answer about the browser's own Guest cookie:
 * - the table it is seated at now (its participant confirmed at that table);
 * - `null`: the owners answered that it is not seated (no such session, ended or revoked,
 *   context only, pickup, a staff-removed participant, a closed or moved party);
 * - `{ unconfirmed }`: Identity says this phone is seated at that table but Dining could not be
 *   read (an outage), so nobody can say whether it still is.
 */
export type CustomerEntryPresentedAnswer =
  CustomerEntryPresentedTable | null | { readonly unconfirmed: CustomerEntryPresentedTable };

export interface CustomerEntryPresentedTablePorts {
  /** Identity's own read of the session (no Dining check). */
  readonly identity: CustomerEntryPresentedSessions;
  /** The same read with the Dining binding check (participant still at the table, party unchanged). */
  readonly seated: CustomerEntryPresentedSessions;
  /**
   * Dining's own answer for this session's participant, read directly: "Seated" only while the
   * participant is Active in an Active session that was not moved off the table it joined at.
   * Rejects when Dining could not be read.
   */
  participant(session: GuestSession, observedAt: string): Promise<"Seated" | "NotSeated">;
}

/**
 * WP-2423 shared-table-checkout (b): the table the browser's own Guest cookie is seated at now.
 * Read only (Background: the idle expiry is not renewed). "Not seated" is only ever an answer an
 * owner gave; a check that could not be made is `unconfirmed`, never "not seated".
 */
export function createCustomerEntryPresentedTable(
  ports: CustomerEntryPresentedTablePorts,
): (sessionCredential: string, observedAt: string) => Promise<CustomerEntryPresentedAnswer> {
  return async (sessionCredential, observedAt) => {
    const read = { sessionCredential, activity: "Background" as const, observedAt };
    // Identity could not answer: the entry needs Identity too and meets the same outage.
    const session = await ports.identity.resolve(read).catch(() => null);
    if (
      session === null ||
      session.status !== "Active" ||
      session.diningState !== "DiningBound" ||
      session.channel !== "DineIn" ||
      session.publicTableReference === null
    )
      return null;
    const table: CustomerEntryPresentedTable = Object.freeze({
      publicStoreReference: String(session.publicStoreReference),
      publicTableReference: String(session.publicTableReference),
      qrReference: String(session.qrReference),
      qrRevocationVersion: session.qrRevocationVersion,
    });
    if (
      await ports.seated.resolve(read).then(
        () => true,
        () => false,
      )
    )
      return table;
    // The binding check folds "not at the table" and "could not be read" into one refusal: ask
    // Dining itself. Only its answer that the phone is not seated makes this an ordinary entry.
    // Only Dining failing to answer leaves it unconfirmed. When Dining answers (seated or not)
    // the check failed for another reason (a replaced code, a moved party): an ordinary entry,
    // never a retry the guest could be stuck on.
    const seated = await ports.participant(session, observedAt).then(
      () => "Answered" as const,
      () => "Unknown" as const,
    );
    return seated === "Unknown" ? Object.freeze({ unconfirmed: table }) : null;
  };
}

/**
 * The ports above as the API composes them: Identity's own session read, the same read with the
 * shared current-owner Dining binding check, and Dining's participation snapshot read directly.
 */
export function composeCustomerEntryPresentedTable(options: {
  readonly scope: Readonly<{ brandReference: string; storeReference: string }>;
  readonly session: Pick<GuestSessionServiceOptions, "binding" | "credentials">;
  readonly store: GuestSessionServiceOptions["store"];
  readonly dining: Pick<CustomerDiningBindingCompositionOptions, "contexts"> & {
    readonly binding: CustomerDiningBindingCompositionOptions["dining"]["binding"];
  };
  readonly now: () => string;
}) {
  const base = {
    ...options.session,
    store: options.store,
    admission: { consume: async () => null },
    now: options.now,
  };
  return createCustomerEntryPresentedTable({
    identity: new GuestSessionService({
      ...base,
      // Identity's own facts only: whether the cookie is a live session and where it was seated.
      binding: { validate: async () => "Current" as const },
    }),
    seated: new GuestSessionService({
      ...base,
      binding: createCustomerDiningSessionBinding({
        scope: options.scope,
        binding: options.session.binding,
        repository: options.dining.binding,
        contexts: options.dining.contexts,
        now: options.now,
      }),
    }),
    async participant(session, observedAt) {
      if (session.diningSessionReference === null || session.diningParticipantReference === null)
        return "NotSeated";
      const snapshot = await options.dining.binding.readCurrent({
        brandReference: parseDiningReference(options.scope.brandReference),
        storeReference: parseDiningReference(options.scope.storeReference),
        diningSessionReference: parseDiningReference(session.diningSessionReference),
        participantReference: parseDiningReference(session.diningParticipantReference),
        observedAt: parseDiningInstant(observedAt),
      });
      return diningSeatOf(snapshot);
    },
  });
}

/**
 * Dining's answer for one participant snapshot: seated only while the participant is Active in an
 * Active (or Closing: paying) session that was not moved off the table the phone joined at.
 */
export function diningSeatOf(
  snapshot: {
    readonly participant: { readonly status: string };
    readonly session: { readonly phase: string };
    readonly followedMove?: unknown;
  } | null,
): "Seated" | "NotSeated" {
  return snapshot !== null &&
    snapshot.participant.status === "Active" &&
    (snapshot.session.phase === "Active" || snapshot.session.phase === "Closing") &&
    (snapshot.followedMove ?? null) === null
    ? "Seated"
    : "NotSeated";
}
