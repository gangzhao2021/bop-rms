// Closed frontend consumer of catalog_category_tree_v1; no owning Domain access.
export type CategoryTreeErrorCode = "Denied" | "FeatureDisabled" | "Stale" | "Unavailable";
export class CategoryTreeClientError extends Error {
  constructor(readonly code: CategoryTreeErrorCode) {
    super("Categories could not be loaded");
    this.name = "CategoryTreeClientError";
  }
}
export const categoryMenuReviewStates = Object.freeze([
  "NoPersistedLifecycle",
  "Draft",
  "InReview",
  "Approved",
  "Published",
  "Archived",
  "Superseded",
] as const);
export type CategoryMenuMeasure =
  { readonly status: "Unavailable" } | { readonly status: "Known"; readonly menuCount: number };
export type CategoryMenuUse =
  | { readonly status: "Unavailable" }
  | {
      readonly status: "Known" | "Partial";
      readonly draftMenuCount: number;
      readonly reviewed: {
        readonly total: CategoryMenuMeasure;
        readonly byLifecycle: Readonly<
          Record<(typeof categoryMenuReviewStates)[number], CategoryMenuMeasure>
        >;
      };
    };
export function parseCategoryMenuUse(
  value: unknown,
  coverage?: "Known" | "Unavailable",
): CategoryMenuUse {
  try {
    const raw = copyCategoryPersistenceValue(value) as Record<string, unknown>;
    if (coverage === undefined) {
      if (productListRecord(raw, ["status"]).status !== "Unavailable") return fail();
      return Object.freeze({ status: "Unavailable" });
    }
    const row = productListRecord(raw, ["status", "draftMenuCount", "reviewed"]),
      draftMenuCount = productListInteger(row.draftMenuCount);
    if (draftMenuCount > 10000 || row.status !== (coverage === "Known" ? "Known" : "Partial"))
      return fail();
    const measure = (value: unknown): CategoryMenuMeasure => {
      const packet = value as Record<string, unknown>;
      if (packet?.status === "Unavailable") {
        if (coverage === "Known") return fail();
        productListRecord(packet, ["status"]);
        return Object.freeze({ status: "Unavailable" });
      }
      const parsed = productListRecord(packet, ["status", "menuCount"]),
        menuCount = productListInteger(parsed.menuCount);
      if (parsed.status !== "Known" || menuCount > 10000) return fail();
      return Object.freeze({ status: "Known", menuCount });
    };
    const reviewed = productListRecord(row.reviewed, ["total", "byLifecycle"]),
      total = measure(reviewed.total);
    const groups = productListRecord(reviewed.byLifecycle, categoryMenuReviewStates);
    const byLifecycle = Object.freeze(
      Object.fromEntries(categoryMenuReviewStates.map((state) => [state, measure(groups[state])])),
    ) as Readonly<Record<(typeof categoryMenuReviewStates)[number], CategoryMenuMeasure>>;
    const partial = Object.values(byLifecycle).some((packet) => packet.status === "Unavailable");
    if ((total.status === "Unavailable") !== partial || (coverage === "Unavailable") !== partial)
      return fail();
    if (total.status === "Known") {
      const counts = Object.values(byLifecycle).map((packet) =>
        packet.status === "Known" ? packet.menuCount : fail(),
      );
      if (
        counts.some((n) => n > total.menuCount) ||
        counts.reduce((a, b) => a + b, 0) < total.menuCount
      )
        return fail();
    }
    return Object.freeze({
      status: partial ? "Partial" : "Known",
      draftMenuCount,
      reviewed: Object.freeze({ total, byLifecycle }),
    });
  } catch {
    return fail();
  }
}

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
  throw new CategoryTreeClientError("Unavailable");
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
const parseCatalogReference = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  )
    return fail();
  return value;
};
function productListRecord(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.fromEntries(
    keys.map((key) => {
      const d = descriptors[key];
      if (!d || !d.enumerable || !("value" in d)) return fail();
      return [key, d.value as unknown];
    }),
  );
}
function productListArray(value: unknown, max: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !d.enumerable || !("value" in d)) return fail();
    return d.value as unknown;
  });
}
const parseCatalogInstant = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return fail();
  return value;
};
const text = (value: unknown, max: number): string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    value !== value.trim() ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    return fail();
  return value;
};
const parseCatalogLocale = (value: unknown) => {
  const v = text(value, 35);
  if (!/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|[0-9]{3})?$/u.test(v)) return fail();
  return v;
};
const productListInteger = (value: unknown, min = 0): number => {
  if (!Number.isSafeInteger(value) || (value as number) < min) return fail();
  return value as number;
};
function parseCatalogCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_-]{0,63}$/u.test(value)) return fail();
  return value;
}

