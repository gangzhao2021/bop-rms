import { createHash } from "node:crypto";
import { readClosedRecord, parseCanonicalInstant, GuestSessionError } from "@bop/identity";
import {
  CheckoutValidationError,
  createPostgresCartQueryStore,
  createPostgresCartQuoteReader,
  createPostgresConfiguredCartQuoteReader,
  createPostgresOrderCreationQueryStore,
  resolveConfiguredPickupCapacityCartSource,
  resolveConfiguredOrderedPickupCapacityCartSource,
  resolveOrderedPickupCapacityCartSource,
  resolvePickupCapacityCartSource,
  parseOrderingReference,
  type CartQueryTransactionRunner,
} from "@rms/ordering";
import {
  createPostgresCurrentPickupCapacityStore,
  deriveDefaultPickupCapacityUnits,
  type AsapCapacityTransactionRunner,
} from "@rms/fulfillment";
import type { CustomerPickupCheckoutOptions } from "./customer-pickup-checkout-composition.js";
export interface CustomerPickupCapacitySourcesOptions {
  readonly scope: CustomerPickupCheckoutOptions["scope"];
  readonly orderingTransactions: CartQueryTransactionRunner;
  readonly capacityTransactions: AsapCapacityTransactionRunner;
  readonly unitPolicy: {
    resolve(
      input: Readonly<{ brandReference: string; storeReference: string; observedAt: string }>,
    ): Promise<unknown>;
  };
  readonly now: () => string;
}
/**
 * WP-2423 (pickup-capacity-and-retry): the checkout's price is no longer held. By name and code: the
 * pilot can load Ordering as two copies.
 */
export function isQuoteExpired(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "CheckoutValidationError" &&
    (error as { code?: unknown }).code === "CHECKOUT_QUOTE_EXPIRED"
  );
}
/** Compose real owner readers; this source remains behind current Guest/CSRF authorization. */
function createVersionedCustomerPickupCapacitySources(
  options: CustomerPickupCapacitySourcesOptions,
  quoteVersion: 1 | 2,
): CustomerPickupCheckoutOptions["sources"] {
  const raw = readClosedRecord(options.scope, ["brandReference", "storeReference"]);
  const scope = Object.freeze({
    brandReference: parseOrderingReference(raw.brandReference),
    storeReference: parseOrderingReference(raw.storeReference),
  });
  const carts = createPostgresCartQueryStore(options.orderingTransactions, scope);
  const quotes = (
    quoteVersion === 2 ? createPostgresConfiguredCartQuoteReader : createPostgresCartQuoteReader
  )(options.orderingTransactions, scope);
  const capacity = createPostgresCurrentPickupCapacityStore(options.capacityTransactions, scope);
  const orders = createPostgresOrderCreationQueryStore(
    options.orderingTransactions,
    scope,
    quoteVersion,
  );
  return Object.freeze({
    async resolve(value) {
      try {
        const raw = readClosedRecord(value, [
          "guestSessionReference",
          "cartReference",
          "cartVersion",
          "quoteReference",
          "submissionReference",
          "observedAt",
        ]);
        if (!Number.isSafeInteger(raw.cartVersion) || (raw.cartVersion as number) < 1)
          throw new Error();
        const input = {
          guestSessionReference: parseOrderingReference(raw.guestSessionReference),
          cartReference: parseOrderingReference(raw.cartReference),
          cartVersion: raw.cartVersion as number,
          quoteReference: parseOrderingReference(raw.quoteReference),
          submissionReference: parseOrderingReference(raw.submissionReference),
          observedAt: parseCanonicalInstant(raw.observedAt),
        };
        if (input.observedAt > parseCanonicalInstant(options.now())) throw new Error();
        const cart = await carts.load(input.cartReference);
        const quote = await quotes.loadLatest({
          cartReference: input.cartReference,
          cartVersion: input.cartVersion,
          observedAt: input.observedAt,
        });
        // WP-2423 (pickup-capacity-and-retry): the price this checkout was asked with is no longer
        // held (a guest who waited on "the hour is full" and tried again later). Said as such, so
        // the page prices the order again; never told as the service being down.
        if (
          quote !== null &&
          String(quote.quoteReference) === input.quoteReference &&
          String(quote.quoteExpiresAt) <= input.observedAt
        )
          throw new CheckoutValidationError("CHECKOUT_QUOTE_EXPIRED");
        const common = {
          cart,
          quote,
          ...scope,
          guestSessionReference: input.guestSessionReference,
          cartReference: input.cartReference,
          cartVersion: input.cartVersion,
          quoteReference: input.quoteReference,
          observedAt: input.observedAt,
        };
        // WP-2423 M03: once this submission's Order exists its Cart is empty at a later version;
        // the payment clock then binds to the recorded submission, not to the Cart as it is now.
        const source =
          cart !== null && cart.aggregateVersion > input.cartVersion
            ? (quoteVersion === 2
                ? resolveConfiguredOrderedPickupCapacityCartSource
                : resolveOrderedPickupCapacityCartSource)({
                ...common,
                order: await orders.resolveSubmission(input.submissionReference),
                submissionReference: input.submissionReference,
              })
            : (quoteVersion === 2
                ? resolveConfiguredPickupCapacityCartSource
                : resolvePickupCapacityCartSource)(common);
        const policy = await options.unitPolicy.resolve({ ...scope, observedAt: input.observedAt });
        const units = deriveDefaultPickupCapacityUnits(
          source,
          policy,
          (text) => "sha256:" + createHash("sha256").update(text).digest("hex"),
        );
        const current = await capacity.resolve(input.observedAt);
        const validUntil = new Date(
          Math.min(Date.parse(source.validUntil), Date.parse(current.slot.endsAt)),
        ).toISOString();
        if (validUntil <= parseCanonicalInstant(options.now())) throw new Error();
        // WP-2423 DEC-COUNTER-WALK-UP-CAPACITY: a counter (Pos) Cart is only ever opened by staff
        // for a customer standing at the counter (or a paper order entered after an outage). It
        // counts against the pickup hour, so online orders are paced by it, but is never refused
        // because the hour is full.
        return Object.freeze({
          ...current,
          ...units,
          validUntil,
          ...(cart?.sourceChannel === "Pos" ? { admission: "WalkUp" as const } : {}),
        });
      } catch (error) {
        if (isQuoteExpired(error)) throw error;
        throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
      }
    },
  });
}

export function createCustomerPickupCapacitySources(options: CustomerPickupCapacitySourcesOptions) {
  return createVersionedCustomerPickupCapacitySources(options, 1);
}
export function createCustomerConfiguredPickupCapacitySources(
  options: CustomerPickupCapacitySourcesOptions,
) {
  return createVersionedCustomerPickupCapacitySources(options, 2);
}
