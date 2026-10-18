import {
  assertGuestSessionUsable,
  createGuestSession,
  readClosedRecord,
  type GuestSession,
} from "@bop/identity";
import {
  CartError,
  parseOrderingInstant,
  parseOrderingReference,
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
function unavailable(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
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
    } catch {
      return denied();
    }
  }
  return Object.freeze({
    async run<T>(
      credential: string,
      action: (snapshot: DiningCartAuthoritySnapshot) => Promise<T>,
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
      async function authorize() {
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
          return unavailable();
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
      const first = await authorize();
      // Callers parse/freeze dependency results before returning from the action.
      const value = await action(first);
      const last = await authorize();
      if (!sameSession(first.session, last.session)) return denied();
      for (const key of [
        "brandReference",
        "storeReference",
        "diningSessionReference",
        "participantReference",
        "tableReference",
        "tableAssignmentVersion",
        "diningSessionVersion",
        "participantVersion",
      ] as const) {
        if (first.participation[key] !== last.participation[key]) return denied();
      }
      return Object.freeze({ value, authority: last });
    },
  });
}