function copyCategoryPersistenceValue(value: unknown): unknown {
  let budget = 100_000;
  const copy = (item: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 12) return fail();
    if (item === undefined || item === null || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return fail();
      return item;
    }
    if (typeof item === "string") {
      if (item.length > 4096) return fail();
      return item;
    }
    if (!item || typeof item !== "object") return fail();
    if (Array.isArray(item)) {
      if (
        Object.getPrototypeOf(item) !== Array.prototype ||
        item.length > 10_000 ||
        Reflect.ownKeys(item).length !== item.length + 1
      )
        return fail();
      return Array.from({ length: item.length }, (_, index) => {
        const d = Object.getOwnPropertyDescriptor(item, String(index));
        if (!d?.enumerable || !("value" in d)) return fail();
        return copy(d.value, depth + 1);
      });
    }
    if (Object.getPrototypeOf(item) !== Object.prototype) return fail();
    const keys = Reflect.ownKeys(item),
      descriptors = Object.getOwnPropertyDescriptors(item);
    if (keys.length > 128) return fail();
    return Object.fromEntries(
      keys.map((key) => {
        if (typeof key !== "string") return fail();
        const d = descriptors[key];
        if (!d?.enumerable || !("value" in d)) return fail();
        return [key, copy(d.value, depth + 1)];
      }),
    );
  };
  return copy(value, 0);
}
export function categorySourceRevision(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,18})$/u.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    return fail();
  return value;
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
    return fail();
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

export const initialCategoryTreeFilters: CatalogCategoryTreeFilters = Object.freeze({
  search: null,
  lifecycle: null,
  productUsage: null,
  includeArchivedProducts: false,
});
export const categoryTreeMaximumResponseCharacters = 6 * 1024 * 1024;
export interface CategoryTreeView {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly query: CatalogCategoryTreeQueryView;
}
export function parseCategoryTreeView(
  value: unknown,
  expected: { readonly brandReference: string; readonly storeReference: string },
): CategoryTreeView {
  const raw = productListRecord(copyCategoryPersistenceValue(value), ["scope", "query"]);
  const scope = productListRecord(raw.scope, ["brandReference", "storeReference"]);
  const brandReference = parseCatalogReference(scope.brandReference),
    storeReference = parseCatalogReference(scope.storeReference);
  const query = parseCatalogCategoryTreeQueryView(raw.query);
  if (
    brandReference !== parseCatalogReference(expected.brandReference) ||
    storeReference !== parseCatalogReference(expected.storeReference) ||
    query.tree.brandReference !== brandReference
  )
    return fail();
  return Object.freeze({ scope: Object.freeze({ brandReference, storeReference }), query });
}
export function createCategoryTreeClient(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  return Object.freeze({
    async load(
      value: CatalogCategoryTreeFilters,
      expected: { readonly brandReference: string; readonly storeReference: string },
      signal: AbortSignal,
    ): Promise<CategoryTreeView> {
      const filters = parseCatalogCategoryTreeFilters(value);
      parseCatalogReference(expected.brandReference);
      parseCatalogReference(expected.storeReference);
      const controller = new AbortController(),
        abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(abort, 15000);
      try {
        if (controller.signal.aborted) return fail();
        const bytes = new TextEncoder().encode(JSON.stringify(filters));
        const encoded = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
          .replace(/\+/gu, "-")
          .replace(/\//gu, "_")
          .replace(/=+$/u, "");
        const response = await fetcher("/merchant/catalog/categories", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          headers: { Accept: "application/json", "x-bop-category-tree": encoded },
        });
        if (
          response.headers.get("cache-control") !== "no-store" ||
          response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
            "application/json"
        )
          return fail();
        const body = await response.text();
        if (controller.signal.aborted || body.length > categoryTreeMaximumResponseCharacters)
          return fail();
        const raw: unknown = JSON.parse(body);
        if (!response.ok) {
          const error = productListRecord(raw, ["error"]).error;
          if (
            (response.status === 401 || response.status === 403) &&
            (error === "request_denied" || error === "category_tree_denied")
          )
            throw new CategoryTreeClientError("Denied");
          if (response.status === 409 && error === "category_tree_feature_disabled")
            throw new CategoryTreeClientError("FeatureDisabled");
          if (response.status === 409 && error === "category_tree_stale")
            throw new CategoryTreeClientError("Stale");
          return fail();
        }
        const view = parseCategoryTreeView(raw, expected);
        if (JSON.stringify(view.query.filters) !== JSON.stringify(filters)) return fail();
        const observed = now();
        if (!Number.isFinite(observed) || Date.parse(view.query.tree.projection.asOfUtc) > observed)
          return fail();
        if (
          observed - Date.parse(view.query.tree.projection.asOfUtc) > 30000 ||
          (view.query.tree.source.menu !== undefined &&
            observed - Date.parse(view.query.tree.source.menu.asOfUtc) > 5000)
        )
          throw new CategoryTreeClientError("Stale");
        return view;
      } catch (error) {
        if (error instanceof CategoryTreeClientError) throw error;
        return fail();
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    },
  });
}
export type CategoryTreeClient = ReturnType<typeof createCategoryTreeClient>;
