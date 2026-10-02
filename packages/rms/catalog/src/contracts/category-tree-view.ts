import {
  CatalogError,
  parseCatalogCode,
  parseCatalogInstant,
  parseCatalogLocale,
  parseCatalogReference,
} from "./product.js";
import {
  copyCategoryPersistenceValue,
  validateCategoryTreeSnapshot,
} from "./category-persistence.js";
import { categorySourceRevision, type CategorySourceSnapshot } from "./category-source.js";
import {
  deriveCatalogCategoryProductView,
  type ProductClassificationSourceSnapshot,
} from "./product-category-source.js";
import { productListArray, productListInteger, productListRecord } from "./product-list.js";

import {
  deriveCategoryMenuUse,
  parseCategoryMenuUse,
  type CategoryMenuUse,
} from "./category-menu-use.js";
import type { MenuCategorySourceSnapshot } from "./menu-category-source.js";
export const categoryTreeViewFields = Object.freeze([
  "categoryReference",
  "internalCode",
  "localizedNames",
  "lifecycle",
  "parentCategoryReference",
  "level",
  "sortOrder",
  "aggregateVersion",
  "productCount",
  "source",
] as const);
export const categoryTreeMenuViewFields = Object.freeze([
  ...categoryTreeViewFields,
  "menuUse",
] as const);
export interface CatalogCategoryTreeView {
  readonly projection: {
    readonly name: "catalog_category_tree_v1";
    readonly version: 1;
    readonly asOfUtc: string;
    readonly stale: false;
    readonly partial: true;
  };
  readonly brandReference: string;
  readonly locale: string;
  readonly configuration: "Draft";
  readonly classificationCoverage: "Known" | "Unavailable";
  readonly source: {
    readonly menu?: {
      readonly digest: string;
      readonly asOfUtc: string;
      readonly consistency: "StatementSnapshot";
      readonly reviewCategoryCoverage: "Known" | "Unavailable";
    };
    readonly category: {
      readonly revision: string;
      readonly digest: string;
      readonly asOfUtc: string;
    };
    readonly products: {
      readonly generationReference: string;
      readonly revision: string;
      readonly digest: string;
      readonly asOfUtc: string;
    };
  };
  readonly items: readonly {
    readonly categoryReference: string;
    readonly internalCode: string;
    readonly name: string;
    readonly nameLocale: string;
    readonly localeFallback: boolean;
    readonly lifecycle: "Draft" | "Active" | "Inactive" | "Archived";
    readonly parentCategoryReference: string | null;
    readonly level: 1 | 2 | 3;
    readonly sortOrder: number;
    readonly aggregateVersion: string;
    readonly productCount:
      | { readonly status: "Unavailable" }
      | {
          readonly status: "Known";
          readonly includingArchived: number;
          readonly excludingArchived: number;
        };
    readonly menuUse: CategoryMenuUse;
  }[];
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) return fail();
  return value;
}
function displayName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 120 ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    return fail();
  return value;
}
/** Closed complete owner view. A parser verifies structure, never grants access or provenance. */
export function parseCatalogCategoryTreeView(value: unknown): CatalogCategoryTreeView {
  try {
    const raw = productListRecord(copyCategoryPersistenceValue(value), [
      "projection",
      "brandReference",
      "locale",
      "configuration",
      "classificationCoverage",
      "source",
      "items",
    ]);
    const projection = productListRecord(raw.projection, [
      "name",
      "version",
      "asOfUtc",
      "stale",
      "partial",
    ]);
    if (
      projection.name !== "catalog_category_tree_v1" ||
      projection.version !== 1 ||
      projection.stale !== false ||
      projection.partial !== true ||
      raw.configuration !== "Draft" ||
      !["Known", "Unavailable"].includes(raw.classificationCoverage as string)
    )
      return fail();
    const asOfUtc = parseCatalogInstant(projection.asOfUtc),
      locale = parseCatalogLocale(raw.locale);
    const hasMenu =
      raw.source !== null && typeof raw.source === "object" && Object.hasOwn(raw.source, "menu");
    const source = productListRecord(raw.source, [
      "category",
      "products",
      ...(hasMenu ? ["menu"] : []),
    ]);
    let menu: CatalogCategoryTreeView["source"]["menu"];
    if (Object.hasOwn(source, "menu")) {
      const packet = productListRecord(source.menu, [
        "digest",
        "asOfUtc",
        "consistency",
        "reviewCategoryCoverage",
      ]);
      const menuAt = parseCatalogInstant(packet.asOfUtc);
      if (
        packet.consistency !== "StatementSnapshot" ||
        !["Known", "Unavailable"].includes(packet.reviewCategoryCoverage as string) ||
        menuAt > asOfUtc ||
        Date.parse(asOfUtc) - Date.parse(menuAt) > 5000
      )
        return fail();
      menu = Object.freeze({
        digest: hash(packet.digest),
        asOfUtc: menuAt,
        consistency: "StatementSnapshot",
        reviewCategoryCoverage: packet.reviewCategoryCoverage as "Known" | "Unavailable",
      });
    }
    const category = productListRecord(source.category, ["revision", "digest", "asOfUtc"]);
    const products = productListRecord(source.products, [
      "generationReference",
      "revision",
      "digest",
      "asOfUtc",
    ]);
    const categoryAt = parseCatalogInstant(category.asOfUtc),
      productsAt = parseCatalogInstant(products.asOfUtc);
    if (
      categoryAt !== asOfUtc ||
      productsAt > asOfUtc ||
      Date.parse(asOfUtc) - Date.parse(productsAt) > 30000
    )
      return fail();
    const refs = new Set<string>(),
      codes = new Set<string>(),
      siblings = new Set<string>();
    const items = productListArray(raw.items, 10000).map((value) => {
      const item = productListRecord(value, [
        "categoryReference",
        "internalCode",
        "name",
        "nameLocale",
        "localeFallback",
        "lifecycle",
        "parentCategoryReference",
        "level",
        "sortOrder",
        "aggregateVersion",
        "productCount",
        "menuUse",
      ]);
      const categoryReference = parseCatalogReference(item.categoryReference),
        internalCode = parseCatalogCode(item.internalCode),
        nameLocale = parseCatalogLocale(item.nameLocale);
      const parentCategoryReference =
        item.parentCategoryReference === null
          ? null
          : parseCatalogReference(item.parentCategoryReference);
      const level = productListInteger(item.level, 1),
        sortOrder = productListInteger(item.sortOrder);
      const sibling = (parentCategoryReference ?? "root") + ":" + sortOrder;
      if (
        refs.has(categoryReference) ||
        codes.has(internalCode) ||
        siblings.has(sibling) ||
        level > 3 ||
        typeof item.localeFallback !== "boolean" ||
        item.localeFallback !== (nameLocale !== locale) ||
        !["Draft", "Active", "Inactive", "Archived"].includes(item.lifecycle as string) ||
        typeof item.aggregateVersion !== "string" ||
        !/^[1-9][0-9]{0,15}$/u.test(item.aggregateVersion) ||
        BigInt(item.aggregateVersion) > BigInt(Number.MAX_SAFE_INTEGER)
      )
        return fail();
      refs.add(categoryReference);
      codes.add(internalCode);
      siblings.add(sibling);
      let productCount: CatalogCategoryTreeView["items"][number]["productCount"];
      if (raw.classificationCoverage === "Unavailable") {
        if (productListRecord(item.productCount, ["status"]).status !== "Unavailable")
          return fail();
        productCount = Object.freeze({ status: "Unavailable" });
      } else {
        const count = productListRecord(item.productCount, [
          "status",
          "includingArchived",
          "excludingArchived",
        ]);
        const includingArchived = productListInteger(count.includingArchived),
          excludingArchived = productListInteger(count.excludingArchived);
        if (
          count.status !== "Known" ||
          excludingArchived > includingArchived ||
          includingArchived > 10000
        )
          return fail();
        productCount = Object.freeze({ status: "Known", includingArchived, excludingArchived });
      }
      const menuUse = parseCategoryMenuUse(item.menuUse, menu?.reviewCategoryCoverage);
      return Object.freeze({
        categoryReference,
        internalCode,
        name: displayName(item.name),
        nameLocale,
        localeFallback: item.localeFallback,
        lifecycle: item.lifecycle as CatalogCategoryTreeView["items"][number]["lifecycle"],
        parentCategoryReference,
        level: level as 1 | 2 | 3,
        sortOrder,
        aggregateVersion: item.aggregateVersion,
        productCount,
        menuUse,
      });
    });
    const byId = new Map(items.map((item) => [item.categoryReference, item]));
    for (const item of items) {
      let parent = item.parentCategoryReference,
        level = 1;
      const ancestors = new Set([item.categoryReference]);
      while (parent !== null) {
        if (ancestors.has(parent) || ++level > 3) return fail();
        ancestors.add(parent);
        const node = byId.get(parent);
        if (!node) return fail();
        parent = node.parentCategoryReference;
      }
      if (level !== item.level) return fail();
    }
    const children = new Map<string | null, typeof items>();
    for (const item of items) {
      const group = children.get(item.parentCategoryReference) ?? [];
      group.push(item);
      children.set(item.parentCategoryReference, group);
    }
    const ordered: typeof items = [];
    const visit = (parent: string | null) => {
      for (const item of (children.get(parent) ?? []).sort((a, b) => a.sortOrder - b.sortOrder)) {
        ordered.push(item);
        visit(item.categoryReference);
      }
    };
    visit(null);
    if (
      ordered.length !== items.length ||
      items.some((item, index) => ordered[index]?.categoryReference !== item.categoryReference)
    )
      return fail();
    return Object.freeze({
      projection: Object.freeze({
        name: "catalog_category_tree_v1",
        version: 1,
        asOfUtc,
        stale: false,
        partial: true,
      }),
      brandReference: parseCatalogReference(raw.brandReference),
      locale,
      configuration: "Draft",
      classificationCoverage: raw.classificationCoverage as "Known" | "Unavailable",
      source: Object.freeze({
        ...(menu === undefined ? {} : { menu }),
        category: Object.freeze({
          revision: categorySourceRevision(category.revision),
          digest: hash(category.digest),
          asOfUtc: categoryAt,
        }),
        products: Object.freeze({
          generationReference: parseCatalogReference(products.generationReference),
          revision: categorySourceRevision(products.revision),
          digest: hash(products.digest),
          asOfUtc: productsAt,
        }),
      }),
      items: Object.freeze(items),
    });
  } catch {
    return fail();
  }
}
/** Derive only from complete public owner snapshots. Runtime holders supply provenance. */
export function deriveCatalogCategoryTreeView(
  product: ProductClassificationSourceSnapshot,
  category: CategorySourceSnapshot,
  requestedLocale: unknown,
  menu?: MenuCategorySourceSnapshot,
): CatalogCategoryTreeView {
  const safeCategory = copyCategoryPersistenceValue(category) as CategorySourceSnapshot;
  const view = deriveCatalogCategoryProductView(product, safeCategory),
    locale = parseCatalogLocale(requestedLocale);
  const raw = productListRecord(safeCategory, [
    "brandReference",
    "sourceRevision",
    "observedAt",
    "categories",
    "sourceDigest",
  ]);
  const categories = validateCategoryTreeSnapshot(raw.categories, view.brandReference, 10000);
  const menuView = menu === undefined ? undefined : deriveCategoryMenuUse(menu, safeCategory);
  const menuCounts = new Map(
    menuView?.categories.map((row) => [row.categoryReference, row.menuUse]) ?? [],
  );
  const counts = new Map(
    view.categories.map((node) => [node.categoryReference, node.productCount]),
  );
  const byParent = new Map<string | null, (typeof categories)[number][]>();
  for (const node of categories) {
    const group = byParent.get(node.parentCategoryReference) ?? [];
    group.push(node);
    byParent.set(node.parentCategoryReference, group);
  }
  const items: CatalogCategoryTreeView["items"][number][] = [];
  const visit = (parent: string | null) => {
    for (const node of (byParent.get(parent) ?? []).sort((a, b) => a.sortOrder - b.sortOrder)) {
      const nameLocale = Object.hasOwn(node.localizedNames, locale) ? locale : node.defaultLocale;
      items.push({
        categoryReference: node.categoryReference,
        internalCode: node.internalCode,
        name: node.localizedNames[nameLocale] ?? fail(),
        nameLocale,
        localeFallback: nameLocale !== locale,
        lifecycle: node.lifecycle,
        parentCategoryReference: node.parentCategoryReference,
        level: node.level,
        sortOrder: node.sortOrder,
        aggregateVersion: String(node.aggregateVersion),
        productCount: counts.get(node.categoryReference) ?? fail(),
        menuUse:
          menuView === undefined
            ? { status: "Unavailable" }
            : (menuCounts.get(node.categoryReference) ?? fail()),
      });
      visit(node.categoryReference);
    }
  };
  visit(null);
  return parseCatalogCategoryTreeView({
    projection: {
      name: "catalog_category_tree_v1",
      version: 1,
      asOfUtc: view.categorySource.observedAt,
      stale: false,
      partial: true,
    },
    brandReference: view.brandReference,
    locale,
    configuration: "Draft",
    classificationCoverage: view.unknownClassificationProductCount === 0 ? "Known" : "Unavailable",
    source: {
      ...(menuView === undefined ? {} : { menu: menuView.source }),
      category: {
        revision: view.categorySource.revision,
        digest: view.categorySource.digest,
        asOfUtc: view.categorySource.observedAt,
      },
      products: {
        generationReference: view.productGeneration.generationReference,
        revision: view.productGeneration.sourceRevision,
        digest: view.productGeneration.sourceDigest,
        asOfUtc: view.productGeneration.projectedAt,
      },
    },
    items,
  });
}

