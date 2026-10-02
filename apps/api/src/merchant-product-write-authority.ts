import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseProductAggregate,
  parseProductVersion,
} from "@rms/catalog";
import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
export interface ProductDraftSkuMutationIntent {
  readonly createdSkuReferences: readonly string[];
  readonly updatedSkuReferences: readonly string[];
}
function copySkuIntent(value: unknown): ProductDraftSkuMutationIntent {
  try {
    const raw = readClosedRecord(value, ["createdSkuReferences", "updatedSkuReferences"]);
    const copy = (value: unknown) => {
      if (!Array.isArray(value) || value.length > 10000) throw new Error("Invalid intent");
      const refs = value.map(parseCatalogReference);
      if (new Set(refs).size !== refs.length) throw new Error("Duplicate intent");
      return Object.freeze(refs.sort());
    };
    const createdSkuReferences = copy(raw.createdSkuReferences),
      updatedSkuReferences = copy(raw.updatedSkuReferences);
    if (createdSkuReferences.some((ref) => updatedSkuReferences.includes(ref)))
      throw new Error("Overlapping intent");
    return Object.freeze({ createdSkuReferences, updatedSkuReferences });
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
}
/** Both inputs are owner snapshots/closed Draft values, never caller permission facts. */
export function deriveProductDraftSkuMutationIntent(
  original: unknown,
  requested: unknown,
): ProductDraftSkuMutationIntent {
  const baseline = parseProductAggregate(original),
    draft = parseProductVersion(requested);
  if (draft.versionReference !== baseline.draft.versionReference)
    throw new CatalogError("CATALOG_INPUT_INVALID");
  const createdSkuReferences: string[] = [],
    updatedSkuReferences: string[] = [];
  const before = new Map(baseline.draft.skus.map((sku) => [sku.skuReference, sku]));
  const configuration = (sku: (typeof draft.skus)[number]) =>
    canonicalizeRfc8785({
      localizedNames: sku.localizedNames,
      variantSelections: [...sku.variantSelections].sort((a, b) =>
        a.dimensionReference.localeCompare(b.dimensionReference),
      ),
    });
  for (const sku of draft.skus) {
    if (
      sku.productReference !== baseline.productReference ||
      sku.brandReference !== baseline.brandReference
    )
      throw new CatalogError("CATALOG_INPUT_INVALID");
    const old = before.get(sku.skuReference);
    if (!old) {
      if (sku.lifecycle !== "Draft") throw new CatalogError("CATALOG_INPUT_INVALID");
      createdSkuReferences.push(sku.skuReference);
    } else {
      if (
        old.skuCode !== sku.skuCode ||
        old.unitOfSale !== sku.unitOfSale ||
        old.unitQuantity !== sku.unitQuantity ||
        old.lifecycle !== sku.lifecycle
      )
        throw new CatalogError("CATALOG_INPUT_INVALID");
      if (configuration(old) !== configuration(sku)) updatedSkuReferences.push(sku.skuReference);
    }
    before.delete(sku.skuReference);
  }
  // Existing owner Draft-removal semantics remain; used/history policy is separately required.
  for (const ref of before.keys()) updatedSkuReferences.push(ref);
  return copySkuIntent({ createdSkuReferences, updatedSkuReferences });
}
import type { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
export class MerchantProductWriteFeatureDisabled extends CatalogError {
  constructor() {
    super("CATALOG_DEPENDENCY_UNAVAILABLE");
    this.name = "MerchantProductWriteFeatureDisabled";
  }
}
export const productCreateWriteFields = Object.freeze([
  "internalCode",
  "productType",
  "defaultLocale",
  "localizedNames",
  "taxClassificationReference",
  "categoryClassification.categoryReferences",
  "categoryClassification.primaryCategoryReference",
  "skus.skuCode",
  "skus.localizedNames",
  "skus.variantSelections",
  "skus.unitOfSale",
  "skus.unitQuantity",
] as const);
export const productDraftWriteFields = Object.freeze([
  "draft.defaultLocale",
  "draft.localizedNames",
  "draft.taxClassificationReference",
  "draft.categoryClassification.categoryReferences",
  "draft.categoryClassification.primaryCategoryReference",
  "draft.skus.skuReference",
  "draft.skus.skuCode",
  "draft.skus.lifecycle",
  "draft.skus.localizedNames",
  "draft.skus.variantSelections",
  "draft.skus.unitOfSale",
  "draft.skus.unitQuantity",
  "draft.optionBindings",
] as const);
export const productCreateResultFields = Object.freeze([
  "productReference",
  "versionReference",
  "aggregateVersion",
  "lifecycle",
  "categoryClassification",
  "skus.skuReference",
  "skus.skuCode",
  "skus.lifecycle",
] as const);
export const productDraftResultFields = Object.freeze([
  "productReference",
  "aggregateVersion",
  "draft.versionReference",
  "draft.baseVersionReference",
  "draft.status",
  "draft.defaultLocale",
  "draft.localizedNames",
  "draft.taxClassificationReference",
  "draft.categoryClassification",
  "draft.createdAt",
  "draft.updatedAt",
  "draft.skus",
  "draft.optionBindings",
] as const);
type Tx = Parameters<
  ReturnType<typeof createMerchantCategoryTransactions>["registerBeforeCommit"]
>[0];
type Scope = Awaited<ReturnType<ReturnType<typeof createMerchantBrandScope>>>;
export type ProductWriteIntent =
  | {
      readonly action: "Create";
      readonly expectedAggregateVersion: null;
      readonly createsSkus: boolean;
    }
  | { readonly action: "ReplaceDraft"; readonly expectedAggregateVersion: number };
export type ProductWriteAuthorityInput = {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly sessionReference: string;
  readonly productReference: string;
  readonly operationReference: string;
  readonly permission: "catalog.manage";
  readonly owningAction: "catalog.product.manage";
  readonly phase: "phase_1";
  readonly observedAt: string;
} & (
  | {
      readonly action: "Create";
      readonly actionPermission: "catalog.product.create";
      readonly skuCreationPermission: "catalog.sku.create" | null;
      readonly screenId: "CAT-PRODUCT-CREATE";
      readonly capability: "catalog.cat_product_create";
      readonly purposeCode: "CATALOG_PRODUCT_CREATE";
      readonly expectedAggregateVersion: null;
      readonly requiredWriteFields: typeof productCreateWriteFields;
      readonly requiredReadFields: typeof productCreateResultFields;
    }
  | {
      readonly action: "ReplaceDraft";
      readonly actionPermission: "catalog.product.update";
      readonly skuDraftIntent: ProductDraftSkuMutationIntent | null;
      readonly screenId: "CAT-PRODUCT-EDIT";
      readonly capability: "catalog.cat_product_edit";
      readonly purposeCode: "CATALOG_PRODUCT_DRAFT_REPLACE";
      readonly expectedAggregateVersion: number;
      readonly requiredWriteFields: typeof productDraftWriteFields;
      readonly requiredReadFields: typeof productDraftResultFields;
    }
);
/** Current parent/target/field/Phase lease through outer COMMIT, never caller grants. */
export type MerchantProductWriteAuthority = (
  tx: Tx,
  input: ProductWriteAuthorityInput,
) => Promise<"Allowed" | "FeatureDisabled">;
export function createMerchantProductWriteGuard(options: {
  readonly transaction: Tx;
  readonly scope: Scope;
  readonly sessionReference: string;
  readonly productReference: string;
  readonly operationReference: string;
  readonly intent: ProductWriteIntent;
  readonly authority: MerchantProductWriteAuthority | undefined;
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
  let bound: {
    tenantReference: string;
    brandReference: string;
    storeReference: string;
    actorReference: string;
    sessionReference: string;
    productReference: string;
    operationReference: string;
  };
  try {
    bound = Object.freeze({
      tenantReference: parseCatalogReference(options.scope.tenantReference),
      brandReference: parseCatalogReference(options.scope.context.brand.brandReference),
      storeReference: parseCatalogReference(options.scope.selectedStoreReference),
      actorReference: parseCatalogReference(options.scope.actorReference),
      sessionReference: parseCatalogReference(options.sessionReference),
      productReference: parseCatalogReference(options.productReference),
      operationReference: parseCatalogReference(options.operationReference),
    });
  } catch {
    return unavailable();
  }
  const intent = options.intent;
  if (intent.action !== "Create" && intent.action !== "ReplaceDraft") return unavailable();
  if (
    intent.action === "Create"
      ? intent.expectedAggregateVersion !== null || typeof intent.createsSkus !== "boolean"
      : !Number.isSafeInteger(intent.expectedAggregateVersion) ||
        intent.expectedAggregateVersion < 1 ||
        intent.expectedAggregateVersion >= 2147483647
  )
    return unavailable();
  const parent =
    intent.action === "Create"
      ? Object.freeze({
          action: "Create" as const,
          actionPermission: "catalog.product.create" as const,
          skuCreationPermission: intent.createsSkus ? ("catalog.sku.create" as const) : null,
          screenId: "CAT-PRODUCT-CREATE" as const,
          capability: "catalog.cat_product_create" as const,
          purposeCode: "CATALOG_PRODUCT_CREATE" as const,
          expectedAggregateVersion: null,
          requiredWriteFields: productCreateWriteFields,
          requiredReadFields: productCreateResultFields,
        })
      : Object.freeze({
          action: "ReplaceDraft" as const,
          actionPermission: "catalog.product.update" as const,
          screenId: "CAT-PRODUCT-EDIT" as const,
          capability: "catalog.cat_product_edit" as const,
          purposeCode: "CATALOG_PRODUCT_DRAFT_REPLACE" as const,
          expectedAggregateVersion: intent.expectedAggregateVersion,
          requiredWriteFields: productDraftWriteFields,
          requiredReadFields: productDraftResultFields,
        });
  let skuDraftIntent: ProductDraftSkuMutationIntent | null = null,
    skuBindingFailed = false;
  const holdSku = async () => {
    if (skuBindingFailed) return unavailable();
    if (skuDraftIntent === null) return;
    for (const action of [
      ...(skuDraftIntent.createdSkuReferences.length ? ["catalog.sku.create"] : []),
      ...(skuDraftIntent.updatedSkuReferences.length ? ["catalog.sku.update"] : []),
    ]) {
      const decision = await options.scope.authorizeAction(action);
      if (
        decision?.effect !== "Allow" ||
        decision.scopeKind !== "Brand" ||
        decision.action !== action
      )
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
    }
  };
  const hold = async () => {
    // Broad Screen/legacy Domain grants do not replace the canonical mutation intent.
    for (const action of [
      "catalog.manage",
      "catalog.product.manage",
      parent.actionPermission,
      ...(parent.action === "Create" && parent.skuCreationPermission !== null
        ? [parent.skuCreationPermission]
        : []),
    ]) {
      const decision = await options.scope.authorizeAction(action);
      if (
        decision?.effect !== "Allow" ||
        decision.scopeKind !== "Brand" ||
        decision.action !== action
      )
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
    }
    await holdSku();
    let observedAt: string;
    try {
      observedAt = parseCatalogInstant(options.now());
    } catch {
      return unavailable();
    }
    const heldParent = parent.action === "ReplaceDraft" ? { ...parent, skuDraftIntent } : parent;
    const result = await authority(
      options.transaction,
      Object.freeze({
        ...bound,
        ...heldParent,
        permission: "catalog.manage",
        owningAction: "catalog.product.manage",
        phase: "phase_1",
        observedAt,
      }),
    );
    if (result === "FeatureDisabled") throw new MerchantProductWriteFeatureDisabled();
    if (result !== "Allowed") return unavailable();
  };
  return Object.freeze({
    hold,
    async bindSkuDraftIntent(value: unknown) {
      if (parent.action !== "ReplaceDraft" || skuDraftIntent !== null || skuBindingFailed) {
        skuBindingFailed = true;
        return unavailable();
      }
      try {
        skuDraftIntent = copySkuIntent(value);
        await holdSku();
      } catch (error) {
        skuBindingFailed = true;
        throw error;
      }
    },
    async holdAndRegister() {
      await hold();
      await options.registerBeforeCommit(options.transaction, async () => {
        if (parent.action === "ReplaceDraft" && skuDraftIntent === null) return unavailable();
        await hold();
      });
    },
  });
}
