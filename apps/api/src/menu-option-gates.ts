import {
  createPostgresCurrentOptionBindingsStore,
  listBrandOptionSets,
  listBrandSkuChoices,
  loadBrandProduct,
  resolveCurrentCatalogSelectionRules,
  type MenuAggregate,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import { createPostgresCurrentOptionPriceStore, type CurrencyMetadataSnapshot } from "@rms/pricing";
import { optionRecipeCovered, type RecipeAuthoringTransaction } from "@rms/recipe";

/** The pricing channel customer Quotes use (customer-menu-store-facts, pilot Quote). */
const quoteChannel = "CUSTOMER_WEB";

/**
 * WP-2423 slice 4.3: the options a menu would offer that have no published price for one of its
 * order types at the Store (the Quote's pricing channel). A menu with any is not submitted for
 * review, so an option never reaches customers unpriced. Reads only; the caller owns the
 * transaction and has admitted the Actor.
 */
export async function unpricedMenuOptions(
  tx: ProductLifecycleTransaction,
  input: {
    readonly owner: { readonly brandReference: string; readonly storeReference: string };
    readonly currencyMetadata: CurrencyMetadataSnapshot;
    readonly observedAt: string;
    readonly menu: Pick<MenuAggregate["draft"], "sections" | "channelCodes" | "orderTypeCodes">;
  },
): Promise<readonly { readonly skuReference: string; readonly optionReference: string }[]> {
  const { owner, observedAt, menu } = input;
  const run = { run: <T>(work: (t: never) => Promise<T>) => work(tx as never) };
  const skus = await listBrandSkuChoices(tx as never, owner);
  const orderTypes = menu.orderTypeCodes.flatMap((code) =>
    code === "PICKUP" ? ["Pickup" as const] : code === "DINE_IN" ? ["DineIn" as const] : [],
  );
  const prices = createPostgresCurrentOptionPriceStore(
    run,
    { brandReference: owner.brandReference, storeReference: owner.storeReference },
    input.currencyMetadata,
  );
  const placed = new Set(
    menu.sections.flatMap((section) =>
      section.placements.map((placement) => String(placement.sellableReference)),
    ),
  );
  const missing: { skuReference: string; optionReference: string }[] = [];
  for (const skuReference of placed) {
    const sku = skus.find((item) => item.skuReference === skuReference);
    if (sku === undefined) continue;
    const product = await loadBrandProduct(
      tx as never,
      { brandReference: owner.brandReference },
      sku.productReference,
    );
    if (product === null || product.draft.optionBindings.length === 0) continue;
    for (const channelCode of menu.channelCodes) {
      const source = await createPostgresCurrentOptionBindingsStore(run, {
        brandReference: owner.brandReference,
      }).load({
        sellableReference: skuReference,
        productVersionReference: product.draft.versionReference,
        channelCode,
        observedAt,
      });
      const rules = resolveCurrentCatalogSelectionRules(source?.bindings ?? [], {
        brandReference: owner.brandReference,
        sellableReference: skuReference,
        channelCode,
        observedAt,
      });
      for (const rule of rules)
        for (const option of rule.options)
          for (const orderType of orderTypes) {
            const found = await prices.load({
              bindingReference: rule.bindingReference,
              optionReference: option.optionReference,
              skuReference,
              storeGroupReference: null,
              regionReference: null,
              channelCode: quoteChannel,
              orderType,
              observedAt,
            });
            if (
              found.length === 0 &&
              !missing.some(
                (item) =>
                  item.skuReference === skuReference &&
                  item.optionReference === option.optionReference,
              )
            )
              missing.push({ skuReference, optionReference: String(option.optionReference) });
          }
    }
  }
  return missing;
}

/**
 * WP-2423 slice 4.4: the options a menu would offer whose recipe change is not published for every
 * recipe now bound to the item and every quantity a customer may choose. Without one the order's
 * stock, kitchen instructions and allergen disclosure would be unknown, so such a menu is not
 * submitted for review. Reads only; the caller owns the transaction and has admitted the Actor.
 */
export async function menuOptionsWithoutRecipes(
  tx: ProductLifecycleTransaction,
  input: {
    readonly owner: { readonly brandReference: string; readonly storeReference: string };
    readonly observedAt: string;
    readonly menu: Pick<MenuAggregate["draft"], "sections">;
  },
): Promise<readonly { readonly skuReference: string; readonly optionReference: string }[]> {
  const { owner, observedAt, menu } = input;
  const skus = await listBrandSkuChoices(tx as never, owner);
  const sets = await listBrandOptionSets(tx, { brandReference: owner.brandReference });
  const placed = new Set(
    menu.sections.flatMap((section) =>
      section.placements.map((placement) => String(placement.sellableReference)),
    ),
  );
  const missing: { skuReference: string; optionReference: string }[] = [];
  for (const skuReference of placed) {
    const sku = skus.find((item) => item.skuReference === skuReference);
    if (sku === undefined) continue;
    const product = await loadBrandProduct(
      tx as never,
      { brandReference: owner.brandReference },
      sku.productReference,
    );
    if (product === null) continue;
    for (const binding of product.draft.optionBindings) {
      const set = sets.find((item) => item.optionSetReference === binding.optionSetReference);
      if (set === undefined) continue;
      const most = set.draft.allowRepeatedOption ? set.draft.perOptionMaximumQuantity : 1;
      for (const option of set.draft.options)
        if (
          option.lifecycle === "Active" &&
          binding.enabledOptionReferences.includes(option.optionReference) &&
          !(await optionRecipeCovered(
            tx as unknown as RecipeAuthoringTransaction,
            owner,
            {
              bindingReference: String(binding.bindingReference),
              optionReference: String(option.optionReference),
              skuReferences: [skuReference],
              quantities: Array.from({ length: most }, (_, index) => index + 1),
            },
            observedAt,
          ))
        )
          missing.push({ skuReference, optionReference: String(option.optionReference) });
    }
  }
  return missing;
}
