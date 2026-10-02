import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogLifecycleReasonCode,
  parseCatalogReference,
  parseProductLifecycle,
} from "@rms/catalog";
import { readClosedRecord } from "@bop/identity";
import { resolveMerchantProductLifecycleIntent } from "./merchant-product-lifecycle-intent.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
import type { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
type Tx = Parameters<
  ReturnType<typeof createMerchantCategoryTransactions>["registerBeforeCommit"]
>[0];
type Scope = Awaited<ReturnType<ReturnType<typeof createMerchantBrandScope>>>;
type Intent = ReturnType<typeof resolveMerchantProductLifecycleIntent>;
export const productLifecycleWriteFields = Object.freeze(["lifecycle", "reasonCode"] as const);
export const skuLifecycleWriteFields = Object.freeze([
  "draft.skus.lifecycle",
  "reasonCode",
] as const);
export const productLifecycleReadFields = Object.freeze([
  "productReference",
  "aggregateVersion",
  "lifecycle",
  "draft.versionReference",
  "draft.skus.skuReference",
  "draft.skus.lifecycle",
] as const);
export interface MerchantProductLifecycleAuthorityInput {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly sessionReference: string;
  readonly productReference: string;
  readonly skuReference: string | null;
  readonly operationReference: string;
  readonly expectedAggregateVersion: number;
  readonly targetLifecycle: Intent["targetLifecycle"];
  readonly intent: Intent | null;
  readonly reasonCode: string | null;
  readonly permission: "catalog.manage";
  readonly owningAction: "catalog.product.manage";
  readonly phase: "phase_1";
  readonly screenId:
    | "CAT-PRODUCT-DETAIL"
    | "CAT-PRODUCT-ARCHIVE"
    | "CAT-PRODUCT-RESTORE"
    | "CAT-SKU-DETAIL"
    | "CAT-SKU-ARCHIVE"
    | "CAT-SKU-RESTORE";
  readonly capability:
    | "catalog.cat_product_detail"
    | "catalog.cat_product_archive"
    | "catalog.cat_product_restore"
    | "catalog.cat_sku_detail"
    | "catalog.cat_sku_archive"
    | "catalog.cat_sku_restore";
  readonly purposeCode: "CATALOG_PRODUCT_LIFECYCLE" | "CATALOG_SKU_LIFECYCLE";
  readonly requiredWriteFields: typeof productLifecycleWriteFields | typeof skuLifecycleWriteFields;
  readonly requiredReadFields: typeof productLifecycleReadFields;
  readonly observedAt: string;
}
/** The server holds current parent/target/field/Phase facts through outer COMMIT. */
export type MerchantProductLifecycleAuthority = (
  tx: Tx,
  input: MerchantProductLifecycleAuthorityInput,
) => Promise<"Allowed" | "FeatureDisabled">;
export function createMerchantProductLifecycleGuard(options: {
  readonly transaction: Tx;
  readonly scope: Scope;
  readonly sessionReference: string;
  readonly productReference: string;
  readonly skuReference: string | null;
  readonly operationReference: string;
  readonly expectedAggregateVersion: number;
  readonly targetLifecycle: Intent["targetLifecycle"];
  readonly reasonCode?: string;
  readonly authority: MerchantProductLifecycleAuthority | undefined;
  readonly now: () => string;
  readonly registerBeforeCommit: ReturnType<
    typeof createMerchantCategoryTransactions
  >["registerBeforeCommit"];
}) {
  const unavailable = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  if (typeof options.authority !== "function" || typeof options.now !== "function")
    return unavailable();
  const authority = options.authority;
  if (
    !Number.isSafeInteger(options.expectedAggregateVersion) ||
    options.expectedAggregateVersion < 1 ||
    options.expectedAggregateVersion >= 2147483647
  )
    return unavailable();
  let bound;
  try {
    bound = Object.freeze({
      tenantReference: parseCatalogReference(options.scope.tenantReference),
      brandReference: parseCatalogReference(options.scope.context.brand.brandReference),
      storeReference: parseCatalogReference(options.scope.selectedStoreReference),
      actorReference: parseCatalogReference(options.scope.actorReference),
      sessionReference: parseCatalogReference(options.sessionReference),
      productReference: parseCatalogReference(options.productReference),
      skuReference:
        options.skuReference === null ? null : parseCatalogReference(options.skuReference),
      operationReference: parseCatalogReference(options.operationReference),
      expectedAggregateVersion: options.expectedAggregateVersion,
      targetLifecycle: parseProductLifecycle(options.targetLifecycle),
      reasonCode:
        options.reasonCode === undefined
          ? null
          : parseCatalogLifecycleReasonCode(options.reasonCode),
    });
  } catch {
    return unavailable();
  }
  const kind = bound.skuReference === null ? "Product" : "Sku";
  const prefix = kind === "Product" ? "PRODUCT" : "SKU";
  const suffix =
    bound.targetLifecycle === "Archived"
      ? "ARCHIVE"
      : bound.targetLifecycle === "Draft"
        ? "RESTORE"
        : "DETAIL";
  const parent = Object.freeze({
    ...bound,
    permission: "catalog.manage" as const,
    owningAction: "catalog.product.manage" as const,
    phase: "phase_1" as const,
    screenId: `CAT-${prefix}-${suffix}` as MerchantProductLifecycleAuthorityInput["screenId"],
    capability:
      `catalog.cat_${prefix.toLowerCase()}_${suffix.toLowerCase()}` as MerchantProductLifecycleAuthorityInput["capability"],
    purposeCode:
      kind === "Product"
        ? ("CATALOG_PRODUCT_LIFECYCLE" as const)
        : ("CATALOG_SKU_LIFECYCLE" as const),
    requiredWriteFields: kind === "Product" ? productLifecycleWriteFields : skuLifecycleWriteFields,
    requiredReadFields: productLifecycleReadFields,
  });
  let intent: Intent | null = null,
    bindingFailed = false,
    registered = false;
  const hold = async () => {
    if (bindingFailed) return unavailable();
    for (const action of [
      "catalog.manage",
      "catalog.product.manage",
      ...(intent ? [intent.actionPermission] : []),
    ]) {
      const decision = await options.scope.authorizeAction(action);
      if (
        decision?.effect !== "Allow" ||
        decision.scopeKind !== "Brand" ||
        decision.action !== action
      )
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
    }
    let observedAt: string;
    try {
      observedAt = parseCatalogInstant(options.now());
    } catch {
      return unavailable();
    }
    const result = await authority(
      options.transaction,
      Object.freeze({ ...parent, intent, observedAt }),
    );
    if (result === "FeatureDisabled") throw new MerchantProductWriteFeatureDisabled();
    if (result !== "Allowed") return unavailable();
  };
  return Object.freeze({
    hold,
    async bindIntent(value: unknown) {
      if (intent !== null || bindingFailed) {
        bindingFailed = true;
        return unavailable();
      }
      try {
        const raw = readClosedRecord(value, [
          "kind",
          "action",
          "actionPermission",
          "beforeLifecycle",
          "targetLifecycle",
        ]);
        const resolved = resolveMerchantProductLifecycleIntent(
          kind,
          raw.beforeLifecycle,
          raw.targetLifecycle,
        );
        if (
          raw.kind !== kind ||
          raw.targetLifecycle !== bound.targetLifecycle ||
          raw.action !== resolved.action ||
          raw.actionPermission !== resolved.actionPermission
        )
          return unavailable();
        intent = resolved;
        await hold();
      } catch (error) {
        bindingFailed = true;
        if (error instanceof CatalogError) throw error;
        return unavailable();
      }
    },
    async holdAndRegister() {
      if (registered) {
        bindingFailed = true;
        return unavailable();
      }
      await hold();
      registered = true;
      await options.registerBeforeCommit(options.transaction, async () => {
        if (intent === null) return unavailable();
        await hold();
      });
    },
  });
}
