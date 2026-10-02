import { categorySourceRevision } from "./category-source.js";
import {
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogCode,
  parseCatalogLocale,
  parseLocalizedNames,
  parseProductLifecycle,
  type ProductLifecycle,
  type ProductType,
} from "./product.js";
export class CatalogProductListError extends Error {
  constructor(readonly code: "Invalid" | "Denied" | "FeatureDisabled" | "Unavailable" | "Stale") {
    super("Product list is unavailable");
    this.name = "CatalogProductListError";
  }
}
export type CatalogProductListSort =
  "updatedAt" | "createdAt" | "internalCode" | "lifecycle" | "activeSkuCount" | "name";
export function parseCatalogProductListSort(value: unknown): CatalogProductListSort {
  if (
    !["updatedAt", "createdAt", "internalCode", "lifecycle", "activeSkuCount", "name"].includes(
      value as string,
    )
  )
    throw new CatalogProductListError("Invalid");
  return value as CatalogProductListSort;
}
export interface CatalogProductListRequest {
  readonly actorReference: string;
  readonly purposeCode: string;
  readonly locale: string;
  readonly observedAt: string;
  readonly search: string | null;
  /** Optional for legacy callers; absent means no Category membership filter. */
  readonly categoryReference?: string | null;
  readonly lifecycle: ProductLifecycle | null;
  readonly productType: ProductType | null;
  readonly limit: number;
  readonly cursor: string | null;
  readonly includeArchived: boolean;
  readonly hasActiveSku: boolean | null;
  readonly missingTranslationLocale: string | null;
  readonly updatedFrom: string | null;
  readonly updatedUntil: string | null;
  readonly createdFrom: string | null;
  readonly createdUntil: string | null;
  readonly sort: CatalogProductListSort;
  readonly direction: "ASC" | "DESC";
}
export const catalogProductListCategoryFields = Object.freeze([
  "category",
  "primaryCategoryReference",
  "primaryCategoryName",
  "categoryMembership",
  "categoryFilterOptions",
] as const);
export type CatalogProductListCategory =
  | { readonly status: "Unavailable" }
  | {
      readonly status: "Known";
      readonly configuration: "Draft";
      readonly primary: null | {
        readonly categoryReference: string;
        readonly name: string;
        readonly nameLocale: string;
        readonly localeFallback: boolean;
      };
      readonly matchedCategoryReference: string | null;
      readonly source: {
        readonly revision: string;
        readonly digest: string;
        readonly asOfUtc: string;
      };
    };
export interface CatalogProductListItem {
  readonly productReference: string;
  readonly internalCode: string;
  readonly name: string;
  readonly nameLocale: string;
  readonly localeFallback: boolean;
  readonly productType: ProductType;
  readonly lifecycle: ProductLifecycle;
  readonly aggregateVersion: number;
  readonly updatedAt: string;
  readonly createdAt: string;
  readonly source: { readonly productVersionReference: string; readonly configuration: "Draft" };
  readonly skuCount: number;
  readonly activeSkuCount: number;
  readonly category: CatalogProductListCategory;
  readonly menuCount: { readonly status: "Unavailable" };
  readonly availability: { readonly status: "Unavailable" };
  readonly storeCoverage: { readonly status: "Unavailable" };
  readonly tax: { readonly status: "Unavailable" };
  readonly updatedBy: { readonly status: "Unavailable" };
}
export type CatalogProductListCategoryOptions =
  | { readonly status: "Unavailable" }
  | {
      readonly status: "Known";
      readonly configuration: "Draft";
      readonly source: {
        readonly revision: string;
        readonly digest: string;
        readonly asOfUtc: string;
      };
      readonly items: readonly {
        readonly categoryReference: string;
        readonly internalCode: string;
        readonly name: string;
        readonly nameLocale: string;
        readonly localeFallback: boolean;
        readonly lifecycle: "Draft" | "Active" | "Inactive" | "Archived";
      }[];
    };
