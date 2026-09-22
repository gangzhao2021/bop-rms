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
  parseCartQuoteAttachment,
  parseConfiguredCartQuoteAttachment,
} from "../domain/cart-quote-attachment.js";
import {
  parseCheckoutDetailsSnapshot,
  CheckoutDetailsError,
  type CheckoutDetailsSnapshot,
  type CheckoutPolicyAcknowledgement,
} from "../domain/checkout-details.js";

type SaveInput = Readonly<{
  operationReference: string;
  expectedVersion: number;
  snapshot: CheckoutDetailsSnapshot;
  audit: unknown;
}>;
export interface CheckoutDetailsPorts {
  readonly now: () => string;
  readonly authorization: {
    authorize(
      input: Readonly<{
        cartReference: string;
        detailsReference: string;
        operationReference: string;
        observedAt: string;
      }>,
    ): Promise<Readonly<{ guestSession: GuestSession; audit: unknown }> | null>;
  };
  readonly repository: {
    loadCart(cartReference: string): Promise<unknown>;
    loadQuote(cartReference: string): Promise<unknown>;
    resolveOperation(
      operationReference: string,
      guestSessionReference: string,
    ): Promise<CheckoutDetailsSnapshot | null>;
    save(
      input: SaveInput,
    ): Promise<Readonly<{ status: "Saved" | "AlreadySaved"; snapshot: CheckoutDetailsSnapshot }>>;
  };
  readonly policies: {
    current(
      input: Readonly<{
        brandReference: string;
        storeReference: string;
        orderType: "DineIn" | "Pickup";
        observedAt: string;
      }>,
    ): Promise<Readonly<{
      brandReference: string;
      storeReference: string;
      orderType: "DineIn" | "Pickup";
      checkedAt: string;
      validUntil: string;
      required: readonly CheckoutPolicyAcknowledgement[];
    }> | null>;
  };
}
const fail = (code: CartError["code"] = "CART_DEPENDENCY_UNAVAILABLE"): never => {
  throw new CartError(code);
};
const same = (left: unknown, right: unknown) =>
  JSON.stringify(left, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  ) ===
  JSON.stringify(right, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
const policyKey = (values: readonly CheckoutPolicyAcknowledgement[]) =>
  JSON.stringify(
    [...values].sort((a, b) => a.documentReference.localeCompare(b.documentReference)),
  );
export function createCheckoutDetailsService(ports: CheckoutDetailsPorts) {
  return Object.freeze({
    async save(value: unknown) {
      let attempted = false;
      try {
        const raw = readClosedRecord(value, [
          "operationReference",
          "detailsReference",
          "expectedVersion",
          "cartReference",
          "cartVersion",
          "quoteReference",
          "quoteVersion",
          "pickupContact",
          "receipt",
          "policies",
        ]);
        const operationReference = parseOrderingReference(raw.operationReference),
          detailsReference = parseOrderingReference(raw.detailsReference);
        const cartReference = parseOrderingReference(raw.cartReference);
        if (
          !Number.isSafeInteger(raw.expectedVersion) ||
          Number(raw.expectedVersion) < 0 ||
          Number(raw.expectedVersion) >= 2147483647
        )
          return fail("CART_INPUT_INVALID");
        let last: string | undefined;
        const now = () => {
          const at = parseOrderingInstant(ports.now());
          if (last !== undefined && at < last) return fail();
          last = at;
          return at;
        };
        let first: GuestSession | undefined;
        async function authorize() {
          const at = now(),
            found = await ports.authorization.authorize({
              cartReference,
              detailsReference,
              operationReference,
              observedAt: at,
            });
          if (found === null) return fail("CART_PERMISSION_DENIED");
          const session = assertGuestSessionUsable(createGuestSession(found.guestSession), now());
          if (String(session.createdAt) > now() || String(session.lastSeenAt) > now())
            return fail("CART_PERMISSION_DENIED");
          if (
            first &&
            [
              "sessionReference",
              "version",
              "brandReference",
              "storeReference",
              "channel",
              "diningState",
              "diningSessionReference",
              "diningParticipantReference",
              "qrReference",
              "qrRevocationVersion",
            ].some(
              (field) =>
                first?.[field as keyof GuestSession] !== session[field as keyof GuestSession],
            )
          )
            return fail("CART_PERMISSION_DENIED");
          first ??= session;
          return { session, audit: found.audit, at };
        }
        const initial = await authorize(),
          guest = initial.session;
        function owned(value: unknown) {
          if (value === null) return fail("CART_UNAVAILABLE");
          const cart = parseCartAggregate(value);
          if (
            cart.cartReference !== cartReference ||
            cart.brandReference !== String(guest.brandReference) ||
            cart.storeReference !== String(guest.storeReference) ||
            cart.orderType !== guest.channel ||
            !["Qr", "Web"].includes(cart.sourceChannel) ||
            (cart.orderType === "Pickup" &&
              (cart.createdByActorReference !== String(guest.sessionReference) ||
                guest.diningState !== "ContextOnly")) ||
            (cart.orderType === "DineIn" &&
              (guest.diningState !== "DiningBound" ||
                guest.diningParticipantReference === null ||
                cart.diningSessionReference !== String(guest.diningSessionReference)))
          )
            return fail("CART_PERMISSION_DENIED");
          if (cart.updatedAt > now()) return fail();
          return cart;
        }
        const cart = owned(await ports.repository.loadCart(cartReference));
        const candidate = (at: string) =>
          parseCheckoutDetailsSnapshot({
            schemaVersion: 1,
            detailsReference,
            detailsVersion: Number(raw.expectedVersion) + 1,
            guestSessionReference: String(guest.sessionReference),
            brandReference: cart.brandReference,
            storeReference: cart.storeReference,
            cartReference,
            cartVersion: raw.cartVersion,
            quoteReference: raw.quoteReference,
            quoteVersion: raw.quoteVersion,
            orderType: cart.orderType,
            pickupContact: raw.pickupContact,
            receipt: raw.receipt,
            policies: raw.policies,
            recordedAt: at,
          });
        // Copy and freeze request data before awaiting further owner calls.
        const desired = candidate(initial.at);
        await authorize();
        const originalValue = await ports.repository.resolveOperation(
          operationReference,
          String(guest.sessionReference),
        );
        await authorize();
        if (originalValue !== null) {
          const original = parseCheckoutDetailsSnapshot(originalValue);
          if (
            !same({ ...original, recordedAt: desired.recordedAt }, desired) ||
            original.recordedAt > now()
          )
            return fail("CART_IDEMPOTENCY_CONFLICT");
          owned(await ports.repository.loadCart(cartReference));
          await authorize();
          return Object.freeze({ status: "AlreadySaved" as const, snapshot: original });
        }
        function currentCart(value: unknown) {
          const current = owned(value);
          if (current.aggregateVersion !== desired.cartVersion)
            return fail("CART_VERSION_CONFLICT");
          assertCartLifecycleActive(current.lifecycle, now());
          if (current.items.length === 0) return fail("CART_QUOTE_INVALID");
          return current;
        }
        currentCart(cart);
        async function checkQuote() {
          const value = await ports.repository.loadQuote(cartReference);
          const quote =
            desired.quoteVersion === 2
              ? parseConfiguredCartQuoteAttachment(value)
              : parseCartQuoteAttachment(value);
          if (
            quote.brandReference !== desired.brandReference ||
            quote.storeReference !== desired.storeReference ||
            quote.guestSessionReference !== desired.guestSessionReference ||
            quote.cartReference !== cartReference ||
            quote.cartVersion !== desired.cartVersion ||
            quote.quoteReference !== desired.quoteReference
          )
            return fail("CART_QUOTE_INVALID");
          const at = now();
          if (quote.attachedAt > at || quote.quoteExpiresAt <= at)
            return fail("CART_QUOTE_EXPIRED");
          return quote;
        }
        const quote = await checkQuote();
        const at = now();
        const foundPolicy = await ports.policies.current({
          brandReference: desired.brandReference,
          storeReference: desired.storeReference,
          orderType: desired.orderType,
          observedAt: at,
        });
        if (foundPolicy === null) return fail();
        const policy = readClosedRecord(foundPolicy, [
          "brandReference",
          "storeReference",
          "orderType",
          "checkedAt",
          "validUntil",
          "required",
        ]);
        const checkedAt = parseOrderingInstant(policy.checkedAt),
          validUntil = parseOrderingInstant(policy.validUntil);
        const required = parseCheckoutDetailsSnapshot({
          ...desired,
          policies: policy.required,
        }).policies;
        if (
          policy.brandReference !== desired.brandReference ||
          policy.storeReference !== desired.storeReference ||
          policy.orderType !== desired.orderType ||
          checkedAt !== at ||
          validUntil <= checkedAt ||
          validUntil <= now()
        )
          return fail();
        if (policyKey(required) !== policyKey(desired.policies))
          return fail("CART_SELECTION_INVALID");
        if (!same(currentCart(await ports.repository.loadCart(cartReference)), cart))
          return fail("CART_VERSION_CONFLICT");
        if (!same(await checkQuote(), quote)) return fail("CART_QUOTE_INVALID");
        const admission = await authorize();
        if (now() >= validUntil || now() >= quote.quoteExpiresAt) return fail("CART_QUOTE_EXPIRED");
        const snapshot = parseCheckoutDetailsSnapshot({ ...desired, recordedAt: admission.at });
        attempted = true;
        const result = await ports.repository.save({
          operationReference,
          expectedVersion: Number(raw.expectedVersion),
          snapshot,
          audit: admission.audit,
        });
        const saved = parseCheckoutDetailsSnapshot(result.snapshot);
        if (
          !["Saved", "AlreadySaved"].includes(result.status) ||
          !same({ ...saved, recordedAt: snapshot.recordedAt }, snapshot) ||
          saved.recordedAt > now()
        )
          return fail();
        await authorize();
        return Object.freeze({ status: result.status, snapshot: saved });
      } catch (error) {
        if (!attempted && (error instanceof CartError || error instanceof CheckoutDetailsError))
          throw error;
        return fail();
      }
    },
  });
}