export interface CatalogCategoryTreeFilters {
  readonly search: string | null;
  readonly lifecycle: "Draft" | "Active" | "Inactive" | "Archived" | null;
  readonly productUsage: "Empty" | "Used" | null;
  readonly includeArchivedProducts: boolean;
}
export interface CatalogCategoryTreeQueryView {
  readonly tree: CatalogCategoryTreeView;
  readonly filters: CatalogCategoryTreeFilters;
  readonly matchedCategoryReferences: readonly string[];
}
export function parseCatalogCategoryTreeFilters(value: unknown): CatalogCategoryTreeFilters {
  try {
    const raw = productListRecord(copyCategoryPersistenceValue(value), [
      "search",
      "lifecycle",
      "productUsage",
      "includeArchivedProducts",
    ]);
    if (
      (raw.search !== null &&
        (typeof raw.search !== "string" ||
          raw.search.trim().length < 1 ||
          raw.search.length > 100 ||
          /[\p{Cc}\p{Cf}]/u.test(raw.search))) ||
      (raw.lifecycle !== null &&
        !["Draft", "Active", "Inactive", "Archived"].includes(raw.lifecycle as string)) ||
      (raw.productUsage !== null && raw.productUsage !== "Empty" && raw.productUsage !== "Used") ||
      typeof raw.includeArchivedProducts !== "boolean"
    )
      throw new Error("invalid filters");
    return Object.freeze({
      search: raw.search as string | null,
      lifecycle: raw.lifecycle as CatalogCategoryTreeFilters["lifecycle"],
      productUsage: raw.productUsage as CatalogCategoryTreeFilters["productUsage"],
      includeArchivedProducts: raw.includeArchivedProducts,
    });
  } catch {
    throw new CatalogError("CATALOG_INPUT_INVALID");
  }
}
function baseMatch(
  item: CatalogCategoryTreeView["items"][number],
  filters: CatalogCategoryTreeFilters,
): boolean {
  if (filters.lifecycle !== null && item.lifecycle !== filters.lifecycle) return false;
  if (filters.productUsage === null) return true;
  if (item.productCount.status !== "Known") return fail();
  const count = filters.includeArchivedProducts
    ? item.productCount.includingArchived
    : item.productCount.excludingArchived;
  return filters.productUsage === "Empty" ? count === 0 : count > 0;
}
export function parseCatalogCategoryTreeQueryView(value: unknown): CatalogCategoryTreeQueryView {
  try {
    const raw = productListRecord(copyCategoryPersistenceValue(value), [
      "tree",
      "filters",
      "matchedCategoryReferences",
    ]);
    const tree = parseCatalogCategoryTreeView(raw.tree),
      filters = parseCatalogCategoryTreeFilters(raw.filters);
    if (filters.productUsage !== null && tree.classificationCoverage !== "Known") return fail();
    const candidates = tree.items
      .filter((item) => baseMatch(item, filters))
      .map((item) => item.categoryReference);
    const positions = new Map(candidates.map((reference, index) => [reference, index]));
    let last = -1;
    const matchedCategoryReferences = productListArray(raw.matchedCategoryReferences, 10000).map(
      (value) => {
        const reference = parseCatalogReference(value),
          index = positions.get(reference);
        if (index === undefined || index <= last) return fail();
        last = index;
        return reference;
      },
    );
    if (
      filters.search === null &&
      (matchedCategoryReferences.length !== candidates.length ||
        matchedCategoryReferences.some((ref, index) => candidates[index] !== ref))
    )
      return fail();
    return Object.freeze({
      tree,
      filters,
      matchedCategoryReferences: Object.freeze(matchedCategoryReferences),
    });
  } catch {
    return fail();
  }
}
/** Filters are side-effect free; matching references do not replace the full parent graph. */
export function deriveCatalogCategoryTreeQueryView(
  product: ProductClassificationSourceSnapshot,
  category: CategorySourceSnapshot,
  locale: unknown,
  filterValue: unknown,
  menu?: MenuCategorySourceSnapshot,
): CatalogCategoryTreeQueryView {
  const filters = parseCatalogCategoryTreeFilters(filterValue);
  const safeCategory = copyCategoryPersistenceValue(category) as CategorySourceSnapshot;
  const tree = deriveCatalogCategoryTreeView(product, safeCategory, locale, menu);
  if (filters.productUsage !== null && tree.classificationCoverage !== "Known") return fail();
  const nodes = new Map<string, CategorySourceSnapshot["categories"][number]>(
    safeCategory.categories.map((node) => [node.categoryReference, node]),
  );
  const normalize = (text: string) => text.normalize("NFKC").toLowerCase();
  const query = filters.search === null ? null : normalize(filters.search.trim());
  const matchedCategoryReferences = tree.items
    .filter((item) => {
      if (!baseMatch(item, filters)) return false;
      if (query === null) return true;
      const node = nodes.get(item.categoryReference);
      if (!node) return fail();
      return [node.internalCode, ...Object.values(node.localizedNames)].some((text) =>
        normalize(text).includes(query),
      );
    })
    .map((item) => item.categoryReference);
  return parseCatalogCategoryTreeQueryView({ tree, filters, matchedCategoryReferences });
}
