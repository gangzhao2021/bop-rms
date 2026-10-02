export type ProductListErrorCode =
  | "Denied"
  | "FeatureDisabled"
  | "Stale"
  | "NotFound"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class ProductListClientError extends Error {
  constructor(readonly code: ProductListErrorCode) {
    super("Products could not be loaded");
    this.name = "ProductListClientError";
  }
}
const fail = (): never => {
  throw new ProductListClientError("Unavailable");
};
const ref = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  )
    return fail();
  return value;
};
function record(value: unknown, keys: readonly string[]) {
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
function array(value: unknown, max: number): readonly unknown[] {
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
const instant = (value: unknown): string => {
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
const locale = (value: unknown) => {
  const v = text(value, 35);
  if (!/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|[0-9]{3})?$/u.test(v)) return fail();
  return v;
};
const integer = (value: unknown, min = 0): number => {
  if (!Number.isSafeInteger(value) || (value as number) < min) return fail();
  return value as number;
};
const lifecycle = (value: unknown) => {
  if (
    !(["Draft", "Active", "Suspended", "Discontinued", "Archived"] as readonly unknown[]).includes(
      value,
    )
  )
    return fail();
  return value as "Draft" | "Active" | "Suspended" | "Discontinued" | "Archived";
};
const productType = (value: unknown) => {
  if (value !== "PreparedFood" && value !== "NonAlcoholicBeverage") return fail();
  return value;
};
const cursor = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,2048}$/u.test(value)) return fail();
  return value;
};
export type ProductListSort =
  "updatedAt" | "createdAt" | "internalCode" | "lifecycle" | "activeSkuCount" | "name";
