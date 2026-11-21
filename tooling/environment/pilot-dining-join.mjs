import { createCustomerDiningJoinComposition } from "../../apps/api/dist/customer-dining-join-composition.js";
import { createPostgresGuestSessionEntryStore } from "../../packages/bop/identity/src/index.ts";
import { createAbuseBudgetConsumer } from "../../packages/database/src/index.ts";
export function createInternalDiningJoin(resources, entry, runtime) {
  const composition = createCustomerDiningJoinComposition({
    scope: resources.scope,
    session: {
      ...entry.entry.session,
      store: createPostgresGuestSessionEntryStore(resources.transactions, resources.scope),
    },
    dining: { store: runtime.stores.join, credentials: runtime.credentials, pepperVersion: 1 },
    contexts: entry.binding(resources.transactions),
    now: resources.now,
  });
  return {
    join: (input) =>
      composition.join(input, createInternalDiningJoinRequestContext(resources, runtime)),
  };
}

export function createInternalDiningJoinRequestContext(resources, runtime) {
  const current = (context) => context.observedAt < resources.publicProfile.binding.validUntil;
  return {
    abuse: {
      // v15 batch 39 (b40): a QR join presents the code Dining issued to this guest a moment ago,
      // never a guess: it takes nothing from the wrong-code budget below. Before, every attempt of
      // every tap did (up to six a tap, successes included), and a guest whose table had just
      // opened was told "Too many tries" for minutes. QR joins stay bounded by the table's own
      // issue budget (diningQrJoinBudget).
      admitIssued: async (context) => (current(context) ? "Admitted" : "Cooldown"),
      // A typed code (or invitation link) is a guess: each one counts, 10 per 5 minutes per guest.
      admit: async (context) => {
        if (!current(context)) return "Cooldown";
        const hash = runtime.credentials.hashJoinBudget(
          resources.scope.storeReference + ":" + context.guestSessionReference + ":" + context.kind,
        );
        const result = await createAbuseBudgetConsumer({
          bucketClass: "DINING_JOIN_FAILURE",
          windowSeconds: 300,
          limitCount: 10,
          now: () => context.observedAt,
          query: async (sql, values) => {
            const connection = await resources.database.acquire();
            try {
              return await connection.query(sql, [...values]);
            } finally {
              connection.release();
            }
          },
        }).consume(hash);
        return result.allowed ? "Admitted" : "Cooldown";
      },
    },
  };
}
