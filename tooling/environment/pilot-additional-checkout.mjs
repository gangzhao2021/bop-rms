import {
  GuestSessionService,
  createPostgresGuestSessionEntryStore,
} from "../../packages/bop/identity/src/index.ts";
import {
  CheckoutValidationError,
  createPostgresDiningOrderPreparationSource,
  parseCartAggregate,
  parseAnyCartQuoteAttachment,
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
      const allocation = input.allocation;
      /** Whether this round was prepared already (by an earlier attempt or request). */
      const preparedBefore = async () => {
        const prior = await preparation.submissions.loadSubmission(allocation.submissionReference);
        if (prior === null) return false;
        if (prior.orderReference !== orderReference) throw new Error("ADDITIONAL_PARENT_CONFLICT");
        return true;
      };
      if (await preparedBefore()) return;
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
        quoteValue = await checkout.repository.loadQuote(allocation.cartReference);
      if (cart.diningSessionReference === null || cart.cartReference !== allocation.cartReference)
        throw new Error("ADDITIONAL_CART_UNAVAILABLE");
      // WP-2423 item 6: another guest's change or Quote: a fixed answer, never an outage to wait out.
      const movedOn = () => new CheckoutValidationError("CHECKOUT_CART_VERSION_CONFLICT");
      if (quoteValue === null || cart.aggregateVersion !== allocation.cartVersion) throw movedOn();
      // WP-2423: configured (version 2) quotes since 2026-10-08; a version-1 parse refused every
      // additional round with 503.
      const quote = parseAnyCartQuoteAttachment(quoteValue);
      if (
        quote.quoteReference !== allocation.quoteReference ||
        quote.cartVersion !== cart.aggregateVersion
      )
        throw movedOn();
      const readParent = () =>
        resources.transactions.run((transaction) =>
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
      let parent = await readParent();
      if (!parent) throw new Error("ADDITIONAL_PARENT_UNAVAILABLE");
      const sourceValidUntil = new Date(
        Math.min(
          Date.parse(quote.quoteExpiresAt),
          Date.parse(cart.lifecycle.idleExpiresAt),
          Date.parse(cart.lifecycle.absoluteExpiresAt),
        ),
      ).toISOString();
      const service = createPersistentAdditionalDiningPreparation({
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
      });
      /**
       * v15 b13 (DEC-ROUND-PREPARED-ON-CURRENT-ORDER): the round is prepared against the table's
       * Order as it stood when it was read. When the Order moves on meanwhile (the System takes an
       * expired unpaid round off, staff accept or cancel a round), the preparation refuses and
       * records nothing. It is then prepared once more against the Order as it is now, at most three
       * times in all; a refusal with the Order unchanged, or with no open Order any more, stands.
       */
      for (let attempt = 1; ; attempt += 1) {
        try {
          await service.prepareForOrdering({
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
          return;
        } catch (error) {
          if (attempt >= 3) throw error;
          let current;
          try {
            current = await readParent();
            // Prepared after all (its final check found the Order moved): it stands as it is.
            if (current && current.orderVersion !== parent.orderVersion && (await preparedBefore()))
              return;
          } catch {
            throw error;
          }
          if (!current || current.orderVersion === parent.orderVersion) throw error;
          parent = current;
        }
      }
    },
  };
}
