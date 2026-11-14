import {
  assertGuestSessionUsable,
  createGuestSession,
  readClosedRecord,
  type GuestSession,
} from "@bop/identity";
import {
  CartError,
  CartParticipationEndedError,
  parseOrderingInstant,
  parseOrderingReference,
  readCartParticipationEnded,
  type OrderingInstant,
} from "../domain/cart.js";

export interface DiningCartAuthorityPorts {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly sessions: {
    /** Current Identity binding includes owner validation of the original consumed admission. */
    resolve(input: {
      readonly sessionCredential: unknown;
      readonly activity: "Background";
      readonly observedAt: unknown;
    }): Promise<GuestSession>;
  };
  readonly participation: {
    /** Exact public Dining Cart participation query; this observation is not a write lease. */
    resolve(input: {
      readonly purpose: "Cart";
      readonly diningSessionReference: string;
      readonly participantReference: string;
    }): Promise<unknown>;
  };
  readonly now: () => string;
  /**
   * WP-2423 M35 (DEC-STAFF-ROUND-SPEED): runs one check (the Guest Session, its Dining
   * participation, the Guest Session again) as one unit of the owners' reads, in one transaction
   * where the composition can. The same reads, in the same order. Absent: each read runs alone.
   */
  readonly together?: <T>(work: () => Promise<T>) => Promise<T>;
}
const participationFields = [
  "schemaVersion",
  "brandReference",
  "storeReference",
  "diningSessionReference",
  "participantReference",
  "tableReference",
  "tableAssignmentVersion",
  "diningSessionVersion",
  "participantVersion",
  "observedAt",
] as const;
function denied(): never {
  throw new CartError("CART_PERMISSION_DENIED");
}
const failureCauseKey = Symbol.for("bop.failure.cause");
/**
 * WP-2423 (rush-connection-hold): "couldn't read what the guest's place needs", keeping what it met
 * (`cause`) for the log at the edge: in rush waves bare [CART_DEPENDENCY_UNAVAILABLE] lines said
 * nothing of the Guest Session or table read that could not answer.
 */
function unavailable(cause?: unknown): never {
  const error = new CartError("CART_DEPENDENCY_UNAVAILABLE");
  // Never as `cause` (an owner's failure never crosses as it is): under the key the log follows.
  if (cause !== undefined) Object.defineProperty(error, failureCauseKey, { value: cause });
  throw error;
}
function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return unavailable();
  return value;
}
function participation(value: unknown) {
  try {
    const raw = readClosedRecord(value, participationFields);
    if (raw.schemaVersion !== 1) return unavailable();
    return Object.freeze({
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      diningSessionReference: parseOrderingReference(raw.diningSessionReference),
      participantReference: parseOrderingReference(raw.participantReference),
      tableReference: parseOrderingReference(raw.tableReference),
      tableAssignmentVersion: version(raw.tableAssignmentVersion),
      diningSessionVersion: version(raw.diningSessionVersion),
      participantVersion: version(raw.participantVersion),
      observedAt: parseOrderingInstant(raw.observedAt),
    });
  } catch {
    return unavailable();
  }
}
function sameSession(a: GuestSession, b: GuestSession): boolean {
  return (
    [
      "sessionReference",
      "version",
      "brandReference",
      "storeReference",
      "publicStoreReference",
      "publicTableReference",
      "qrReference",
      "qrRevocationVersion",
      "diningState",
      "diningSessionReference",
      "diningParticipantReference",
      "locale",
    ] as const
  ).every((key) => a[key] === b[key]);
}

export interface DiningCartAuthoritySnapshot {
  readonly session: GuestSession;
  readonly participation: ReturnType<typeof participation>;
  readonly observedAt: OrderingInstant;
}

/**
 * WP-2423 (outage-reads-and-retry, v15 2026-11-11): while a guest added a dish, staff moved the
 * guest's own table (or merged another into it) and the add answered "couldn't add this right
 * now"; a read in that moment answered "your session ended". The same phone, the same party and
 * the same participant, only where the party sits (or the party's version) changed: the action is
 * done again on what is current now, as staff would expect at a real table. Raised by the checks
 * that see it; `run` does the action again, and only if the table keeps changing says so.
 */
export class CartPartyMovedError extends CartError {
  readonly tableChanged: boolean;
  constructor(tableChanged: boolean) {
    super("CART_DEPENDENCY_UNAVAILABLE");
    this.name = "CartPartyMovedError";
    this.tableChanged = tableChanged;
  }
}
const placementKeys = [
  "tableReference",
  "tableAssignmentVersion",
  "diningSessionVersion",
  "participantVersion",
] as const;
/**
 * The same participant of the same party, seen at another place or version of its table: a
 * CartPartyMovedError to throw, or null when nothing but that changed is not the case.
 */
export function partyMoved(
  first: DiningCartAuthoritySnapshot,
  next: DiningCartAuthoritySnapshot,
): CartPartyMovedError | null {
  if (
    first.participation.brandReference !== next.participation.brandReference ||
    first.participation.storeReference !== next.participation.storeReference ||
    first.participation.diningSessionReference !== next.participation.diningSessionReference ||
    first.participation.participantReference !== next.participation.participantReference ||
    placementKeys.every((key) => first.participation[key] === next.participation[key])
  )
    return null;
  return new CartPartyMovedError(
    first.participation.tableReference !== next.participation.tableReference,
  );
}
/** How many times an action is done again while the party's table changes under it. */
export const diningCartMovedRetries = 2;

