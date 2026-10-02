import {
  CatalogError,
  parseCatalogReference,
  parseCatalogCode,
  parseCatalogLocale,
  parseCatalogInstant,
  parseLocalizedNames,
} from "./product.js";
import {
  copyCategoryPersistenceValue,
  validateCategoryTreeSnapshot,
} from "./category-persistence.js";
import {
  categorySourceDigest,
  categorySourceRevision,
  type CategorySourceSnapshot,
} from "./category-source.js";
import { productListArray, productListRecord } from "./product-list.js";
export const productCategoryLookupFields = Object.freeze([
  "categoryReference",
  "internalCode",
  "localizedNames",
  "lifecycle",
  "source",
  "allowedLifecycles",
] as const);
export type ProductCategoryLookupScreen = "CAT-PRODUCT-CREATE" | "CAT-PRODUCT-EDIT";
export interface CatalogProductCategoryLookup {
  readonly projection: {
    readonly name: "catalog_product_category_lookup_v1";
    readonly version: 1;
    readonly asOfUtc: string;
    readonly stale: false;
    readonly partial: true;
  };
  readonly parentScreenId: ProductCategoryLookupScreen;
  readonly brandReference: string;
  readonly locale: string;
  readonly configuration: "Draft";
  readonly source: { readonly revision: string; readonly digest: string; readonly asOfUtc: string };
  readonly policy: { readonly allowedLifecycles: readonly ("Draft" | "Active")[] };
  readonly items: readonly {
    readonly categoryReference: string;
    readonly internalCode: string;
    readonly name: string;
    readonly nameLocale: string;
    readonly localeFallback: boolean;
    readonly lifecycle: "Draft" | "Active";
  }[];
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function screen(value: unknown): ProductCategoryLookupScreen {
  if (value !== "CAT-PRODUCT-CREATE" && value !== "CAT-PRODUCT-EDIT") return fail();
  return value;
}
export function parseProductCategoryLookupPolicy(
  value: unknown,
): CatalogProductCategoryLookup["policy"] {
  const raw = productListRecord(copyCategoryPersistenceValue(value), ["allowedLifecycles"]),
    values = productListArray(raw.allowedLifecycles, 2);
  if (
    values.some((value) => value !== "Draft" && value !== "Active") ||
    new Set(values).size !== values.length
  )
    return fail();
  return Object.freeze({
    allowedLifecycles: Object.freeze(values.map((value) => value as "Draft" | "Active").sort()),
  });
}
export function parseCatalogProductCategoryLookup(value: unknown): CatalogProductCategoryLookup {
  try {
    const raw = productListRecord(copyCategoryPersistenceValue(value), [
      "projection",
      "parentScreenId",
      "brandReference",
      "locale",
      "configuration",
      "source",
      "policy",
      "items",
    ]);
    const projection = productListRecord(raw.projection, [
      "name",
      "version",
      "asOfUtc",
      "stale",
      "partial",
    ]);
    const at = parseCatalogInstant(projection.asOfUtc),
      brandReference = parseCatalogReference(raw.brandReference),
      locale = parseCatalogLocale(raw.locale);
    if (
      projection.name !== "catalog_product_category_lookup_v1" ||
      projection.version !== 1 ||
      projection.stale !== false ||
      projection.partial !== true ||
      raw.configuration !== "Draft"
    )
      return fail();
    const source = productListRecord(raw.source, ["revision", "digest", "asOfUtc"]),
      revision = categorySourceRevision(source.revision);
    if (
      source.asOfUtc !== at ||
      typeof source.digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(source.digest)
    )
      return fail();
    const selectedPolicy = parseProductCategoryLookupPolicy(raw.policy),
      refs = new Set<string>(),
      codes = new Set<string>();
    const items = Object.freeze(
      productListArray(raw.items, 10000).map((value) => {
        const item = productListRecord(value, [
          "categoryReference",
          "internalCode",
          "name",
          "nameLocale",
          "localeFallback",
          "lifecycle",
        ]);
        const categoryReference = parseCatalogReference(item.categoryReference),
          internalCode = parseCatalogCode(item.internalCode),
          nameLocale = parseCatalogLocale(item.nameLocale);
        if (
          item.internalCode !== internalCode ||
          refs.has(categoryReference) ||
          codes.has(internalCode) ||
          typeof item.name !== "string" ||
          item.localeFallback !== (nameLocale !== locale) ||
          (item.lifecycle !== "Draft" && item.lifecycle !== "Active") ||
          !selectedPolicy.allowedLifecycles.includes(item.lifecycle)
        )
          return fail();
        const normalized = parseLocalizedNames({ [nameLocale]: item.name }, nameLocale)[nameLocale];
        if (normalized !== item.name) return fail();
        refs.add(categoryReference);
        codes.add(internalCode);
        return Object.freeze({
          categoryReference,
          internalCode,
          name: item.name,
          nameLocale,
          localeFallback: item.localeFallback as boolean,
          lifecycle: item.lifecycle,
        });
      }),
    );
    if (items.some((item, i) => i > 0 && (items[i - 1]?.internalCode ?? "") >= item.internalCode))
      return fail();
    return Object.freeze({
      projection: Object.freeze({
        name: "catalog_product_category_lookup_v1",
        version: 1,
        asOfUtc: at,
        stale: false,
        partial: true,
      }),
      parentScreenId: screen(raw.parentScreenId),
      brandReference,
      locale,
      configuration: "Draft",
      source: Object.freeze({ revision, digest: source.digest, asOfUtc: at }),
      policy: selectedPolicy,
      items,
    });
  } catch {
    return fail();
  }
}
/** Trusted owning source and independently held policy required. Pure validation is not authorization. */
export function deriveCatalogProductCategoryLookup(
  sourceValue: CategorySourceSnapshot,
  parentScreenId: ProductCategoryLookupScreen,
  requestedLocale: unknown,
  policyValue: unknown,
  now: unknown,
): CatalogProductCategoryLookup {
  try {
    const raw = productListRecord(copyCategoryPersistenceValue(sourceValue), [
      "brandReference",
      "sourceRevision",
      "observedAt",
      "categories",
      "sourceDigest",
    ]);
    const brand = parseCatalogReference(raw.brandReference),
      revision = categorySourceRevision(raw.sourceRevision),
      at = parseCatalogInstant(raw.observedAt),
      completed = parseCatalogInstant(now),
      locale = parseCatalogLocale(requestedLocale),
      selectedPolicy = parseProductCategoryLookupPolicy(policyValue);
    const categories = validateCategoryTreeSnapshot(raw.categories, brand, 10000);
    if (
      at > completed ||
      Date.parse(completed) - Date.parse(at) > 5000 ||
      categories.some((node) => node.updatedAt > at) ||
      raw.sourceDigest !==
        categorySourceDigest({ brandReference: brand, sourceRevision: revision, categories })
    )
      return fail();
    const items = categories
      .filter((node) => selectedPolicy.allowedLifecycles.some((state) => state === node.lifecycle))
      .map((node) => {
        const nameLocale = Object.hasOwn(node.localizedNames, locale) ? locale : node.defaultLocale;
        return {
          categoryReference: node.categoryReference,
          internalCode: node.internalCode,
          name: node.localizedNames[nameLocale] ?? fail(),
          nameLocale,
          localeFallback: nameLocale !== locale,
          lifecycle: node.lifecycle,
        };
      })
      .sort((a, b) =>
        a.internalCode < b.internalCode ? -1 : a.internalCode > b.internalCode ? 1 : 0,
      );
    return parseCatalogProductCategoryLookup({
      projection: {
        name: "catalog_product_category_lookup_v1",
        version: 1,
        asOfUtc: at,
        stale: false,
        partial: true,
      },
      parentScreenId: screen(parentScreenId),
      brandReference: brand,
      locale,
      configuration: "Draft",
      source: { revision, digest: raw.sourceDigest, asOfUtc: at },
      policy: selectedPolicy,
      items,
    });
  } catch {
    return fail();
  }
}
