import {
  GuestSessionService,
  parseCanonicalInstant,
  parseGuestRawCredential,
  readClosedRecord,
  type GuestSessionServiceOptions,
} from "@bop/identity";
import {
  CartError,
  createCheckoutDetailsService,
  createCheckoutDetailsReadService,
  createCheckoutPolicyPresentationSource,
  type CheckoutPolicyDocumentPort,
  type CheckoutPolicyPresentation,
  createPostgresCartQueryStore,
  createPostgresCartQuoteReader,
  createPostgresConfiguredCartQuoteReader,
  createPostgresCheckoutDetailsStore,
  createPostgresPickupCartBindingReader,
  parseOrderingReference,
  type CartQueryTransactionRunner,
  type CheckoutDetailsPorts,
} from "@rms/ordering";
import {
  createCustomerDiningCheckoutIdentity,
  type CustomerDiningCheckoutCompositionOptions,
} from "./customer-dining-checkout-composition.js";

export interface CustomerCheckoutDetailsOptions {
  readonly scope: Readonly<{ brandReference: string; storeReference: string }>;
  readonly quoteVersion: 1 | 2;
  readonly cartTransactions: CartQueryTransactionRunner;
  readonly detailsTransactions: CartQueryTransactionRunner;
  readonly policies: CheckoutDetailsPorts["policies"];
  readonly policyDocuments?: CheckoutPolicyDocumentPort;
  readonly audit: (
    input: Readonly<{
      brandReference: string;
      storeReference: string;
      guestSessionReference: string;
      cartReference: string;
      detailsReference: string;
      operationReference: string;
      observedAt: string;
    }>,
  ) => Promise<unknown>;
  readonly now: () => string;
}
function composition(
  options: CustomerCheckoutDetailsOptions,
  sessions: Pick<GuestSessionService, "authorize">,
  mode: "DineIn" | "Pickup",
) {
  const scope = Object.freeze({
    brandReference: parseOrderingReference(options.scope.brandReference),
    storeReference: parseOrderingReference(options.scope.storeReference),
  });
  const carts = createPostgresCartQueryStore(options.cartTransactions, scope);
  const quotes = (
    options.quoteVersion === 2
      ? createPostgresConfiguredCartQuoteReader
      : createPostgresCartQuoteReader
  )(options.cartTransactions, scope);
  const details = createPostgresCheckoutDetailsStore(options.detailsTransactions, scope);
  const binding =
    mode === "Pickup"
      ? createPostgresPickupCartBindingReader(options.cartTransactions, scope)
      : null;
  const result = Object.freeze({
    async read(value: unknown) {
      const envelope = readClosedRecord(value, ["sessionCredential", "csrfCredential", "query"]);
      const credentials = Object.freeze({
        sessionCredential: parseGuestRawCredential(envelope.sessionCredential),
        csrfCredential: parseGuestRawCredential(envelope.csrfCredential),
      });
      return createCheckoutDetailsReadService({
        now: options.now,
        repository: { loadCart: carts.load, loadLatest: details.loadLatest },
        authorization: {
          async authorize(input) {
            try {
              const guest = await sessions.authorize({
                ...credentials,
                observedAt: input.observedAt,
              });
              if (
                String(guest.brandReference) !== scope.brandReference ||
                String(guest.storeReference) !== scope.storeReference ||
                guest.channel !== mode
              )
                return null;
              if (binding !== null) {
                const current = await binding.current(guest, input.observedAt);
                if (current === null || current.cartReference !== input.cartReference) return null;
              }
              return guest;
            } catch {
              return null;
            }
          },
        },
      }).read(envelope.query);
    },
    async policy(value: unknown): Promise<CheckoutPolicyPresentation> {
      const initial = await result.read(value);
      const view = await createCheckoutPolicyPresentationSource({
        now: options.now,
        policies: options.policies,
        documents: options.policyDocuments,
      }).read({
        ...scope,
        cartReference: initial.cartReference,
        cartVersion: initial.cartVersion,
        orderType: initial.orderType,
      });
      const current = await result.read(value);
      if (
        current.cartReference !== initial.cartReference ||
        current.cartVersion !== initial.cartVersion ||
        current.orderType !== initial.orderType ||
        options.now() >= view.validUntil
      )
        throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
      return view;
    },
    async save(value: unknown) {
      const envelope = readClosedRecord(value, ["sessionCredential", "csrfCredential", "command"]);
      const credentials = Object.freeze({
        sessionCredential: parseGuestRawCredential(envelope.sessionCredential),
        csrfCredential: parseGuestRawCredential(envelope.csrfCredential),
      });
      const command = readClosedRecord(envelope.command, [
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
      if (command.quoteVersion !== options.quoteVersion) throw new CartError("CART_INPUT_INVALID");
      return createCheckoutDetailsService({
        now: options.now,
        policies: options.policies,
        repository: {
          loadCart: carts.load,
          loadQuote: (cartReference) =>
            quotes.loadLatest({
              cartReference,
              cartVersion: Number(command.cartVersion),
              observedAt: options.now(),
            }),
          resolveOperation: details.resolveOperation,
          save: details.save,
        },
        authorization: {
          async authorize(input) {
            try {
              const guest = await sessions.authorize({
                ...credentials,
                observedAt: input.observedAt,
              });
              if (
                String(guest.brandReference) !== scope.brandReference ||
                String(guest.storeReference) !== scope.storeReference ||
                guest.channel !== mode
              )
                return null;
              if (binding !== null) {
                const cart = await binding.current(guest, input.observedAt);
                if (cart === null || cart.cartReference !== input.cartReference) return null;
              }
              return {
                guestSession: guest,
                audit: await options.audit({
                  ...input,
                  ...scope,
                  guestSessionReference: String(guest.sessionReference),
                }),
              };
            } catch {
              return null;
            }
          },
        },
      }).save(command);
    },
  });
  return result;
}
export function createCustomerPickupCheckoutDetailsComposition(
  options: CustomerCheckoutDetailsOptions & {
    readonly session: Omit<GuestSessionServiceOptions, "admission" | "now">;
  },
) {
  return composition(
    options,
    new GuestSessionService({
      ...options.session,
      admission: { consume: async () => null },
      now: options.now,
    }),
    "Pickup",
  );
}
export function createCustomerDiningCheckoutDetailsComposition(
  options: CustomerCheckoutDetailsOptions & {
    readonly identity: CustomerDiningCheckoutCompositionOptions;
  },
) {
  if (
    options.identity.scope.brandReference !== options.scope.brandReference ||
    options.identity.scope.storeReference !== options.scope.storeReference
  )
    throw new CartError("CART_INPUT_INVALID");
  return composition(
    options,
    createCustomerDiningCheckoutIdentity(options.identity, options.scope, () =>
      parseCanonicalInstant(options.now()),
    ),
    "DineIn",
  );
}
