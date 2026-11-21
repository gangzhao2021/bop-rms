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
  isGuestCartChannel,
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
  /**
   * WP-2423 M03: which of this guest's Orders the Cart's dishes went to, so the page says "already
   * ordered" (or that the Order closed unpaid) instead of an empty Cart or a payable checkout.
   * `latest`: the latest Order from this Cart while nothing was put in it since (read when the Cart
   * is empty). `holding`: the Order that already holds the Cart's current dishes (a Cart filled
   * before pickup Carts were emptied on ordering; read when the Cart has dishes), the same rule
   * that refuses their checkout. Each answers only with the guest's own Order.
   */
  readonly orders?: {
    latest(input: {
      readonly cartReference: string;
      readonly guestSessionReference: string;
    }): Promise<PlacedOrderAnswer | null>;
    holding?(input: {
      readonly cartReference: string;
      readonly cartVersion: number;
      readonly guestSessionReference: string;
    }): Promise<PlacedOrderAnswer | null>;
  };
}

export interface PlacedOrderAnswer {
  readonly orderReference: string;
  readonly orderNumber: string;
  /** The Order will not be made (closed, cancelled, or its payment closed unpaid). */
  readonly notMade: boolean;
}

// Restricted owner-internal read result. A separate safe display DTO is required for HTTP.
export interface PickupCartReadResult {
  readonly context: { readonly publicStoreReference: string; readonly locale: string };
  readonly cart: CartAggregate;
  readonly effectiveStatus: "Active" | "Abandoned" | "Expired";
  readonly observedAt: OrderingInstant;
  /**
   * WP-2423 M03: this guest's Order the Cart's dishes went to: while the Cart is empty after it, or
   * while the Cart still holds dishes that are already in it (they can't be checked out again).
   */
  readonly placedOrder: PlacedOrderAnswer | null;
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
    } catch (error) {
      // The session's store failed: a passing fault, not an expired session.
      if ((error as { dependencyFailure?: unknown } | null)?.dependencyFailure === true)
        throw Object.assign(new CartError("CART_DEPENDENCY_UNAVAILABLE"), { cause: error });
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
      } catch (error) {
        // WP-2423 (rush-reads-and-orders-changes): what the read met stays under it (no connection
        // in a rush is a wait, a refusal a fault), so the line it is logged with can say which.
        throw Object.assign(new CartError("CART_DEPENDENCY_UNAVAILABLE"), { cause: error });
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
          !isGuestCartChannel(cart.orderType, cart.sourceChannel) ||
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
      let placedOrder: PickupCartReadResult["placedOrder"] = null;
      const orders = ports.orders;
      const guestSessionReference = String(session.sessionReference);
      const lookup =
        orders === undefined
          ? undefined
          : cart.items.length === 0
            ? () => orders.latest({ cartReference: cart.cartReference, guestSessionReference })
            : orders.holding === undefined
              ? undefined
              : () =>
                  orders.holding?.({
                    cartReference: cart.cartReference,
                    cartVersion: cart.aggregateVersion,
                    guestSessionReference,
                  }) ?? Promise.resolve(null);
      if (lookup !== undefined) {
        let found: Awaited<ReturnType<typeof lookup>>;
        try {
          found = await lookup();
        } catch (error) {
          throw Object.assign(new CartError("CART_DEPENDENCY_UNAVAILABLE"), { cause: error });
        }
        try {
          if (
            found !== null &&
            (!/^[1-9][0-9]{0,18}$/u.test(found.orderNumber) || typeof found.notMade !== "boolean")
          )
            throw new Error("invalid placed order");
          placedOrder =
            found === null
              ? null
              : Object.freeze({
                  orderReference: parseOrderingReference(found.orderReference),
                  orderNumber: found.orderNumber,
                  notMade: found.notMade,
                });
        } catch {
          throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
        }
      }
      return Object.freeze({
        context: Object.freeze({
          publicStoreReference: String(currentSession.publicStoreReference),
          locale: String(currentSession.locale),
        }),
        cart,
        effectiveStatus,
        observedAt,
        placedOrder,
      });
    },
  });
}
