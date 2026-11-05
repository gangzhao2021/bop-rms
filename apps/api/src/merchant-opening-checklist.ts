import { currentAllergenRegistry, listBrandMenus } from "@rms/catalog";
import { listStoreMembers } from "@bop/membership";
import { currentStoreTaxConfigurationReference } from "@rms/pricing";
import { hasOwnerPublishedStoreSetup } from "@rms/store";
import type { MerchantBffService } from "./merchant-bff-contract.js";
import { businessTransaction } from "./merchant-ordinary-refund-approval.js";
import {
  createMerchantApprovalHolders,
  merchantBrandApprovalHolders,
  type ResolveContext,
} from "./merchant-sole-operator.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type StoreScope = Awaited<ReturnType<ReturnType<typeof createMerchantStoreScope>>>;
export class MerchantOpeningApproversError extends Error {
  constructor() {
    super("MERCHANT_OPENING_APPROVERS_DENIED");
    this.name = "MerchantOpeningApproversError";
  }
}
/**
 * WP-2423 item 13 ③: what a new merchant's Owner still has to do before guests can order, for the
 * Home page's opening list. Yes or no only, from each fact's owner; the other steps come from the
 * reads the Store setup page already makes.
 *
 * WP-2423 item 14: who else holds each approval a first opening needs, for the Owner's opening page.
 * Named whatever the sole-operator setting says (the gates only name them while it is on), so an
 * Owner is never asked to approve alone when a second person must, and never left waiting for nobody.
 */
export function createMerchantOpeningChecklist(options: {
  readonly persistence: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  /** The run's workforce context, answering for Owner access and Store configuration approval. */
  readonly approvalContext?: (
    tx: ReturnType<typeof businessTransaction>,
    scope: StoreScope,
  ) => ResolveContext;
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
        const at = options.persistence.now();
        const tax = await currentStoreTaxConfigurationReference(tx as never, owner, at);
        return Object.freeze({
          setupPublished: await hasOwnerPublishedStoreSetup(tx, owner),
          allergenList: (await currentAllergenRegistry(tx as never, owner)) !== null,
          menuListed: (await listBrandMenus(tx as never, owner)).some(
            (menu) => menu.publication?.state === "Published",
          ),
          // The Store's own tax rates: BOP support sets these up, the Owner waits for them.
          taxRatesSet: tax !== null && tax.evidenceValidUntil > at,
        });
      }),
    approvers: (input: { readonly sessionCookie: unknown }) => {
      const approvalContext = options.approvalContext;
      if (approvalContext === undefined) throw new MerchantOpeningApproversError();
      return options.persistence.transactions.run(async (transaction) => {
        const scope = await resolveScope(transaction, input.sessionCookie, "organization.manage");
        if ((await scope.allowed()) !== true) throw new MerchantOpeningApproversError();
        const tx = businessTransaction(transaction);
        const actor = String(scope.actorReference);
        const store = {
          tenantReference: scope.selected.tenantReference,
          brandReference: String(scope.context.brand.brandReference),
          storeReference: String(scope.store.storeReference),
        };
        const observedAt = options.persistence.now();
        const holders = createMerchantApprovalHolders({
          resolveContext: approvalContext(tx, scope),
        });
        const held = (permissionCode: string) =>
          holders(tx, { ...store, permissionCode, observedAt });
        const receiptTemplate = await held("organization.manage");
        const storeSetup = await held("store.service.approve");
        const members = await listStoreMembers(tx, store);
        // Last: this read leaves no Store selected in the transaction.
        const allergenList = await merchantBrandApprovalHolders(tx, {
          brandReference: store.brandReference,
          permissionCode: "catalog.allergen_registry.manage",
          observedAt,
        });
        if ((await scope.allowed()) !== true) throw new MerchantOpeningApproversError();
        const others = (references: readonly string[]) =>
          Object.freeze(
            references
              .filter((reference) => reference !== actor)
              .map((reference) =>
                Object.freeze({
                  displayName:
                    members.find((member) => member.actorReference === reference)?.displayName ??
                    null,
                }),
              ),
          );
        return Object.freeze({
          receiptTemplate: others(receiptTemplate),
          storeSetup: others(storeSetup),
          allergenList: others(allergenList),
        });
      });
    },
  });
}
