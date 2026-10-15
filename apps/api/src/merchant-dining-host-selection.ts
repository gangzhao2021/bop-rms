import { readClosedRecord } from "@bop/identity";
import { createPostgresDiningHostTransferSelection, parseDiningReference } from "@rms/dining";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
export function createMerchantDiningHostSelection(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; query: unknown }) => {
    try {
      const authenticated = await options.authentication.authorize(input),
        raw = readClosedRecord(input.query, ["diningSessionReference"]),
        reference = parseDiningReference(raw.diningSessionReference);
      const denied = (): never => {
        throw new Error("denied");
      };
      // WP-2423: one authorized run. The caller and `dining.host.transfer` are resolved in full
      // once at the start and once more before the reply; the owner read in between takes the
      // run's no-query guard.
      return await options.persistence.transactions.run((tx) =>
        withMerchantTransactionAuthorization(
          {
            transaction: tx,
            resolve: async () => {
              const current = await resolve(
                tx,
                input.sessionCookie,
                "dining.host.transfer",
                authenticated.sessionReference,
              );
              if ((await current.allowed()) !== true) return denied();
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied,
          },
          async (authority) => {
            const current = authority.scope;
            const owner = createPostgresDiningHostTransferSelection(
              { run: (work) => work(tx) },
              {
                scope: {
                  tenantReference: current.selected.tenantReference,
                  brandReference: current.context.brand.brandReference,
                  storeReference: current.store.storeReference,
                },
                now: options.persistence.now,
                authorize: async (transaction) =>
                  transaction === tx && (await authority.guard(transaction)),
              },
            );
            return owner.readCurrent({ diningSessionReference: reference });
          },
        ),
      );
    } catch {
      throw new Error("DINING_HOST_SELECTION_UNAVAILABLE");
    }
  };
}
