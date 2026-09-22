import {
  assertGuestSessionUsable,
  createGuestSession,
  readClosedRecord,
  type GuestSession,
} from "@bop/identity";
import {
  CartError,
  parseCartAggregate,
  parseOrderingInstant,
  parseOrderingReference,
} from "../domain/cart.js";
import { assertCartLifecycleActive } from "../domain/cart-lifecycle.js";
import {
  parseCheckoutDetailsSnapshot,
  type CheckoutDetailsSnapshot,
} from "../domain/checkout-details.js";

export interface CheckoutDetailsReadPorts {
  readonly now: () => string;
  readonly authorization: {
    authorize(
      input: Readonly<{ cartReference: string; observedAt: string }>,
    ): Promise<GuestSession | null>;
  };
  readonly repository: {
    loadCart(reference: string): Promise<unknown>;
    loadLatest(
      cartReference: string,
      guestSessionReference: string,
    ): Promise<CheckoutDetailsSnapshot | null>;
  };
}
const fail = (code: CartError["code"] = "CART_DEPENDENCY_UNAVAILABLE"): never => {
  throw new CartError(code);
};
export function createCheckoutDetailsReadService(ports: CheckoutDetailsReadPorts) {
  return Object.freeze({
    async read(value: unknown) {
      try {
        const input = readClosedRecord(value, ["cartReference", "cartVersion"]);
        const cartReference = parseOrderingReference(input.cartReference);
        if (
          !Number.isSafeInteger(input.cartVersion) ||
          Number(input.cartVersion) < 1 ||
          Number(input.cartVersion) > 2147483647
        )
          return fail("CART_INPUT_INVALID");
        let previous: string | undefined;
        const now = () => {
          const at = parseOrderingInstant(ports.now());
          if (previous !== undefined && at < previous) return fail();
          previous = at;
          return at;
        };
        let first: GuestSession | undefined;
        const authorize = async () => {
          const found = await ports.authorization.authorize({ cartReference, observedAt: now() });
          if (found === null) return fail("CART_PERMISSION_DENIED");
          const guest = assertGuestSessionUsable(createGuestSession(found), now());
          if (String(guest.createdAt) > now() || String(guest.lastSeenAt) > now())
            return fail("CART_PERMISSION_DENIED");
          const fields: readonly (keyof GuestSession)[] = [
            "sessionReference",
            "version",
            "brandReference",
            "storeReference",
            "channel",
            "publicStoreReference",
            "publicTableReference",
            "qrReference",
            "qrRevocationVersion",
            "diningState",
            "diningSessionReference",
            "diningParticipantReference",
          ];
          if (first !== undefined && fields.some((field) => first?.[field] !== guest[field]))
            return fail("CART_PERMISSION_DENIED");
          first ??= guest;
          return guest;
        };
        const guest = await authorize();
        const loadCart = async () => {
          const value = await ports.repository.loadCart(cartReference);
          if (value === null) return fail("CART_UNAVAILABLE");
          const cart = parseCartAggregate(value);
          if (
            cart.cartReference !== cartReference ||
            cart.brandReference !== String(guest.brandReference) ||
            cart.storeReference !== String(guest.storeReference) ||
            cart.orderType !== guest.channel ||
            !["Web", "Qr"].includes(cart.sourceChannel) ||
            (cart.orderType === "Pickup"
              ? cart.createdByActorReference !== String(guest.sessionReference) ||
                guest.diningState !== "ContextOnly"
              : guest.diningState !== "DiningBound" ||
                guest.diningParticipantReference === null ||
                cart.diningSessionReference !== String(guest.diningSessionReference))
          )
            return fail("CART_PERMISSION_DENIED");
          if (cart.aggregateVersion !== input.cartVersion) return fail("CART_VERSION_CONFLICT");
          if (cart.updatedAt > now()) return fail();
          assertCartLifecycleActive(cart.lifecycle, now());
          return cart;
        };
        const cart = await loadCart();
        await authorize();
        const raw = await ports.repository.loadLatest(
          cartReference,
          String(guest.sessionReference),
        );
        const details = raw === null ? null : parseCheckoutDetailsSnapshot(raw);
        if (
          details !== null &&
          (details.brandReference !== cart.brandReference ||
            details.storeReference !== cart.storeReference ||
            details.guestSessionReference !== String(guest.sessionReference) ||
            details.cartReference !== cartReference ||
            details.orderType !== cart.orderType ||
            details.cartVersion > cart.aggregateVersion ||
            details.recordedAt > now())
        )
          return fail();
        const next = await loadCart();
        const canonical = (value: unknown) =>
          JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
        if (canonical(next) !== canonical(cart)) return fail("CART_VERSION_CONFLICT");
        await authorize();
        assertCartLifecycleActive(cart.lifecycle, now());
        return Object.freeze({
          cartReference,
          cartVersion: cart.aggregateVersion,
          orderType: cart.orderType,
          details,
        });
      } catch (error) {
        if (error instanceof CartError) throw error;
        return fail();
      }
    },
  });
}
