import { createHash } from "node:crypto";
import { readClosedRecord, parseCanonicalInstant, GuestSessionError } from "@bop/identity";
import {
  createPostgresCartQueryStore,
  createPostgresCartQuoteReader,
  createPostgresConfiguredCartQuoteReader,
  resolveConfiguredPickupCapacityCartSource,
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
        const source = (
          quoteVersion === 2
            ? resolveConfiguredPickupCapacityCartSource
            : resolvePickupCapacityCartSource
        )({
          cart,
          quote,
          ...scope,
          guestSessionReference: input.guestSessionReference,
          cartReference: input.cartReference,
          cartVersion: input.cartVersion,
          quoteReference: input.quoteReference,
          observedAt: input.observedAt,
        });
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
        return Object.freeze({ ...current, ...units, validUntil });
      } catch {
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
