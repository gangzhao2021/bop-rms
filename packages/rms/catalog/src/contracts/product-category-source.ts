import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseProductLifecycle,
  parseProductCategoryClassification,
  type ProductCategoryClassification,
  type ProductLifecycle,
} from "./product.js";
import {
  parseProductSearchGeneration,
  type ProductSearchGeneration,
} from "./product-search-generation.js";
import {
  categorySourceDigest,
  categorySourceRevision,
  type CategorySourceSnapshot,
} from "./category-source.js";
import {
  copyCategoryPersistenceValue,
  validateCategoryTreeSnapshot,
} from "./category-persistence.js";
export const productClassificationMaximumAssignments = 50000;
export const productClassificationSourceFields = Object.freeze([
  "categoryClassification",
  "categoryReferences",
  "primaryCategoryReference",
] as const);
export const categoryProductViewFields = Object.freeze([
  "productCount",
  "primaryCategoryName",
  "categoryMembership",
  "categoryFilterOptions",
] as const);
export interface ProductClassificationSourceRow {
  readonly productReference: string;
  readonly productVersionReference: string;
  readonly lifecycle: ProductLifecycle;
  readonly categoryClassification?: ProductCategoryClassification;
}
export interface ProductClassificationSourceSnapshot {
  readonly generation: ProductSearchGeneration;
  readonly observedAt: string;
  readonly products: readonly ProductClassificationSourceRow[];
}
export interface CatalogCategoryProductView {
  readonly brandReference: string;
  readonly configuration: "Draft";
  readonly observedAt: string;
  readonly productGeneration: ProductSearchGeneration;
  readonly categorySource: {
    readonly revision: string;
    readonly digest: string;
    readonly observedAt: string;
  };
  readonly unknownClassificationProductCount: number;
  readonly categories: readonly {
    readonly categoryReference: string;
    readonly internalCode: string;
    readonly lifecycle: "Draft" | "Active" | "Inactive" | "Archived";
    readonly defaultLocale: string;
    readonly localizedNames: Readonly<Record<string, string>>;
    readonly productCount:
      | {
          readonly status: "Known";
          readonly includingArchived: number;
          readonly excludingArchived: number;
        }
      | { readonly status: "Unavailable" };
  }[];
  readonly products: readonly ProductClassificationSourceRow[];
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function record(value: unknown, fields: readonly string[], optional: readonly string[] = []) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Object.keys(value);
  if (
    fields.some((key) => !keys.includes(key)) ||
    keys.some((key) => !fields.includes(key) && !optional.includes(key))
  )
    return fail();
  return value as Record<string, unknown>;
}
export function parseProductClassificationSourceSnapshot(
  value: unknown,
): ProductClassificationSourceSnapshot {
  try {
    const raw = record(copyCategoryPersistenceValue(value), [
      "generation",
      "observedAt",
      "products",
    ]);
    const generation = parseProductSearchGeneration(raw.generation),
      observedAt = parseCatalogInstant(raw.observedAt);
    if (
      observedAt < generation.projectedAt ||
      Date.parse(observedAt) - Date.parse(generation.projectedAt) > 30000 ||
      !Array.isArray(raw.products) ||
      raw.products.length !== generation.productCount
    )
      return fail();
    const products = raw.products.map((value) => {
      const row = record(
        value,
        ["productReference", "productVersionReference", "lifecycle"],
        ["categoryClassification"],
      );
      return Object.freeze({
        productReference: parseCatalogReference(row.productReference),
        productVersionReference: parseCatalogReference(row.productVersionReference),
        lifecycle: parseProductLifecycle(row.lifecycle),
        ...(Object.hasOwn(row, "categoryClassification")
          ? {
              categoryClassification: parseProductCategoryClassification(
                row.categoryClassification,
              ),
            }
          : {}),
      });
    });
    if (
      products.reduce(
        (sum, row) => sum + (row.categoryClassification?.categoryReferences.length ?? 0),
        0,
      ) > productClassificationMaximumAssignments ||
      new Set(products.map((row) => row.productReference)).size !== products.length ||
      new Set(products.map((row) => row.productVersionReference)).size !== products.length
    )
      return fail();
    return Object.freeze({ generation, observedAt, products: Object.freeze(products) });
  } catch {
    return fail();
  }
}
/** Pure derivation, never an authority or proof of provenance. The runtime must
 * obtain BOTH public sources under current held permissions in one transaction. */
