import { parseGuestRawCredential, readClosedRecord } from "@bop/identity";
import {
  CartError,
  parseCartAggregate,
  parseOrderingInstant,
  parseOrderingReference,
} from "../domain/cart.js";
import { parseCartQuoteAttachment } from "../domain/cart-quote-attachment.js";
import { assertCartLifecycleActive } from "../domain/cart-lifecycle.js";
import { createCartQuoteAttachmentService } from "./cart-quote-attachment-service.js";
import {
  createDiningCartAuthority,
  type DiningCartAuthorityPorts,
  type DiningCartAuthoritySnapshot,
} from "./dining-cart-authority.js";
import type { PickupCartQuoteOptions } from "./pickup-cart-quote-service.js";

export interface DiningCartQuoteOptions extends Omit<PickupCartQuoteOptions, "binding"> {
  readonly participation: DiningCartAuthorityPorts["participation"];
}
function denied(): never {
  throw new CartError("CART_PERMISSION_DENIED");
}
function unavailable(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function same(first: DiningCartAuthoritySnapshot, next: DiningCartAuthoritySnapshot) {
  if (next.observedAt < first.observedAt) return unavailable();
  for (const key of [
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
  ] as const)
    if (first.session[key] !== next.session[key]) return denied();
  for (const key of [
    "brandReference",
    "storeReference",
    "diningSessionReference",
    "participantReference",
    "tableReference",
    "tableAssignmentVersion",
    "diningSessionVersion",
    "participantVersion",
  ] as const)
    if (first.participation[key] !== next.participation[key]) return denied();
}

/** Current Dining observations; not an atomic lease against session closing. */
export function createDiningCartQuoteService(options: DiningCartQuoteOptions) {
  const scope = readClosedRecord(options.scope, ["brandReference", "storeReference"]);
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference);
  return Object.freeze({
    async attach(value: unknown) {
      let guardFailure: CartError | undefined;
      try {
        const raw = readClosedRecord(value, [
          "sessionCredential",
          "csrfCredential",
          "cartReference",
          "expectedCartVersion",
          "operationReference",
        ]);
        const credential = parseGuestRawCredential(raw.sessionCredential);
        const csrf = parseGuestRawCredential(raw.csrfCredential);
        const cartReference = parseOrderingReference(raw.cartReference);
        const operationReference = parseOrderingReference(raw.operationReference);
        if (
          typeof raw.expectedCartVersion !== "number" ||
          !Number.isSafeInteger(raw.expectedCartVersion) ||
          raw.expectedCartVersion < 1 ||
          raw.expectedCartVersion > 2147483647
        )
          throw new CartError("CART_INPUT_INVALID");
        const expectedCartVersion = raw.expectedCartVersion;
        let lastAt: string | undefined;
        const now = () => {
          const current = parseOrderingInstant(options.now());
          if (lastAt !== undefined && current < lastAt) return unavailable();
          lastAt = current;
          return current;
        };
        const authority = createDiningCartAuthority({
          scope: { brandReference: brand, storeReference: store },
          participation: options.participation,
          now,
          sessions: {
            resolve: ({ sessionCredential, observedAt }) =>
              options.sessions.authorize({
                sessionCredential,
                csrfCredential: csrf,
                observedAt,
              }),
          },
        });
        const result = await authority.run(credential, async (first) => {
          async function guarded<T>(effect: (current: DiningCartAuthoritySnapshot) => Promise<T>) {
            try {
              const checked = await authority.run(credential, async (current) => {
                same(first, current);
                return effect(current);
              });
              same(first, checked.authority);
              return checked.value;
            } catch (error) {
              if (error instanceof CartError) guardFailure = error;
              throw error;
            }
          }
          function owned(value: unknown, at: string) {
            const cart = parseCartAggregate(value);
            if (
              cart.brandReference !== brand ||
              cart.storeReference !== store ||
              cart.cartReference !== cartReference ||
              cart.orderType !== "DineIn" ||
              cart.diningSessionReference !== first.participation.diningSessionReference ||
              !["Qr", "Web"].includes(cart.sourceChannel) ||
              cart.updatedAt > at
            )
              return unavailable();
            return cart;
          }
          const initial = await guarded(async (current) => {
            const loaded = await options.repository.loadCart(cartReference);
            if (loaded === null) throw new CartError("CART_UNAVAILABLE");
            return owned(loaded, current.observedAt);
          });
          let currentCart = initial;
          const identity = Object.freeze({
            operationReference,
            guestSessionReference: parseOrderingReference(first.session.sessionReference),
          });
          const audit = options.audit({
            action: "AttachQuote",
            brandReference: brand,
            storeReference: store,
            sessionReference: identity.guestSessionReference,
            cartReference,
            operationReference,
            observedAt: first.observedAt,
          });
          const service = createCartQuoteAttachmentService({
            authorization: { authorize: async () => ({ guestSession: first.session, audit }) },
            references: options.references,
            pricing: {
              quoteCart: (input) =>
                guarded(async (current) => {
                  assertCartLifecycleActive(currentCart.lifecycle, current.observedAt);
                  return options.pricing.quoteCart(input, identity);
                }),
            },
            repository: {
              resolveOperation: (reference) =>
                guarded(async () => {
                  const prior = await options.repository.resolveOperation(reference);
                  return prior === null ? null : parseCartQuoteAttachment(prior);
                }),
              loadCart: (reference) =>
                guarded(async (current) => {
                  const loaded = await options.repository.loadCart(reference);
                  if (loaded === null) return null;
                  const next = owned(loaded, current.observedAt);
                  if (
                    next.aggregateVersion < initial.aggregateVersion ||
                    next.createdAt !== initial.createdAt ||
                    next.updatedAt < initial.updatedAt ||
                    next.sourceChannel !== initial.sourceChannel ||
                    (next.aggregateVersion === initial.aggregateVersion &&
                      JSON.stringify(next) !== JSON.stringify(initial))
                  )
                    return unavailable();
                  currentCart = next;
                  return next;
                }),
              attach: (command) =>
                guarded(async (current) => {
                  assertCartLifecycleActive(currentCart.lifecycle, current.observedAt);
                  if (current.observedAt >= command.attachment.quoteExpiresAt)
                    throw new CartError("CART_QUOTE_EXPIRED");
                  return parseCartQuoteAttachment(await options.repository.attach(command));
                }),
            },
          });
          return service.attach({
            cartReference,
            expectedCartVersion,
            operationReference,
            requestedAt: first.observedAt,
          });
        });
        if (result.authority.observedAt >= result.value.attachment.idempotencyExpiresAt)
          throw new CartError("CART_IDEMPOTENCY_CONFLICT");
        return result.value;
      } catch (error) {
        if (guardFailure !== undefined) throw guardFailure;
        if (error instanceof CartError) throw error;
        return unavailable();
      }
    },
  });
}
