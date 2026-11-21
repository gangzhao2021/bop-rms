import {
  CatalogError,
  parseCatalogReference,
  parseCatalogCode,
  parseCatalogInstant,
  parseProductVersion,
  parseProductAggregate,
  type ProductVersion,
  type ProductLifecycle,
  type ProductType,
  type ProductAggregate,
} from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { productListRecord } from "./product-list.js";
import { canonicalizeRfc8785 } from "@bop/audit";
/** Full persisted Draft; excludes unsupported complete Editor/availability/history claims. */
export const productDraftBaselineFields = Object.freeze([
  "productReference",
  "brandReference",
  "internalCode",
  "productType",
  "lifecycle",
  "aggregateVersion",
  "updatedAt",
  "draft.versionReference",
  "draft.baseVersionReference",
  "draft.status",
  "draft.defaultLocale",
  "draft.localizedNames",
  "draft.taxClassificationReference",
  "draft.createdAt",
  "draft.updatedAt",
  "draft.categoryClassification",
  "draft.skus.skuReference",
  "draft.skus.productReference",
  "draft.skus.brandReference",
  "draft.skus.skuCode",
  "draft.skus.lifecycle",
  "draft.skus.localizedNames",
  "draft.skus.variantSelections",
  "draft.skus.unitOfSale",
  "draft.skus.unitQuantity",
  "draft.skus.createdAt",
  "draft.skus.createdByActorReference",
  "draft.optionBindings",
] as const);
/** Source validation reads these additional private root metadata fields, not exposed in DTO. */
export const productDraftBaselineReferencedFields = Object.freeze([
  ...productDraftBaselineFields,
  "createdAt",
  "createdByActorReference",
] as const);
export interface CatalogProductDraftBaseline {
  readonly projection: {
    readonly name: "catalog_product_draft_baseline_v1";
    readonly version: 1;
    readonly asOfUtc: string;
    readonly stale: false;
    readonly partial: true;
  };
  readonly productReference: string;
  readonly brandReference: string;
  readonly internalCode: string;
  readonly productType: ProductType;
  readonly lifecycle: ProductLifecycle;
  readonly aggregateVersion: number;
  readonly updatedAt: string;
  readonly classificationCoverage: "Known" | "Unavailable";
  readonly draft: ProductVersion;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const same = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
export function parseCatalogProductDraftBaseline(value: unknown): CatalogProductDraftBaseline {
  try {
    const raw = productListRecord(copyCategoryPersistenceValue(value), [
      "projection",
      "productReference",
      "brandReference",
      "internalCode",
      "productType",
      "lifecycle",
      "aggregateVersion",
      "updatedAt",
      "classificationCoverage",
      "draft",
    ]);
    const projection = productListRecord(raw.projection, [
      "name",
      "version",
      "asOfUtc",
      "stale",
      "partial",
    ]);
    if (
      projection.name !== "catalog_product_draft_baseline_v1" ||
      projection.version !== 1 ||
      projection.stale !== false ||
      projection.partial !== true
    )
      return fail();
    const asOfUtc = parseCatalogInstant(projection.asOfUtc),
      productReference = parseCatalogReference(raw.productReference),
      brandReference = parseCatalogReference(raw.brandReference),
      internalCode = parseCatalogCode(raw.internalCode),
      updatedAt = parseCatalogInstant(raw.updatedAt),
      draft = parseProductVersion(raw.draft);
    if (
      (raw.productType !== "PreparedFood" && raw.productType !== "NonAlcoholicBeverage") ||
      !["Draft", "Active", "Suspended", "Discontinued", "Archived"].includes(
        raw.lifecycle as string,
      ) ||
      !Number.isSafeInteger(raw.aggregateVersion) ||
      (raw.aggregateVersion as number) < 1 ||
      (raw.aggregateVersion as number) > 2147483647 ||
      updatedAt > asOfUtc ||
      draft.updatedAt > updatedAt ||
      draft.skus.some(
        (sku) =>
          sku.brandReference !== brandReference ||
          sku.productReference !== productReference ||
          sku.createdAt > draft.updatedAt,
      ) ||
      raw.classificationCoverage !==
        (draft.categoryClassification === undefined ? "Unavailable" : "Known") ||
      internalCode !== raw.internalCode ||
      !same(draft, raw.draft)
    )
      return fail();
    return Object.freeze({
      projection: Object.freeze({
        name: "catalog_product_draft_baseline_v1",
        version: 1,
        asOfUtc,
        stale: false,
        partial: true,
      }),
      productReference,
      brandReference,
      internalCode,
      productType: raw.productType,
      lifecycle: raw.lifecycle as ProductLifecycle,
      aggregateVersion: raw.aggregateVersion as number,
      updatedAt,
      classificationCoverage: raw.classificationCoverage as "Known" | "Unavailable",
      draft,
    });
  } catch {
    return fail();
  }
}
/** Trusted current owning snapshot + authority required; pure mapping never establishes either. */
export function deriveCatalogProductDraftBaseline(
  value: ProductAggregate,
  observedAt: unknown,
  now: unknown,
): CatalogProductDraftBaseline {
  try {
    const copied = copyCategoryPersistenceValue(value),
      aggregate = parseProductAggregate(copied),
      asOfUtc = parseCatalogInstant(observedAt),
      completed = parseCatalogInstant(now);
    if (
      asOfUtc > completed ||
      Date.parse(completed) - Date.parse(asOfUtc) > 5000 ||
      !same(aggregate, copied)
    )
      return fail();
    return parseCatalogProductDraftBaseline({
      projection: {
        name: "catalog_product_draft_baseline_v1",
        version: 1,
        asOfUtc,
        stale: false,
        partial: true,
      },
      productReference: aggregate.productReference,
      brandReference: aggregate.brandReference,
      internalCode: aggregate.internalCode,
      productType: aggregate.productType,
      lifecycle: aggregate.lifecycle,
      aggregateVersion: aggregate.aggregateVersion,
      updatedAt: aggregate.updatedAt,
      classificationCoverage:
        aggregate.draft.categoryClassification === undefined ? "Unavailable" : "Known",
      draft: aggregate.draft,
    });
  } catch {
    return fail();
  }
}
