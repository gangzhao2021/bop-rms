import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogCode,
  parseProductLifecycle,
} from "../../contracts/product.js";

interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
const unavailable = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function rows(result: unknown): Record<string, unknown>[] {
  if (!result || typeof result !== "object") return unavailable();
  const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !Array.isArray(descriptor.value) ||
    descriptor.value.some((row) => !row || typeof row !== "object" || Array.isArray(row))
  )
    return unavailable();
  return descriptor.value as Record<string, unknown>[];
}

/** Owner facts for an authorized administration transaction. Locks the Menu root/
 * draft and referenced Product/SKU rows; lifecycle is data, not permission or
 * publication proof. No labels, allergens or tax facts are returned.
 */
export function createPostgresMenuPricingFactsSource(options: {
  brandReference: string;
  menuReference: string;
}) {
  const brand = parseCatalogReference(options.brandReference);
  const menu = parseCatalogReference(options.menuReference);
  return Object.freeze({
    async load(transaction: Transaction, observedAt: string) {
      const at = parseCatalogInstant(observedAt);
      await transaction.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
        [brand],
      );
      const roots = rows(
        await transaction.query(
          "SELECT m.aggregate_version,v.menu_version_id FROM rms_catalog.menu m JOIN rms_catalog.menu_version v ON v.menu_id=m.menu_id AND v.brand_id=m.brand_id WHERE m.brand_id=$1 AND m.menu_id=$2 AND v.status='Draft' AND m.created_at<=$3::timestamptz AND m.updated_at<=$3::timestamptz AND v.created_at<=$3::timestamptz AND v.updated_at<=$3::timestamptz AND date_trunc('milliseconds',m.updated_at)=m.updated_at AND date_trunc('milliseconds',v.updated_at)=v.updated_at FOR SHARE OF m,v",
          [brand, menu, at],
        ),
      );
      if (roots.length === 0) return null;
      const root = roots[0];
      if (
        roots.length !== 1 ||
        !root ||
        !Number.isSafeInteger(root.aggregate_version) ||
        (root.aggregate_version as number) < 1
      )
        return unavailable();
      const version = parseCatalogReference(root.menu_version_id);
      const bindings = rows(
        await transaction.query(
          "SELECT 'Store' kind,store_id::text value FROM rms_catalog.menu_version_store WHERE brand_id=$1 AND menu_id=$2 AND menu_version_id=$3 UNION ALL SELECT 'Channel',channel_code FROM rms_catalog.menu_version_channel WHERE brand_id=$1 AND menu_id=$2 AND menu_version_id=$3 UNION ALL SELECT 'OrderType',order_type_code FROM rms_catalog.menu_version_order_type WHERE brand_id=$1 AND menu_id=$2 AND menu_version_id=$3 ORDER BY kind,value",
          [brand, menu, version],
        ),
      );
      const stores: string[] = [],
        channels: string[] = [],
        orderTypes: string[] = [];
      for (const binding of bindings) {
        if (binding.kind === "Store") stores.push(parseCatalogReference(binding.value));
        else if (binding.kind === "Channel") channels.push(parseCatalogCode(binding.value));
        else if (binding.kind === "OrderType") orderTypes.push(parseCatalogCode(binding.value));
        else return unavailable();
      }
      const items = rows(
        await transaction.query(
          "SELECT s.sku_id,s.product_version_id,s.lifecycle sku_lifecycle,p.lifecycle product_lifecycle,placement.presentation_role,(p.created_at<=$4::timestamptz AND p.updated_at<=$4::timestamptz AND v.created_at<=$4::timestamptz AND v.updated_at<=$4::timestamptz AND s.created_at<=$4::timestamptz AND placement.created_at<=$4::timestamptz AND date_trunc('milliseconds',p.updated_at)=p.updated_at AND date_trunc('milliseconds',v.updated_at)=v.updated_at) coherent FROM rms_catalog.sellable_placement placement JOIN rms_catalog.menu_section section ON section.menu_section_id=placement.menu_section_id AND section.menu_id=placement.menu_id AND section.brand_id=placement.brand_id JOIN rms_catalog.sku s ON s.sku_id=placement.sku_id AND s.brand_id=placement.brand_id JOIN rms_catalog.product p ON p.product_id=s.product_id AND p.brand_id=s.brand_id JOIN rms_catalog.product_version v ON v.product_version_id=s.product_version_id AND v.product_id=s.product_id AND v.brand_id=s.brand_id WHERE placement.brand_id=$1 AND placement.menu_id=$2 AND section.menu_version_id=$3 ORDER BY s.sku_id,placement.placement_id FOR SHARE OF s,p,v",
          [brand, menu, version, at],
        ),
      );
      const sellables = new Map<
        string,
        {
          sellableReference: string;
          productVersionReference: string;
          productLifecycle: ReturnType<typeof parseProductLifecycle>;
          skuLifecycle: ReturnType<typeof parseProductLifecycle>;
          visible: boolean;
        }
      >();
      for (const item of items) {
        if (
          item.coherent !== true ||
          !["Standard", "Featured", "Promotional", "Sponsored", "Hidden"].includes(
            String(item.presentation_role),
          )
        )
          return unavailable();
        const sku = parseCatalogReference(item.sku_id);
        const productVersion = parseCatalogReference(item.product_version_id);
        const productLifecycle = parseProductLifecycle(item.product_lifecycle);
        const skuLifecycle = parseProductLifecycle(item.sku_lifecycle);
        const previous = sellables.get(sku);
        if (
          previous &&
          (previous.productVersionReference !== productVersion ||
            previous.productLifecycle !== productLifecycle ||
            previous.skuLifecycle !== skuLifecycle)
        )
          return unavailable();
        sellables.set(
          sku,
          Object.freeze({
            sellableReference: sku,
            productVersionReference: productVersion,
            productLifecycle,
            skuLifecycle,
            visible: previous?.visible === true || item.presentation_role !== "Hidden",
          }),
        );
      }
      return Object.freeze({
        brandReference: brand,
        menuReference: menu,
        menuVersionReference: version,
        aggregateVersion: root.aggregate_version as number,
        observedAt: at,
        storeReferences: Object.freeze(stores),
        channelCodes: Object.freeze(channels),
        orderTypeCodes: Object.freeze(orderTypes),
        sellables: Object.freeze([...sellables.values()]),
      });
    },
  });
}
