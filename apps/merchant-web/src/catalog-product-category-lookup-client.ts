// Independent frontend consumer of the scoped related lookup; no Domain access or grants.
export type ProductCategoryLookupErrorCode = "Denied" | "FeatureDisabled" | "Stale" | "Unavailable";
export class ProductCategoryLookupClientError extends Error {
  constructor(readonly code: ProductCategoryLookupErrorCode) {
    super("Product categories could not be loaded");
    this.name = "ProductCategoryLookupClientError";
  }
}
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
  throw new ProductCategoryLookupClientError("Unavailable");
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
        const normalized = parseDisplayName(item.name);
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
function parseDisplayName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.trim().length > 120 ||
    /[<>{}]|\[|\]|https?:\/\/|www\.|(?:^|\s)[#*_`]/iu.test(value)
  )
    return fail();
  return value.trim().replace(/\s+/gu, " ");
}
export interface ProductCategoryLookupScope {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly locale: string;
}
export interface ProductCategoryLookupView {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly lookup: CatalogProductCategoryLookup;
}
function expectedScope(value: unknown): ProductCategoryLookupScope {
  const raw = productListRecord(copyCategoryPersistenceValue(value), [
    "brandReference",
    "storeReference",
    "locale",
  ]);
  return Object.freeze({
    brandReference: parseCatalogReference(raw.brandReference),
    storeReference: parseCatalogReference(raw.storeReference),
    locale: parseCatalogLocale(raw.locale),
  });
}
export function parseProductCategoryLookupView(
  value: unknown,
  parent: ProductCategoryLookupScreen,
  expected: ProductCategoryLookupScope,
): ProductCategoryLookupView {
  try {
    const requested = screen(parent),
      selected = expectedScope(expected);
    const raw = productListRecord(copyCategoryPersistenceValue(value), ["scope", "lookup"]),
      scope = productListRecord(raw.scope, ["brandReference", "storeReference"]),
      lookup = parseCatalogProductCategoryLookup(raw.lookup);
    const brandReference = parseCatalogReference(scope.brandReference),
      storeReference = parseCatalogReference(scope.storeReference);
    if (
      brandReference !== selected.brandReference ||
      storeReference !== selected.storeReference ||
      lookup.brandReference !== brandReference ||
      lookup.locale !== selected.locale ||
      lookup.parentScreenId !== requested
    )
      return fail();
    return Object.freeze({ scope: Object.freeze({ brandReference, storeReference }), lookup });
  } catch {
    return fail();
  }
}
export const productCategoryLookupMaximumResponseBytes = 8 * 1024 * 1024;
export function createProductCategoryLookupClient(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  return Object.freeze({
    async load(
      parent: ProductCategoryLookupScreen,
      expected: ProductCategoryLookupScope,
      signal: AbortSignal,
    ): Promise<ProductCategoryLookupView> {
      const requested = screen(parent),
        selected = expectedScope(expected),
        controller = new AbortController();
      const cancelled = () => new DOMException("Category lookup cancelled", "AbortError");
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(abort, 15000);
      const guard = <T>(promise: Promise<T>): Promise<T> =>
        new Promise((resolve, reject) => {
          const interrupted = () =>
            reject(
              signal.aborted ? cancelled() : new ProductCategoryLookupClientError("Unavailable"),
            );
          if (controller.signal.aborted) {
            void promise.catch(() => undefined);
            interrupted();
            return;
          }
          controller.signal.addEventListener("abort", interrupted, { once: true });
          promise
            .then(resolve, reject)
            .finally(() => controller.signal.removeEventListener("abort", interrupted))
            .catch(() => undefined);
        });
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
        finished = false;
      try {
        if (controller.signal.aborted) throw cancelled();
        const bytes = new TextEncoder().encode(JSON.stringify({ parentScreenId: requested })),
          encoded = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
            .replace(/\+/gu, "-")
            .replace(/\//gu, "_")
            .replace(/=+$/u, "");
        const response = await guard(
          fetcher("/merchant/catalog/products/category-lookup", {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
            headers: { Accept: "application/json", "x-bop-product-category-lookup": encoded },
          }),
        );
        if (
          response.headers.get("cache-control") !== "no-store" ||
          response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
            "application/json" ||
          !response.body ||
          response.redirected
        )
          return fail();
        const length = response.headers.get("content-length");
        if (
          length !== null &&
          (!/^(?:0|[1-9][0-9]*)$/u.test(length) ||
            !Number.isSafeInteger(Number(length)) ||
            Number(length) > productCategoryLookupMaximumResponseBytes)
        )
          return fail();
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let total = 0,
          body = "";
        while (true) {
          const chunk = await guard(reader.read());
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array)) return fail();
          total += chunk.value.byteLength;
          if (total > productCategoryLookupMaximumResponseBytes) return fail();
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
        finished = true;
        if (length !== null && Number(length) !== total) return fail();
        if (controller.signal.aborted) {
          if (signal.aborted) throw cancelled();
          return fail();
        }
        const raw: unknown = JSON.parse(body);
        if (!response.ok) {
          const error = productListRecord(raw, ["error"]).error;
          if (
            (response.status === 401 || response.status === 403) &&
            (error === "request_denied" || error === "product_category_lookup_denied")
          )
            throw new ProductCategoryLookupClientError("Denied");
          if (response.status === 409 && error === "product_category_lookup_feature_disabled")
            throw new ProductCategoryLookupClientError("FeatureDisabled");
          if (response.status === 409 && error === "product_category_lookup_stale")
            throw new ProductCategoryLookupClientError("Stale");
          return fail();
        }
        if (response.status !== 200) return fail();
        const view = parseProductCategoryLookupView(raw, requested, selected),
          observed = now(),
          asOf = Date.parse(view.lookup.projection.asOfUtc);
        if (!Number.isFinite(observed) || asOf > observed) return fail();
        if (observed - asOf > 5000) throw new ProductCategoryLookupClientError("Stale");
        return view;
      } catch (error) {
        if (signal.aborted) throw cancelled();
        if (error instanceof ProductCategoryLookupClientError) throw error;
        return fail();
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (reader) {
          try {
            if (!finished) void reader.cancel().catch(() => undefined);
            reader.releaseLock();
          } catch {
            // Cleanup must not replace the bounded transport error.
          }
        }
        controller.abort();
      }
    },
  });
}
export type ProductCategoryLookupClient = ReturnType<typeof createProductCategoryLookupClient>;
