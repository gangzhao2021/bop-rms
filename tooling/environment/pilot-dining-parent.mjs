import {
  GuestSessionService,
  createPostgresGuestSessionEntryStore,
} from "../../packages/bop/identity/src/index.ts";
import { createPostgresDiningSessionOrderLookup } from "../../packages/rms/ordering/src/index.ts";
export function createInternalDiningParent(resources, entry) {
  return {
    async resolve(credentials) {
      return resources.transactions.run(async (tx) => {
        const bound = { run: (work) => work(tx) },
          identity = new GuestSessionService({
            credentials: resources.credentials.sessions,
            binding: entry.binding(bound),
            store: createPostgresGuestSessionEntryStore(bound, resources.scope),
            now: resources.now,
            admission: { consume: async () => null },
          });
        const guest = await identity.authorize(credentials);
        if (
          guest.channel !== "DineIn" ||
          guest.diningState !== "DiningBound" ||
          !guest.diningSessionReference ||
          guest.brandReference !== resources.scope.brandReference ||
          guest.storeReference !== resources.scope.storeReference
        )
          throw new Error("DINING_PARENT_DENIED");
        return createPostgresDiningSessionOrderLookup({
          ...resources.scope,
          authorize: async (_tx, query) => {
            const current = await identity.authorize(credentials);
            return (
              JSON.stringify(current) === JSON.stringify(guest) &&
              query.guestSessionReference === guest.sessionReference &&
              query.diningSessionReference === guest.diningSessionReference
            );
          },
        }).load(tx, {
          diningSessionReference: guest.diningSessionReference,
          guestSessionReference: guest.sessionReference,
          observedAt: resources.now(),
        });
      });
    },
  };
}
