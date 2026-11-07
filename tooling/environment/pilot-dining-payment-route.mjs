import {
  GuestSessionService,
  createPostgresGuestSessionEntryStore,
} from "../../packages/bop/identity/src/index.ts";
import {
  createPostgresDiningSessionOrderLookup,
  createPostgresOrderBatchIdentitySource,
} from "../../packages/rms/ordering/src/index.ts";
import { createPostgresDiningCheckoutCommitmentStore } from "../../packages/rms/dining/src/index.ts";
import { createCustomerCheckoutSessionRead } from "../../apps/api/dist/customer-checkout-session-read.js";
/** Selection only. Does not create a submission or Payment intent. */
export function createInternalDiningPaymentRoute(resources, checkout) {
  const reader = createCustomerCheckoutSessionRead(checkout.accessOptions);
  const scope = {
    tenantReference: resources.publicProfile.binding.tenantReference,
    ...resources.scope,
  };
  return {
    async resolve(input) {
      const credentials = {
        sessionCredential: input.sessionCredential,
        csrfCredential: input.csrfCredential,
      };
      const session = await reader.read({
          ...credentials,
          checkoutSessionReference: input.checkoutSessionReference,
        }),
        v = session.validation;
      if (v.orderType !== "DineIn") throw new Error("DINING_PAYMENT_ROUTE_DENIED");
      return resources.transactions.run(async (tx) => {
        const bound = { run: (work) => work(tx) },
          identity = new GuestSessionService({
            credentials: resources.credentials.sessions,
            binding: checkout.accessOptions.binding(tx),
            store: createPostgresGuestSessionEntryStore(bound, resources.scope),
            now: resources.now,
            admission: { consume: async () => null },
          });
        const guest = await identity.authorize(credentials);
        if (
          guest.channel !== "DineIn" ||
          guest.diningState !== "DiningBound" ||
          guest.sessionReference !== v.guestSessionReference ||
          guest.brandReference !== scope.brandReference ||
          guest.storeReference !== scope.storeReference
        )
          throw new Error("DINING_PAYMENT_ROUTE_DENIED");
        const current = async () =>
          JSON.stringify(await identity.authorize(credentials)) === JSON.stringify(guest);
        const commitment = await createPostgresDiningCheckoutCommitmentStore(bound, scope, {
          now: resources.now,
        }).loadSubmission(session.submissionReference);
        if (
          !commitment ||
          commitment.guestSessionReference !== guest.sessionReference ||
          commitment.diningSessionReference !== guest.diningSessionReference ||
          commitment.paymentOperationReference !== session.paymentOperationReference ||
          commitment.cartReference !== v.cartReference ||
          commitment.cartVersion !== v.cartVersion ||
          commitment.quoteReference !== v.quoteReference
        )
          throw new Error("DINING_PAYMENT_ROUTE_DENIED");
        const parent = await createPostgresDiningSessionOrderLookup({
          ...resources.scope,
          authorize: async (_tx, q) =>
            q.guestSessionReference === guest.sessionReference &&
            q.diningSessionReference === guest.diningSessionReference &&
            (await current()),
        }).load(tx, {
          diningSessionReference: guest.diningSessionReference,
          guestSessionReference: guest.sessionReference,
          observedAt: resources.now(),
        });
        if (parent !== null && parent !== commitment.orderReference)
          throw new Error("DINING_PAYMENT_PARENT_CONFLICT");
        const batch = await createPostgresOrderBatchIdentitySource({
          ...resources.scope,
          authorize: async (_tx, q) =>
            q.orderReference === commitment.orderReference &&
            q.orderBatchReference === commitment.orderBatchReference &&
            (await current()),
        }).load(tx, {
          orderReference: commitment.orderReference,
          orderBatchReference: commitment.orderBatchReference,
          observedAt: resources.now(),
        });
        if (
          batch &&
          (batch.submissionReference !== session.submissionReference ||
            batch.orderType !== "DineIn")
        )
          throw new Error("DINING_PAYMENT_ROUTE_DENIED");
        if (!(await current())) throw new Error("DINING_PAYMENT_ROUTE_DENIED");
        return {
          kind: batch?.kind ?? (parent === null ? "Initial" : "Additional"),
          orderReference: commitment.orderReference,
          session,
        };
      });
    },
  };
}
