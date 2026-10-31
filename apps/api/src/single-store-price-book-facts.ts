import { createPostgresMenuPricingFactsSource } from "@rms/catalog";
import {
  createPostgresMerchantOrganizationSource,
  parseBrandReference,
  parseStoreReference,
} from "@bop/tenant";
import {
  parsePricingReference,
  parsePricingCode,
  type PriceBookSnapshot,
  type PriceResolutionContext,
} from "@rms/pricing";
import type { ConsumerTransaction } from "@bop/eventing";

/** Immediate single-store pilot publication facts, using actual owner sources.
 * Brand/this Store price entries are supported. Broader Region/StoreGroup books
 * require their own authoritative scope adapter, never guessed membership.
 */
export function createSingleStorePriceBookFacts(options: {
  brandReference: string;
  storeReference: string;
  menuReference: string;
  now(): string;
}) {
  const brand = parseBrandReference(options.brandReference);
  const store = parseStoreReference(options.storeReference);
  const menu = createPostgresMenuPricingFactsSource(options);
  const load = async (tx: ConsumerTransaction) => {
    const at = options.now();
    const organization = createPostgresMerchantOrganizationSource(tx, {
      brandReference: brand,
      storeReference: store,
      observedAt: at,
    });
    const currentBrand = await organization.getBrand(brand);
    const currentStore = await organization.getStore(store);
    const currentMenu = await menu.load(tx, at);
    if (
      !currentBrand ||
      !currentStore ||
      !currentMenu ||
      !currentMenu.storeReferences.includes(store) ||
      currentMenu.storeReferences.length !== 1 ||
      currentBrand.currencyCode !== currentStore.currencyCode
    )
      return null;
    return { brand: currentBrand, store: currentStore, menu: currentMenu, at };
  };
  return Object.freeze({
    async validateFacts(transaction: ConsumerTransaction, snapshot: PriceBookSnapshot) {
      const facts = await load(transaction);
      if (
        !facts ||
        String(snapshot.brandReference) !== brand ||
        snapshot.currencyMetadata.currencyCode !== facts.brand.currencyCode
      )
        return false;
      if (snapshot.lifecycle === "Archived") return true;
      return snapshot.entries.every((entry) => {
        const sku = facts.menu.sellables.find(
          (item) => item.sellableReference === entry.sellableReference,
        );
        return (
          !!sku &&
          (snapshot.lifecycle !== "Published" ||
            (sku.productLifecycle === "Active" && sku.skuLifecycle === "Active")) &&
          (entry.scopeKind === "Brand" ||
            (entry.scopeKind === "Store" && entry.scopeReference === String(store))) &&
          (entry.channelCode === null || facts.menu.channelCodes.includes(entry.channelCode)) &&
          (entry.orderType === null ||
            facts.menu.orderTypeCodes.includes(entry.orderType === "DineIn" ? "DINE_IN" : "PICKUP"))
        );
      });
    },
    async coverageContexts(
      transaction: ConsumerTransaction,
      snapshot: PriceBookSnapshot,
    ): Promise<readonly PriceResolutionContext[]> {
      const facts = await load(transaction);
      if (
        !facts ||
        String(snapshot.brandReference) !== brand ||
        snapshot.currencyMetadata.currencyCode !== facts.brand.currencyCode ||
        facts.menu.channelCodes.length === 0 ||
        facts.menu.orderTypeCodes.length === 0 ||
        facts.menu.orderTypeCodes.some((code) => !["DINE_IN", "PICKUP"].includes(code))
      )
        return [];
      const visible = facts.menu.sellables.filter((item) => item.visible);
      if (
        visible.some((item) => item.productLifecycle !== "Active" || item.skuLifecycle !== "Active")
      )
        return [];
      // Price resolution changes only at entry boundaries. An immediate pilot
      // baseline must cover now and every future transition, including expiration.
      const instants = new Set([facts.at]);
      for (const entry of snapshot.entries) {
        if (entry.effectivePeriod.effectiveFrom.instant > facts.at)
          instants.add(entry.effectivePeriod.effectiveFrom.instant);
        const until = entry.effectivePeriod.effectiveUntil?.instant;
        if (until && until > facts.at) instants.add(until);
      }
      return Object.freeze(
        visible.flatMap((item) =>
          facts.menu.channelCodes.flatMap((channel) =>
            facts.menu.orderTypeCodes.flatMap((type) =>
              [...instants].sort().map((evaluatedAt) => ({
                brandReference: parsePricingReference(brand),
                storeReference: parsePricingReference(store),
                storeGroupReference: null,
                regionReference: null,
                sellableReference: parsePricingReference(item.sellableReference),
                channelCode: parsePricingCode(channel),
                orderType: type === "DINE_IN" ? ("DineIn" as const) : ("Pickup" as const),
                currencyCode: facts.store.currencyCode,
                evaluatedAt,
              })),
            ),
          ),
        ),
      );
    },
  });
}