/** Internal invocation guard. Its current observations grant no persistent write lease. */
export function createDiningCartAuthority(ports: DiningCartAuthorityPorts) {
  let brand: string;
  let store: string;
  try {
    const scope = readClosedRecord(ports.scope, ["brandReference", "storeReference"]);
    brand = parseOrderingReference(scope.brandReference);
    store = parseOrderingReference(scope.storeReference);
  } catch {
    throw new CartError("CART_INPUT_INVALID");
  }
  async function sessionAt(credential: string, observedAt: OrderingInstant) {
    try {
      const session = assertGuestSessionUsable(
        createGuestSession(
          await ports.sessions.resolve(
            Object.freeze({ sessionCredential: credential, activity: "Background", observedAt }),
          ),
        ),
        observedAt,
      );
      if (
        session.brandReference !== brand ||
        session.storeReference !== store ||
        session.channel !== "DineIn" ||
        session.diningState !== "DiningBound" ||
        session.publicTableReference === null ||
        session.diningSessionReference === null ||
        session.diningParticipantReference === null
      )
        return denied();
      return session;
    } catch (error) {
      // M126: the Guest Session store could not answer: a retry, never "your visit ended".
      if (
        (error as { dependencyFailure?: unknown } | null)?.dependencyFailure === true ||
        (error instanceof CartError && error.code === "CART_DEPENDENCY_UNAVAILABLE")
      )
        return unavailable(error);
      return denied();
    }
  }
  return Object.freeze({
    /**
     * `retries`: how many times the action is done again when the party's table changes during
     * it (0: the CartPartyMovedError is left to the caller, which does its own action again).
     */
    async run<T>(
      credential: string,
      action: (snapshot: DiningCartAuthoritySnapshot) => Promise<T>,
      retries = diningCartMovedRetries,
    ): Promise<{ readonly value: T; readonly authority: DiningCartAuthoritySnapshot }> {
      let previous: OrderingInstant | null = null;
      const tick = () => {
        try {
          const next = parseOrderingInstant(ports.now());
          if (previous !== null && next < previous) return unavailable();
          previous = next;
          return next;
        } catch {
          return unavailable();
        }
      };
      const usable = (session: GuestSession, at: OrderingInstant) => {
        try {
          assertGuestSessionUsable(session, at);
        } catch {
          return denied();
        }
      };
      const authorize = () =>
        ports.together === undefined ? authorizeOnce() : ports.together(authorizeOnce);
      async function authorizeOnce() {
        const initial = await sessionAt(credential, tick());
        const from = tick();
        usable(initial, from);
        let receipt: ReturnType<typeof participation>;
        try {
          const source = await ports.participation.resolve(
            Object.freeze({
              purpose: "Cart",
              diningSessionReference: String(initial.diningSessionReference),
              participantReference: String(initial.diningParticipantReference),
            }),
          );
          if (source === null) return denied();
          receipt = participation(source);
        } catch (error) {
          if (error instanceof CartError && error.code === "CART_PERMISSION_DENIED")
            return denied();
          if (error instanceof CartError && error.code === "CART_TABLE_CHECKING_OUT") throw error;
          // M126 I.2: the phone's place ended (left, table closed, changed): said as such.
          if (readCartParticipationEnded(error) !== null) throw error;
          return unavailable(error);
        }
        const checkedAt = tick();
        if (receipt.observedAt < from || receipt.observedAt > checkedAt) return unavailable();
        if (
          receipt.brandReference !== brand ||
          receipt.storeReference !== store ||
          receipt.diningSessionReference !== String(initial.diningSessionReference) ||
          receipt.participantReference !== String(initial.diningParticipantReference)
        )
          return denied();
        const current = await sessionAt(credential, checkedAt);
        const observedAt = tick();
        usable(current, observedAt);
        if (!sameSession(initial, current)) return denied();
        return Object.freeze({ session: current, participation: receipt, observedAt });
      }
      // The party's table kept changing through every attempt: a table that moved is said as
      // such ("your party's table changed"), anything else as "busy, try again".
      const settle = (moved: CartPartyMovedError): never => {
        if (retries === 0) throw moved;
        if (moved.tableChanged) throw new CartParticipationEndedError("Changed");
        throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
      };
      for (let attempt = 0; ; attempt += 1) {
        const first = await authorize();
        // Callers parse/freeze dependency results before returning from the action.
        let value: T;
        try {
          value = await action(first);
        } catch (error) {
          if (!(error instanceof CartPartyMovedError)) throw error;
          if (attempt < retries) continue;
          return settle(error);
        }
        const last = await authorize();
        if (!sameSession(first.session, last.session)) return denied();
        const moved = partyMoved(first, last);
        if (moved !== null) {
          if (attempt < retries) continue;
          return settle(moved);
        }
        for (const key of [
          "brandReference",
          "storeReference",
          "diningSessionReference",
          "participantReference",
          ...placementKeys,
        ] as const) {
          if (first.participation[key] !== last.participation[key]) return denied();
        }
        return Object.freeze({ value, authority: last });
      }
    },
  });
}
