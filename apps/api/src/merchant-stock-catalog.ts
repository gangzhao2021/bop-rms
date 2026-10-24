import {
  createPostgresInventoryItemStore,
  createPostgresStockPlaceStore,
  type InventoryItemAggregate,
  type InventoryItemTransaction,
} from "@rms/inventory";

/**
 * WP-2423: the choices Store stock documents offer (opening count, receipts, counts, waste): the
 * Brand's Active stock-tracked Inventory Items and the Store's Active Storage Locations.
 */
export async function merchantStockCatalog(
  tx: unknown,
  scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  },
  locale: string,
) {
  const runner = {
    run: <T>(work: (t: InventoryItemTransaction) => Promise<T>) =>
      work(tx as InventoryItemTransaction),
  };
  const store = createPostgresInventoryItemStore(runner, {
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
  });
  const items: InventoryItemAggregate[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const result = await store.list({
      search: null,
      lifecycle: "Active",
      afterInternalCode: after,
      limit: 200,
    });
    items.push(...result.items.filter((item) => item.trackingPolicy.stockTrackingEnabled));
    if (!result.hasMore) break;
    after = result.items.at(-1)?.internalCode ?? null;
  }
  const places = await createPostgresStockPlaceStore(runner, scope).list();
  const name = (names: Readonly<Record<string, string>>, fallback: string) =>
    names[locale] ?? Object.values(names)[0] ?? fallback;
  return {
    items: items.map((item) => ({
      itemReference: item.itemReference,
      internalCode: item.internalCode,
      name: name(item.localizedNames, item.internalCode),
      unitCode: item.baseUnit.unitCode,
      ledgerPrecision: item.baseUnit.ledgerPrecision,
      lotTracking: item.trackingPolicy.lotTrackingMode,
    })),
    locations: places.locations
      .filter((location) => location.lifecycle === "Active")
      .map((location) => ({
        locationReference: location.locationReference,
        code: location.code,
        name: name(location.localizedNames, location.code),
      })),
  };
}
