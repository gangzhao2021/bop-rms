import {
  GuestSessionService,
  createPostgresGuestSessionEntryStore,
} from "../../packages/bop/identity/src/index.ts";
import {
  createPostgresDiningOrderPreparationSource,
  parseCartAggregate,
  parseCartQuoteAttachment,
} from "../../packages/rms/ordering/src/index.ts";
import { createPersistentAdditionalDiningPreparation } from "../../apps/api/dist/customer-additional-dining-preparation.js";
import { createInternalDiningParent } from "./pilot-dining-parent.mjs";
export function createInternalAdditionalCheckout(resources, entry, preparation) {
  const lookup = createInternalDiningParent(resources, entry);
  return {
    async prepare(input, checkout) {
      const credentials = {
        sessionCredential: input.sessionCredential,
        csrfCredential: input.csrfCredential,
      };
      const orderReference = await lookup.resolve(credentials);
      if (orderReference === null) return;
      const allocation = input.allocation,
        prior = await preparation.submissions.loadSubmission(allocation.submissionReference);
      if (prior !== null) {
        if (prior.orderReference !== orderReference) throw new Error("ADDITIONAL_PARENT_CONFLICT");
        return;
      }
      const authorizeOrder = async (tx, query) => {
        const bound = { run: (work) => work(tx) },
          identity = new GuestSessionService({
            credentials: resources.credentials.sessions,
            binding: entry.binding(bound),
            store: createPostgresGuestSessionEntryStore(bound, resources.scope),
            now: resources.now,
            admission: { consume: async () => null },
          });
        const guest = await identity.authorize(credentials);
        return (
          guest.channel === "DineIn" &&
          guest.diningState === "DiningBound" &&
          guest.brandReference === resources.scope.brandReference &&
          guest.storeReference === resources.scope.storeReference &&
          guest.diningSessionReference === query.diningSessionReference &&
          guest.sessionReference === query.guestSessionReference &&
          query.orderReference === orderReference
        );
      };
      const cart = parseCartAggregate(await checkout.repository.loadCart(allocation.cartReference)),
        quote = parseCartQuoteAttachment(
          await checkout.repository.loadQuote(allocation.cartReference),
        );
      if (
        cart.diningSessionReference === null ||
        cart.cartReference !== allocation.cartReference ||
        cart.aggregateVersion !== allocation.cartVersion ||
        quote.quoteReference !== allocation.quoteReference ||
        quote.cartVersion !== cart.aggregateVersion
      )
        throw new Error("ADDITIONAL_CART_CHANGED");
      const parent = await resources.transactions.run((transaction) =>
        createPostgresDiningOrderPreparationSource({
          ...resources.scope,
          authorize: authorizeOrder,
        }).resolveAdditionalParent({
          transaction,
          ...resources.scope,
          orderReference,
          diningSessionReference: cart.diningSessionReference,
          guestSessionReference: allocation.guestSessionReference,
          observedAt: resources.now(),
        }),
      );
      if (!parent) throw new Error("ADDITIONAL_PARENT_UNAVAILABLE");
      const sourceValidUntil = new Date(
        Math.min(
          Date.parse(quote.quoteExpiresAt),
          Date.parse(cart.lifecycle.idleExpiresAt),
          Date.parse(cart.lifecycle.absoluteExpiresAt),
        ),
      ).toISOString();
      await createPersistentAdditionalDiningPreparation({
        preparation: {
          ...preparation,
          references: {
            generate: (kind) =>
              kind === "PaymentOperation"
                ? allocation.paymentOperationReference
                : preparation.references.generate(kind),
          },
        },
        transactions: resources.transactions,
        authorizeOrder,
      }).prepareForOrdering({
        ...credentials,
        orderReference,
        expectedOrderVersion: parent.orderVersion,
        intent: {
          submissionReference: allocation.submissionReference,
          cartReference: allocation.cartReference,
          cartVersion: allocation.cartVersion,
          quoteReference: allocation.quoteReference,
          sourceValidUntil,
        },
      });
    },
  };
}
