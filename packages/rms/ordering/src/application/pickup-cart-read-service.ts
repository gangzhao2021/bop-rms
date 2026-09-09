import {
  assertGuestSessionUsable,
  createGuestSession,
  parseGuestRawCredential,
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

export interface PickupCartReadPorts {
  readonly sessions: {
    resolve(input: {
      readonly sessionCredential: unknown;
      readonly activity: "Background";
      readonly observedAt: unknown;
    }): Promise<GuestSession>;
  };
  readonly binding: {
    current(session: GuestSession, observedAt: unknown): Promise<CartAggregate | null>;
  };
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly now: () => string;
}

// Restricted owner-internal read result. A separate safe display DTO is required for HTTP.
export interface PickupCartReadResult {
  readonly cart: CartAggregate;
  readonly effectiveStatus: "Active" | "Abandoned" | "Expired";
  readonly observedAt: OrderingInstant;
}

function closed(value: unknown): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      throw new CartError("CART_INPUT_INVALID");
    const keys = Reflect.ownKeys(value);
    if (
      !keys.includes("sessionCredential") ||
      keys.some((key) => key !== "sessionCredential" && key !== "cartReference")
    )
      throw new CartError("CART_INPUT_INVALID");
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        throw new CartError("CART_INPUT_INVALID");
      output[key as string] = descriptor.value;
    }
    return output;
  } catch {
    throw new CartError("CART_INPUT_INVALID");
  }
}

export function createPickupCartReadService(ports: PickupCartReadPorts) {
  const brand = parseOrderingReference(ports.scope.brandReference);
  const store = parseOrderingReference(ports.scope.storeReference);
  const at = () => {
    try {
      return parseOrderingInstant(ports.now());
    } catch {
      throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
    }
  };
  const sessionAt = async (credential: string, observedAt: OrderingInstant) => {
    let resolved: GuestSession;
    try {
      resolved = await ports.sessions.resolve({
        sessionCredential: credential,
        activity: "Background",
        observedAt,
      });
    } catch {
      throw new CartError("CART_PERMISSION_DENIED");
    }
    try {
      const session = assertGuestSessionUsable(createGuestSession(resolved), observedAt);
      if (
        String(session.brandReference) !== brand ||
        String(session.storeReference) !== store ||
        session.channel !== "Pickup" ||
        session.diningState !== "ContextOnly" ||
        session.diningSessionReference !== null ||
        session.diningParticipantReference !== null
      )
        throw new Error("denied");
      return session;
    } catch {
      throw new CartError("CART_PERMISSION_DENIED");
    }
  };
  return Object.freeze({
    async read(input: unknown): Promise<PickupCartReadResult | null> {
      const raw = closed(input);
      let credential: string;
      try {
        credential = parseGuestRawCredential(raw.sessionCredential);
      } catch {
        throw new CartError("CART_INPUT_INVALID");
      }
      const requestedReference = Object.hasOwn(raw, "cartReference")
        ? parseOrderingReference(raw.cartReference)
        : null;
      const startedAt = at();
      const session = await sessionAt(credential, startedAt);
      let loaded: CartAggregate | null;
      try {
        loaded = await ports.binding.current(session, startedAt);
      } catch {
        throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
      }
      // Re-resolve even for absence, so an intervening revocation has uniform behavior.
      const observedAt = at();
      if (observedAt < startedAt) throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
      const currentSession = await sessionAt(credential, observedAt);
      if (
        currentSession.sessionReference !== session.sessionReference ||
        currentSession.publicStoreReference !== session.publicStoreReference ||
        currentSession.qrReference !== session.qrReference ||
        currentSession.qrRevocationVersion !== session.qrRevocationVersion
      )
        throw new CartError("CART_PERMISSION_DENIED");
      if (loaded === null) return null;
      let cart: CartAggregate;
      try {
        cart = parseCartAggregate(loaded);
        if (
          cart.brandReference !== brand ||
          cart.storeReference !== store ||
          cart.orderType !== "Pickup" ||
          !["Qr", "Web"].includes(cart.sourceChannel) ||
          cart.createdByActorReference !== String(session.sessionReference) ||
          cart.diningSessionReference !== null ||
          cart.updatedAt > observedAt ||
          cart.lifecycle === null
        )
          throw new Error("invalid binding");
      } catch {
        throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
      }
      if (requestedReference !== null && cart.cartReference !== requestedReference) return null;
      const lifecycle = cart.lifecycle;
      if (lifecycle === null) throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
      const effectiveStatus =
        lifecycle.status === "Active" &&
        (observedAt >= lifecycle.idleExpiresAt || observedAt >= lifecycle.absoluteExpiresAt)
          ? "Expired"
          : lifecycle.status;
      return Object.freeze({ cart, effectiveStatus, observedAt });
    },
  });
}