const sort = (value: unknown): ProductListSort => {
  if (
    !["updatedAt", "createdAt", "internalCode", "lifecycle", "activeSkuCount", "name"].includes(
      value as string,
    )
  )
    return fail();
  return value as ProductListSort;
};
export interface ProductListFilters {
  readonly search: string | null;
  readonly categoryReference?: string | null;
  readonly lifecycle: "Draft" | "Active" | "Suspended" | "Discontinued" | "Archived" | null;
  readonly productType: "PreparedFood" | "NonAlcoholicBeverage" | null;
  readonly limit: number;
  readonly cursor: string | null;
  readonly includeArchived: boolean;
  readonly hasActiveSku: boolean | null;
  readonly missingTranslationLocale: string | null;
  readonly updatedFrom: string | null;
  readonly updatedUntil: string | null;
  readonly createdFrom: string | null;
  readonly createdUntil: string | null;
  readonly sort: ProductListSort;
  readonly direction: "ASC" | "DESC";
}
export const initialProductListFilters: ProductListFilters = Object.freeze({
  search: null,
  lifecycle: null,
  productType: null,
  limit: 50,
  cursor: null,
  includeArchived: false,
  hasActiveSku: null,
  missingTranslationLocale: null,
  updatedFrom: null,
  updatedUntil: null,
  createdFrom: null,
  createdUntil: null,
  sort: "updatedAt",
  direction: "DESC",
});
export function parseProductListFilters(value: unknown): ProductListFilters {
  const hasCategory =
    value !== null && typeof value === "object" && Object.hasOwn(value, "categoryReference");
  const raw = record(value, [
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
  const search = raw.search === null ? null : text(raw.search, 100).normalize("NFKC");
  if (
    (search !== null && (search.length > 100 || /[\p{Cc}\p{Cf}]/u.test(search))) ||
    integer(raw.limit, 1) > 200 ||
    typeof raw.includeArchived !== "boolean" ||
    (raw.hasActiveSku !== null && typeof raw.hasActiveSku !== "boolean")
  )
    return fail();
  const updatedFrom = raw.updatedFrom === null ? null : instant(raw.updatedFrom);
  const updatedUntil = raw.updatedUntil === null ? null : instant(raw.updatedUntil);
  if (updatedFrom !== null && updatedUntil !== null && updatedFrom >= updatedUntil) return fail();
  const createdFrom = raw.createdFrom === null ? null : instant(raw.createdFrom);
  const createdUntil = raw.createdUntil === null ? null : instant(raw.createdUntil);
  if (createdFrom !== null && createdUntil !== null && createdFrom >= createdUntil) return fail();
  if (raw.direction !== "ASC" && raw.direction !== "DESC") return fail();
  return Object.freeze({
    search,
    ...(hasCategory
      ? { categoryReference: raw.categoryReference === null ? null : ref(raw.categoryReference) }
      : {}),
    lifecycle: raw.lifecycle === null ? null : lifecycle(raw.lifecycle),
    productType: raw.productType === null ? null : productType(raw.productType),
    limit: raw.limit as number,
    cursor: cursor(raw.cursor),
    includeArchived: raw.includeArchived,
    hasActiveSku: raw.hasActiveSku as boolean | null,
    missingTranslationLocale:
      raw.missingTranslationLocale === null ? null : locale(raw.missingTranslationLocale),
    updatedFrom,
    updatedUntil,
    createdFrom,
    createdUntil,
    sort: sort(raw.sort),
    direction: raw.direction,
  });
}
export type ProductListCategory =
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
function category(value: unknown, lang: string, productAsOf: string): ProductListCategory {
  const status =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "status")
      : undefined;
  if (status && "value" in status && status.value === "Unavailable") {
    if (record(value, ["status"]).status !== "Unavailable") return fail();
    return Object.freeze({ status: "Unavailable" });
  }
  const raw = record(value, [
    "status",
    "configuration",
    "primary",
    "matchedCategoryReference",
    "source",
  ]);
  const source = record(raw.source, ["revision", "digest", "asOfUtc"]);
  const asOfUtc = instant(source.asOfUtc);
  if (
    raw.status !== "Known" ||
    raw.configuration !== "Draft" ||
    asOfUtc < productAsOf ||
    typeof source.revision !== "string" ||
    !/^(?:0|[1-9][0-9]{0,18})$/u.test(source.revision) ||
    BigInt(source.revision) > 9223372036854775807n ||
    typeof source.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(source.digest)
  )
    return fail();
  let primary: Extract<ProductListCategory, { status: "Known" }>["primary"] = null;
  if (raw.primary !== null) {
    const row = record(raw.primary, ["categoryReference", "name", "nameLocale", "localeFallback"]);
    const nameLocale = locale(row.nameLocale),
      name = text(row.name, 120);
    if (
      typeof row.localeFallback !== "boolean" ||
      row.localeFallback !== (nameLocale !== lang) ||
      /[<>{}]|https?:\/\/|www\./iu.test(name)
    )
      return fail();
    primary = Object.freeze({
      categoryReference: ref(row.categoryReference),
      name,
      nameLocale,
      localeFallback: row.localeFallback,
    });
  }
  return Object.freeze({
    status: "Known",
    configuration: "Draft",
    primary,
    matchedCategoryReference:
      raw.matchedCategoryReference === null ? null : ref(raw.matchedCategoryReference),
    source: Object.freeze({ revision: source.revision, digest: source.digest, asOfUtc }),
  });
}
export const productListMaximumResponseCharacters = 6 * 1024 * 1024;
export type ProductListCategoryOptions =
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
function categoryOptions(
  value: unknown,
  lang: string,
  asOfUtc: string,
): ProductListCategoryOptions {
  const status =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "status")
      : undefined;
  if (status && "value" in status && status.value === "Unavailable") {
    if (record(value, ["status"]).status !== "Unavailable") return fail();
    return Object.freeze({ status: "Unavailable" });
  }
  const raw = record(value, ["status", "configuration", "source", "items"]);
  if (raw.status !== "Known" || raw.configuration !== "Draft") return fail();
  const source = category(
    {
      status: "Known",
      configuration: "Draft",
      primary: null,
      matchedCategoryReference: null,
      source: raw.source,
    },
    lang,
    asOfUtc,
  );
  if (source.status !== "Known") return fail();
  const seen = new Set<string>();
  const items = array(raw.items, 10000).map((value) => {
    const row = record(value, [
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
      lang,
      asOfUtc,
    );
    const code = text(internalCode, 64);
    if (
      entry.status !== "Known" ||
      entry.primary === null ||
      seen.has(entry.primary.categoryReference) ||
      !/^[A-Z][A-Z0-9_-]{0,63}$/u.test(code) ||
      !["Draft", "Active", "Inactive", "Archived"].includes(lifecycle as string)
    )
      return fail();
    seen.add(entry.primary.categoryReference);
    return Object.freeze({
      ...entry.primary,
      internalCode: code,
      lifecycle: lifecycle as "Draft" | "Active" | "Inactive" | "Archived",
    });
  });
  return Object.freeze({
    status: "Known",
    configuration: "Draft",
    source: source.source,
    items: Object.freeze(items),
  });
}
export function parseProductListView(value: unknown, expectedStore: string) {
  ref(expectedStore);
  const hasOptions =
    value !== null && typeof value === "object" && Object.hasOwn(value, "categoryOptions");
  const raw = record(value, [
      "projection",
      "scope",
      "locale",
      "items",
      "hasMore",
      "nextCursor",
      ...(hasOptions ? ["categoryOptions"] : []),
    ]),
    projection = record(raw.projection, ["name", "version", "asOfUtc", "stale", "partial"]),
    scope = record(raw.scope, ["brandReference", "storeReference"]),
    lang = locale(raw.locale);
  const asOfUtc = instant(projection.asOfUtc);
  if (
    projection.name !== "catalog_product_search_v1" ||
    projection.version !== 1 ||
    typeof projection.stale !== "boolean" ||
    projection.partial !== true ||
    scope.storeReference !== expectedStore ||
    typeof raw.hasMore !== "boolean"
  )
    return fail();
  const seen = new Set<string>();
  const items = array(raw.items, 200).map((value) => {
    const row = record(value, [
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
    ]);
    const source = record(row.source, ["productVersionReference", "configuration"]),
      reference = ref(row.productReference),
      nameLocale = locale(row.nameLocale),
      updatedAt = instant(row.updatedAt),
      createdAt = instant(row.createdAt),
      code = text(row.internalCode, 64),
      skuCount = integer(row.skuCount),
      activeSkuCount = integer(row.activeSkuCount);
    if (
      seen.has(reference) ||
      !/^[A-Z][A-Z0-9_-]{0,63}$/u.test(code) ||
      source.configuration !== "Draft" ||
      row.localeFallback !== (nameLocale !== lang) ||
      updatedAt > asOfUtc ||
      createdAt > updatedAt ||
      activeSkuCount > skuCount
    )
      return fail();
    seen.add(reference);
    const unavailable = (value: unknown) => {
      if (record(value, ["status"]).status !== "Unavailable") return fail();
      return Object.freeze({ status: "Unavailable" as const });
    };
    return Object.freeze({
      productReference: reference,
      internalCode: code,
      name: text(row.name, 120),
      nameLocale,
      localeFallback: row.localeFallback as boolean,
      productType: productType(row.productType),
      lifecycle: lifecycle(row.lifecycle),
      aggregateVersion: integer(row.aggregateVersion, 1),
      updatedAt,
      createdAt,
      source: Object.freeze({
        productVersionReference: ref(source.productVersionReference),
        configuration: "Draft" as const,
      }),
      skuCount,
      activeSkuCount,
      category: category(row.category, lang, asOfUtc),
      menuCount: unavailable(row.menuCount),
      availability: unavailable(row.availability),
      storeCoverage: unavailable(row.storeCoverage),
      tax: unavailable(row.tax),
      updatedBy: unavailable(row.updatedBy),
    });
  });
  const nextCursor = cursor(raw.nextCursor);
  if (raw.hasMore !== (nextCursor !== null) || (raw.hasMore && items.length === 0)) return fail();
  const options = hasOptions
    ? categoryOptions(raw.categoryOptions, lang, asOfUtc)
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
      name: "catalog_product_search_v1" as const,
      version: 1 as const,
      asOfUtc,
      stale: projection.stale,
      partial: true as const,
    }),
    scope: Object.freeze({
      brandReference: ref(scope.brandReference),
      storeReference: ref(scope.storeReference),
    }),
    locale: lang,
    items: Object.freeze(items),
    hasMore: raw.hasMore,
    nextCursor,
    categoryOptions: options,
  });
}
export type ProductListView = ReturnType<typeof parseProductListView>;
export function createProductListClient(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  return Object.freeze({
    async load(
      value: ProductListFilters,
      expectedStore: string,
      signal: AbortSignal,
    ): Promise<ProductListView> {
      const filters = parseProductListFilters(value);
      ref(expectedStore);
      const controller = new AbortController(),
        abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(abort, 15_000);
      try {
        if (controller.signal.aborted) return fail();
        // UTF-8 header transport avoids names/cursors in URL and accepts non-Latin search.
        const bytes = new TextEncoder().encode(JSON.stringify(filters));
        const encoded = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
          .replace(/\+/gu, "-")
          .replace(/\//gu, "_")
          .replace(/=+$/u, "");
        const response = await fetcher("/merchant/catalog/products", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          headers: { Accept: "application/json", "x-bop-product-list": encoded },
        });
        if (
          response.headers.get("cache-control") !== "no-store" ||
          !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
        )
          return fail();
        const body = await response.text();
        if (controller.signal.aborted || body.length > productListMaximumResponseCharacters)
          return fail();
        const raw: unknown = JSON.parse(body);
        if (!response.ok) {
          const error = record(raw, ["error"]).error;
          if (
            (response.status === 401 || response.status === 403) &&
            (error === "request_denied" || error === "product_list_denied")
          )
            throw new ProductListClientError("Denied");
          if (response.status === 409 && error === "product_list_feature_disabled")
            throw new ProductListClientError("FeatureDisabled");
          if (response.status === 409 && error === "product_list_stale")
            throw new ProductListClientError("Stale");
          return fail();
        }
        const view = parseProductListView(raw, expectedStore);
        if (
          view.items.some(
            (row) =>
              (filters.categoryReference != null &&
                (row.category.status !== "Known" ||
                  row.category.matchedCategoryReference !== filters.categoryReference)) ||
              (row.category.status === "Known" &&
                row.category.matchedCategoryReference !== (filters.categoryReference ?? null)) ||
              (filters.hasActiveSku !== null && filters.hasActiveSku !== row.activeSkuCount > 0) ||
              (filters.missingTranslationLocale !== null &&
                row.nameLocale === filters.missingTranslationLocale) ||
              (filters.updatedFrom !== null && row.updatedAt < filters.updatedFrom) ||
              (filters.updatedUntil !== null && row.updatedAt >= filters.updatedUntil) ||
              (filters.createdFrom !== null && row.createdAt < filters.createdFrom) ||
              (filters.createdUntil !== null && row.createdAt >= filters.createdUntil),
          ) ||
          view.items.length > filters.limit ||
          (view.hasMore && view.items.length !== filters.limit) ||
          view.projection.asOfUtc > new Date(now()).toISOString()
        )
          return fail();
        if (view.projection.stale || now() - Date.parse(view.projection.asOfUtc) > 30_000)
          throw new ProductListClientError("Stale");
        return view;
      } catch (error) {
        if (error instanceof ProductListClientError) throw error;
        return fail();
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    },
  });
}
export type ProductListClient = ReturnType<typeof createProductListClient>;
