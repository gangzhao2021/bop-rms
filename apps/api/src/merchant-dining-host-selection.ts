import { readClosedRecord } from "@bop/identity";
import { createPostgresDiningHostTransferSelection, parseDiningReference } from "@rms/dining";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
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
      return await options.persistence.transactions.run(async (tx) => {
        const current = await resolve(
          tx,
          input.sessionCookie,
          "dining.host.transfer",
          authenticated.sessionReference,
        );
        if (!(await current.allowed())) throw new Error("denied");
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
              transaction === tx && (await current.allowed()) === true,
          },
        );
        const result = await owner.readCurrent({ diningSessionReference: reference });
        if (!(await current.allowed())) throw new Error("denied");
        return result;
      });
    } catch {
      throw new Error("DINING_HOST_SELECTION_UNAVAILABLE");
    }
  };
}
