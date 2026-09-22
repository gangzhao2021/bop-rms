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
  return {
    abuse: {
      admit: async (context) => {
        if (context.observedAt >= resources.publicProfile.binding.validUntil) return "Cooldown";
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
