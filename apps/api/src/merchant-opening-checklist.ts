import { currentAllergenRegistry, listBrandMenus } from "@rms/catalog";
import { hasOwnerPublishedStoreSetup } from "@rms/store";
import type { MerchantBffService } from "./merchant-bff-contract.js";
import { businessTransaction } from "./merchant-ordinary-refund-approval.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/**
 * WP-2423 item 13 ③: what a new merchant's Owner still has to do before guests can order, for the
 * Home page's opening list. Yes or no only, from each fact's owner; the other steps come from the
 * reads the Store setup page already makes.
 */
export function createMerchantOpeningChecklist(options: {
  readonly persistence: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return Object.freeze({
    read: (input: { readonly sessionCookie: unknown }) =>
      options.persistence.transactions.run(async (transaction) => {
        const scope = await resolveScope(transaction, input.sessionCookie, "merchant.access");
        if ((await scope.allowed()) !== true) throw new Error("MERCHANT_OPENING_LIST_DENIED");
        const tx = businessTransaction(transaction);
        const owner = {
          tenantReference: scope.selected.tenantReference,
          brandReference: String(scope.context.brand.brandReference),
          storeReference: String(scope.store.storeReference),
        };
        return Object.freeze({
          setupPublished: await hasOwnerPublishedStoreSetup(tx, owner),
          allergenList: (await currentAllergenRegistry(tx as never, owner)) !== null,
          menuListed: (await listBrandMenus(tx as never, owner)).some(
            (menu) => menu.publication?.state === "Published",
          ),
        });
      }),
  });
}