export interface CatalogProductListView {
  readonly projection: {
    readonly name: "catalog_product_search_v1";
    readonly version: 1;
    readonly asOfUtc: string;
    readonly stale: boolean;
    readonly partial: true;
  };
  readonly scope: { readonly brandReference: string; readonly storeReference: string | null };
  readonly locale: string;
  readonly hasMore: boolean;
  readonly items: readonly CatalogProductListItem[];
  readonly nextCursor: string | null;
  readonly categoryOptions: CatalogProductListCategoryOptions;
}
const fail = (): never => {
  throw new CatalogProductListError("Invalid");
};
export function productListRecord(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const found = Reflect.ownKeys(value),
    descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    found.length !== keys.length ||
    found.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return fail();
  return Object.fromEntries(
    keys.map((key) => {
      const d = descriptors[key];
      if (!d || !("value" in d)) return fail();
      return [key, d.value];
    }),
  );
}
export function productListArray(value: unknown, max = 200): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    return d.value as unknown;
  });
}
export function productListCopy(value: unknown): unknown {
  let budget = 100_000;
  function copy(item: unknown, depth: number): unknown {
    if (--budget < 0 || depth > 8) return fail();
    if (item === null || typeof item === "boolean" || typeof item === "number") return item;
    if (typeof item === "string") {
      if (item.length > 4096) return fail();
      return item;
    }
    if (Array.isArray(item)) return productListArray(item, 201).map((v) => copy(v, depth + 1));
    if (!item || typeof item !== "object" || Object.getPrototypeOf(item) !== Object.prototype)
      return fail();
    const keys = Reflect.ownKeys(item);
    if (keys.length > 32) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(item);
    return Object.fromEntries(
      keys.map((key) => {
        if (typeof key !== "string") return fail();
        const d = descriptors[key];
        if (!d || !("value" in d)) return fail();
        return [key, copy(d.value, depth + 1)];
      }),
    );
  }
  return copy(value, 0);
}
export function productListInteger(value: unknown, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) return fail();
  return value as number;
}
export function productListType(value: unknown): ProductType {
  if (value !== "PreparedFood" && value !== "NonAlcoholicBeverage") return fail();
  return value;
}
function cursor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,2048}$/u.test(value)) return fail();
  return value;
}
export function parseCatalogProductListRequest(value: unknown): CatalogProductListRequest {
  try {
    const hasCategory =
      value !== null && typeof value === "object" && Object.hasOwn(value, "categoryReference");
    const r = productListRecord(value, [
      "actorReference",
      "purposeCode",
      "locale",
      "observedAt",
      "search",
      "lifecycle",
      "productType",
      "limit",
      "cursor",
      "includeArchived",
      "hasActiveSku",
      "missingTranslationLocale",
      "updatedFrom",
      "updatedUntil",
      "createdFrom",
      "createdUntil",
      "sort",
      "direction",
      ...(hasCategory ? ["categoryReference"] : []),
    ]);
    const limit = productListInteger(r.limit, 1);
    if (limit > 200) return fail();
    if (
      r.search !== null &&
      (typeof r.search !== "string" ||
        r.search.trim().length < 1 ||
        r.search.length > 100 ||
        /[\p{Cc}\p{Cf}]/u.test(r.search))
    )
      return fail();
    if (
      typeof r.includeArchived !== "boolean" ||
      (r.hasActiveSku !== null && typeof r.hasActiveSku !== "boolean")
    )
      return fail();
    const updatedFrom = r.updatedFrom === null ? null : parseCatalogInstant(r.updatedFrom);
    const updatedUntil = r.updatedUntil === null ? null : parseCatalogInstant(r.updatedUntil);
    if (updatedFrom !== null && updatedUntil !== null && updatedFrom >= updatedUntil) return fail();
    const createdFrom = r.createdFrom === null ? null : parseCatalogInstant(r.createdFrom);
    const createdUntil = r.createdUntil === null ? null : parseCatalogInstant(r.createdUntil);
    if (createdFrom !== null && createdUntil !== null && createdFrom >= createdUntil) return fail();
    if (r.direction !== "ASC" && r.direction !== "DESC") return fail();
    const search = r.search === null ? null : (r.search as string).trim().normalize("NFKC");
    if (search !== null && search.length > 100) return fail();
    return Object.freeze({
      actorReference: parseCatalogReference(r.actorReference),
      purposeCode: parseCatalogCode(r.purposeCode),
      locale: parseCatalogLocale(r.locale),
      observedAt: parseCatalogInstant(r.observedAt),
      search,
      categoryReference:
        !hasCategory || r.categoryReference === null
          ? null
          : parseCatalogReference(r.categoryReference),
      lifecycle: r.lifecycle === null ? null : parseProductLifecycle(r.lifecycle),
      productType: r.productType === null ? null : productListType(r.productType),
      limit,
      cursor: cursor(r.cursor),
      includeArchived: r.includeArchived,
      hasActiveSku: r.hasActiveSku as boolean | null,
      missingTranslationLocale:
        r.missingTranslationLocale === null ? null : parseCatalogLocale(r.missingTranslationLocale),
      updatedFrom,
      updatedUntil,
      createdFrom,
      createdUntil,
      sort: parseCatalogProductListSort(r.sort),
      direction: r.direction,
    });
  } catch {
    return fail();
  }
}
function unavailable(value: unknown): { readonly status: "Unavailable" } {
  const r = productListRecord(value, ["status"]);
  if (r.status !== "Unavailable") return fail();
  return Object.freeze({ status: "Unavailable" });
}
function category(value: unknown, locale: string, productAsOf: string): CatalogProductListCategory {
  const status =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "status")
      : undefined;
  if (status && "value" in status && status.value === "Unavailable") return unavailable(value);
  const raw = productListRecord(value, [
    "status",
    "configuration",
    "primary",
    "matchedCategoryReference",
    "source",
  ]);
  const source = productListRecord(raw.source, ["revision", "digest", "asOfUtc"]);
  const asOfUtc = parseCatalogInstant(source.asOfUtc);
  if (
    raw.status !== "Known" ||
    raw.configuration !== "Draft" ||
    asOfUtc < productAsOf ||
    typeof source.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(source.digest)
  )
    return fail();
  let primary: Extract<CatalogProductListCategory, { status: "Known" }>["primary"] = null;
  if (raw.primary !== null) {
    const name = productListRecord(raw.primary, [
      "categoryReference",
      "name",
      "nameLocale",
      "localeFallback",
    ]);
    const nameLocale = parseCatalogLocale(name.nameLocale);
    if (typeof name.localeFallback !== "boolean" || name.localeFallback !== (nameLocale !== locale))
      return fail();
    primary = Object.freeze({
      categoryReference: parseCatalogReference(name.categoryReference),
      name: parseLocalizedNames({ [nameLocale]: name.name }, nameLocale)[nameLocale] ?? fail(),
      nameLocale,
      localeFallback: name.localeFallback,
    });
  }
  return Object.freeze({
    status: "Known",
    configuration: "Draft",
    primary,
    matchedCategoryReference:
      raw.matchedCategoryReference === null
        ? null
        : parseCatalogReference(raw.matchedCategoryReference),
    source: Object.freeze({
      revision: categorySourceRevision(source.revision),
      digest: source.digest,
      asOfUtc,
    }),
  });
}
function categoryOptions(
  value: unknown,
  locale: string,
  asOfUtc: string,
): CatalogProductListCategoryOptions {
  const status =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "status")
      : undefined;
  if (status && "value" in status && status.value === "Unavailable") return unavailable(value);
  const raw = productListRecord(value, ["status", "configuration", "source", "items"]);
  if (raw.status !== "Known" || raw.configuration !== "Draft") return fail();
  const parsed = category(
    {
      status: "Known",
      configuration: "Draft",
      primary: null,
      matchedCategoryReference: null,
      source: raw.source,
    },
    locale,
    asOfUtc,
  );
  if (parsed.status !== "Known") return fail();
  const seen = new Set<string>();
  const items = productListArray(raw.items, 10000).map((value) => {
    const row = productListRecord(value, [
      "categoryReference",
      "internalCode",
      "name",
      "nameLocale",
      "localeFallback",
      "lifecycle",
    ]);
    const { internalCode, lifecycle, ...primary } = row;
    const entry = category(
      {
        status: "Known",
        configuration: "Draft",
        primary,
        matchedCategoryReference: null,
        source: raw.source,
      },
      locale,
      asOfUtc,
    );
    if (
      entry.status !== "Known" ||
      entry.primary === null ||
      seen.has(entry.primary.categoryReference) ||
      !["Draft", "Active", "Inactive", "Archived"].includes(lifecycle as string)
    )
      return fail();
    seen.add(entry.primary.categoryReference);
    return Object.freeze({
      ...entry.primary,
      internalCode: parseCatalogCode(internalCode),
      lifecycle: lifecycle as "Draft" | "Active" | "Inactive" | "Archived",
    });
  });
  return Object.freeze({
    status: "Known",
    configuration: "Draft",
    source: parsed.source,
    items: Object.freeze(items),
  });
}
export function parseCatalogProductListView(value: unknown): CatalogProductListView {
  try {
    const hasOptions =
      value !== null && typeof value === "object" && Object.hasOwn(value, "categoryOptions");
    const r = productListRecord(value, [
        "projection",
        "scope",
        "locale",
        "items",
        "nextCursor",
        "hasMore",
        ...(hasOptions ? ["categoryOptions"] : []),
      ]),
      p = productListRecord(r.projection, ["name", "version", "asOfUtc", "stale", "partial"]),
      s = productListRecord(r.scope, ["brandReference", "storeReference"]);
    if (
      p.name !== "catalog_product_search_v1" ||
      p.version !== 1 ||
      p.partial !== true ||
      typeof p.stale !== "boolean"
    )
      return fail();
    const locale = parseCatalogLocale(r.locale);
    if (typeof r.hasMore !== "boolean" || r.hasMore !== (r.nextCursor !== null)) return fail();
    const asOfUtc = parseCatalogInstant(p.asOfUtc),
      refs = new Set<string>();
    const items = Object.freeze(
      productListArray(r.items).map((value) => {
        const row = productListRecord(value, [
            "productReference",
            "internalCode",
            "name",
            "nameLocale",
            "localeFallback",
            "productType",
            "lifecycle",
            "aggregateVersion",
            "updatedAt",
            "createdAt",
            "source",
            "skuCount",
            "activeSkuCount",
            "category",
            "menuCount",
            "availability",
            "storeCoverage",
            "tax",
            "updatedBy",
          ]),
          source = productListRecord(row.source, ["productVersionReference", "configuration"]);
        const reference = parseCatalogReference(row.productReference),
          updatedAt = parseCatalogInstant(row.updatedAt),
          createdAt = parseCatalogInstant(row.createdAt);
        if (
          refs.has(reference) ||
          updatedAt > asOfUtc ||
          createdAt > updatedAt ||
          typeof row.name !== "string" ||
          row.name.trim().length < 1 ||
          row.name.length > 120 ||
          /[<>{}\p{Cc}\p{Cf}]|https?:\/\/|www\./iu.test(row.name) ||
          typeof row.localeFallback !== "boolean" ||
          row.localeFallback !== (row.nameLocale !== locale) ||
          source.configuration !== "Draft"
        )
          return fail();
        refs.add(reference);
        const skuCount = productListInteger(row.skuCount),
          activeSkuCount = productListInteger(row.activeSkuCount);
        if (activeSkuCount > skuCount) return fail();
        return Object.freeze({
          productReference: reference,
          internalCode: parseCatalogCode(row.internalCode),
          name: row.name,
          nameLocale: parseCatalogLocale(row.nameLocale),
          localeFallback: row.localeFallback,
          productType: productListType(row.productType),
          lifecycle: parseProductLifecycle(row.lifecycle),
          aggregateVersion: productListInteger(row.aggregateVersion, 1),
          updatedAt,
          createdAt,
          source: Object.freeze({
            productVersionReference: parseCatalogReference(source.productVersionReference),
            configuration: "Draft" as const,
          }),
          skuCount,
          activeSkuCount,
          category: category(row.category, locale, asOfUtc),
          menuCount: unavailable(row.menuCount),
          availability: unavailable(row.availability),
          storeCoverage: unavailable(row.storeCoverage),
          tax: unavailable(row.tax),
          updatedBy: unavailable(row.updatedBy),
        });
      }),
    );
    const options = hasOptions
      ? categoryOptions(r.categoryOptions, locale, asOfUtc)
      : Object.freeze({ status: "Unavailable" as const });
    if (options.status === "Known") {
      const choices = new Map(options.items.map((item) => [item.categoryReference, item]));
      for (const item of items) {
        if (item.category.status !== "Known") return fail();
        const current = item.category;
        if (
          current.source.revision !== options.source.revision ||
          current.source.digest !== options.source.digest ||
          current.source.asOfUtc !== options.source.asOfUtc ||
          (current.matchedCategoryReference !== null &&
            !choices.has(current.matchedCategoryReference))
        )
          return fail();
        if (current.primary !== null) {
          const name = choices.get(current.primary.categoryReference);
          if (
            !name ||
            name.name !== current.primary.name ||
            name.nameLocale !== current.primary.nameLocale ||
            name.localeFallback !== current.primary.localeFallback
          )
            return fail();
        }
      }
    }
    return Object.freeze({
      projection: Object.freeze({
        name: "catalog_product_search_v1",
        version: 1,
        asOfUtc,
        stale: p.stale,
        partial: true,
      }),
      scope: Object.freeze({
        brandReference: parseCatalogReference(s.brandReference),
        storeReference: s.storeReference === null ? null : parseCatalogReference(s.storeReference),
      }),
      locale,
      hasMore: r.hasMore,
      items,
      nextCursor: cursor(r.nextCursor),
      categoryOptions: options,
    });
  } catch {
    return fail();
  }
}
