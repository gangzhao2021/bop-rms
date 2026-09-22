import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parsePublishingDigest } from "@bop/publishing";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogCode,
  parseCatalogInstant,
} from "../../contracts/product.js";
import { resolveCurrentCatalogSelectionRules } from "../../application/current-selection-rules.js";
import { createPostgresCurrentOptionBindingsStore } from "./current-option-bindings-store.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";

const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Full review facts: retain quantities, defaults, conditions and channel scope.
 * The caller must keep the transaction open through review validation/persistence.
 * These are current owner facts, not publication or sale authority.
 */
export function createPostgresMenuReviewOptionSource(options: {
  brandReference: string;
  authorize(tx: ProductLifecycleTransaction): Promise<boolean>;
}) {
  const brand = parseCatalogReference(options.brandReference);
  return async (
    tx: ProductLifecycleTransaction,
    input: {
      sellableReference: string;
      productVersionReference: string;
      channelCodes: readonly string[];
      observedAt: string;
    },
  ) => {
    try {
      const sellable = parseCatalogReference(input.sellableReference);
      const version = parseCatalogReference(input.productVersionReference);
      const at = parseCatalogInstant(input.observedAt);
      if (!Array.isArray(input.channelCodes) || !input.channelCodes.length) return fail();
      const channels = input.channelCodes.map(parseCatalogCode).sort();
      if (new Set(channels).size !== channels.length) return fail();
      const authorize = async () => {
        if ((await options.authorize(tx)) !== true)
          throw new CatalogError("CATALOG_PERMISSION_DENIED");
      };
      await authorize();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
        [brand],
      );
      await tx.query(
        "LOCK TABLE rms_catalog.sku,rms_catalog.product_version,rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option,rms_catalog.option_conflict,rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel IN SHARE MODE",
        [],
      );
      const reader = createPostgresCurrentOptionBindingsStore(
        { run: (work) => work(tx) },
        { brandReference: brand },
      );
      let productReference: string | null = null;
      const facts = [];
      for (const channelCode of channels) {
        const source = await reader.load({
          sellableReference: sellable,
          productVersionReference: version,
          channelCode,
          observedAt: at,
        });
        if (!source || (productReference !== null && source.productReference !== productReference))
          return fail();
        productReference = source.productReference;
        const rules = resolveCurrentCatalogSelectionRules(source.bindings, {
          brandReference: brand,
          sellableReference: sellable,
          channelCode,
          observedAt: at,
        });
        facts.push(Object.freeze({ channelCode, bindings: source.bindings, rules }));
      }
      if (productReference === null) return fail();
      const content = Object.freeze({
        brandReference: brand,
        sellableReference: sellable,
        productReference: parseCatalogReference(productReference),
        productVersionReference: version,
        channels: Object.freeze(facts),
      });
      await authorize();
      return Object.freeze({
        ...content,
        observedAt: at,
        sourceDigest: parsePublishingDigest("sha256:" + sha256Hex(canonicalizeRfc8785(content))),
      });
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      return fail();
    }
  };
}
