import {
  assertGuestSessionUsable,
  createGuestSession,
  parseGuestRawCredential,
  readClosedRecord,
  type GuestSession,
} from "@bop/identity";
import {
  CartError,
  parseCartAggregate,
  parseOrderingInstant,
  parseOrderingReference,
  type CartAggregate,
  type OrderingInstant,
} from "../domain/cart.js";

export interface DiningCartReadPorts {
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
  readonly carts: {
    current(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly diningSessionReference: string;
      readonly observedAt: OrderingInstant;
    }): Promise<CartAggregate | null>;
  };
  readonly now: () => string;
}
export interface DiningCartReadResult {
  readonly context: { readonly publicStoreReference: string; readonly locale: string };
  readonly cart: CartAggregate;
  readonly effectiveStatus: "Active" | "Abandoned" | "Expired";
  readonly observedAt: OrderingInstant;
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

/** Restricted internal snapshot only. Shared reads do not transfer creator or item ownership. */
export function createDiningCartReadService(ports: DiningCartReadPorts) {
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
    async read(value: unknown): Promise<DiningCartReadResult | null> {
      let credential: string;
      let requestedReference: string | null;
      try {
        const raw = readClosedRecord(
          value,
          Object.hasOwn(value as object, "cartReference")
            ? ["sessionCredential", "cartReference"]
            : ["sessionCredential"],
        );
        credential = parseGuestRawCredential(raw.sessionCredential);
        requestedReference = Object.hasOwn(raw, "cartReference")
          ? parseOrderingReference(raw.cartReference)
          : null;
      } catch {
        throw new CartError("CART_INPUT_INVALID");
      }
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
          if (error instanceof CartError && error.code === "CART_PERMISSION_DENIED") throw error;
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
        return { session: current, participation: receipt, observedAt };
      }
      const first = await authorize();
      let cart: CartAggregate | null;
      try {
        const source = await ports.carts.current(
          Object.freeze({
            brandReference: brand,
            storeReference: store,
            diningSessionReference: first.participation.diningSessionReference,
            observedAt: first.observedAt,
          }),
        );
        // Capture dependency data before any later authorizer or clock can mutate its source.
        cart = source === null ? null : parseCartAggregate(source);
      } catch {
        return unavailable();
      }
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
      if (cart === null) return null;
      if (
        cart.brandReference !== brand ||
        cart.storeReference !== store ||
        cart.orderType !== "DineIn" ||
        cart.diningSessionReference !== first.participation.diningSessionReference ||
        !["Qr", "Web"].includes(cart.sourceChannel) ||
        cart.updatedAt > last.observedAt ||
        cart.lifecycle === null
      )
        return unavailable();
      if (requestedReference !== null && cart.cartReference !== requestedReference) return null;
      const lifecycle = cart.lifecycle;
      const effectiveStatus =
        lifecycle.status === "Active" &&
        (last.observedAt >= lifecycle.idleExpiresAt ||
          last.observedAt >= lifecycle.absoluteExpiresAt)
          ? "Expired"
          : lifecycle.status;
      return Object.freeze({
        context: Object.freeze({
          publicStoreReference: String(last.session.publicStoreReference),
          locale: String(last.session.locale),
        }),
        cart,
        effectiveStatus,
        observedAt: last.observedAt,
      });
    },
  });
}