export function deriveCatalogCategoryProductView(
  productValue: ProductClassificationSourceSnapshot,
  categoryValue: CategorySourceSnapshot,
): CatalogCategoryProductView {
  const product = parseProductClassificationSourceSnapshot(productValue);
  const raw = record(copyCategoryPersistenceValue(categoryValue), [
    "brandReference",
    "sourceRevision",
    "observedAt",
    "categories",
    "sourceDigest",
  ]);
  const brand = parseCatalogReference(raw.brandReference),
    revision = categorySourceRevision(raw.sourceRevision),
    observedAt = parseCatalogInstant(raw.observedAt);
  if (
    brand !== product.generation.brandReference ||
    observedAt < product.generation.projectedAt ||
    Date.parse(observedAt) - Date.parse(product.generation.projectedAt) > 30000
  )
    return fail();
  const categories = validateCategoryTreeSnapshot(raw.categories, brand, 10000);
  if (
    raw.sourceDigest !==
      categorySourceDigest({ brandReference: brand, sourceRevision: revision, categories }) ||
    categories.some((node) => node.updatedAt > observedAt)
  )
    return fail();
  const refs = new Set(categories.map((node) => node.categoryReference));
  const counts = new Map(
    categories.map((node) => [
      node.categoryReference,
      { includingArchived: 0, excludingArchived: 0 },
    ]),
  );
  let unknown = 0;
  for (const row of product.products) {
    if (row.categoryClassification === undefined) {
      unknown++;
      continue;
    }
    for (const ref of row.categoryClassification.categoryReferences) {
      if (!refs.has(ref)) return fail();
      const count = counts.get(ref);
      if (!count) return fail();
      count.includingArchived++;
      if (row.lifecycle !== "Archived") count.excludingArchived++;
    }
  }
  return Object.freeze({
    brandReference: brand,
    configuration: "Draft",
    observedAt: observedAt > product.observedAt ? observedAt : product.observedAt,
    productGeneration: product.generation,
    categorySource: Object.freeze({ revision, digest: String(raw.sourceDigest), observedAt }),
    unknownClassificationProductCount: unknown,
    products: product.products,
    categories: Object.freeze(
      categories.map((node) => {
        const count = counts.get(node.categoryReference);
        if (!count) return fail();
        return Object.freeze({
          categoryReference: node.categoryReference,
          internalCode: node.internalCode,
          lifecycle: node.lifecycle,
          defaultLocale: node.defaultLocale,
          localizedNames: node.localizedNames,
          productCount:
            unknown > 0
              ? Object.freeze({ status: "Unavailable" as const })
              : Object.freeze({ status: "Known" as const, ...count }),
        });
      }),
    ),
  });
}
/** Complete direct membership only; missing legacy coverage cannot mean no match.
 * Pagination/search/sort belong to the normal Product query consumer. */
export function selectCatalogCategoryProducts(
  view: CatalogCategoryProductView,
  categoryReference: string,
  includeArchived = false,
): readonly ProductClassificationSourceRow[] {
  const copied = record(copyCategoryPersistenceValue(view), [
    "brandReference",
    "configuration",
    "observedAt",
    "productGeneration",
    "categorySource",
    "unknownClassificationProductCount",
    "products",
    "categories",
  ]);
  const product = parseProductClassificationSourceSnapshot({
    generation: copied.productGeneration,
    observedAt: copied.observedAt,
    products: copied.products,
  });
  const category = parseCatalogReference(categoryReference);
  if (
    copied.configuration !== "Draft" ||
    copied.brandReference !== product.generation.brandReference ||
    typeof includeArchived !== "boolean" ||
    copied.unknownClassificationProductCount !== 0 ||
    product.products.some((row) => row.categoryClassification === undefined) ||
    !Array.isArray(copied.categories)
  )
    return fail();
  const categories = copied.categories.map((value) => {
    const node = record(value, [
      "categoryReference",
      "internalCode",
      "lifecycle",
      "defaultLocale",
      "localizedNames",
      "productCount",
    ]);
    const count = record(node.productCount, ["status", "includingArchived", "excludingArchived"]);
    if (
      count.status !== "Known" ||
      !Number.isSafeInteger(count.includingArchived) ||
      !Number.isSafeInteger(count.excludingArchived) ||
      (count.excludingArchived as number) < 0 ||
      (count.includingArchived as number) < (count.excludingArchived as number)
    )
      return fail();
    return parseCatalogReference(node.categoryReference);
  });
  if (new Set(categories).size !== categories.length || !categories.includes(category))
    return fail();
  return Object.freeze(
    product.products.filter(
      (row) =>
        row.categoryClassification?.categoryReferences.includes(category) &&
        (includeArchived || row.lifecycle !== "Archived"),
    ),
  );
}
