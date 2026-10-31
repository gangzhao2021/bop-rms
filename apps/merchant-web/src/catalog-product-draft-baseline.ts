import {
  parseCatalogReference,
  parseCatalogCode,
  parseCatalogInstant,
  parseProductVersion,
  productCommandRecord,
  ProductCommandClientError,
  type ProductVersion,
  type ProductLifecycle,
  type ProductType,
} from "./catalog-product-command-values.js";
import type { createProductCommandClient } from "./catalog-product-command-client.js";
export class ProductDraftBaselineClientError extends Error {
  constructor(readonly code: "Unavailable" | "Stale") {
    super("Product draft could not be loaded");
    this.name = "ProductDraftBaselineClientError";
  }
}
const fail = (): never => {
  throw new ProductDraftBaselineClientError("Unavailable");
};
function copyBaselineValue(value: unknown): unknown {
  let budget = 100000;
  const seen = new WeakSet<object>();
  const copy = (input: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 12) return fail();
    if (input === null || input === undefined || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) return fail();
      return input;
    }
    if (typeof input === "string") {
      if (input.length > 4096) return fail();
      return input;
    }
    if (!input || typeof input !== "object" || seen.has(input)) return fail();
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        if (
          Object.getPrototypeOf(input) !== Array.prototype ||
          input.length > 10000 ||
          Reflect.ownKeys(input).length !== input.length + 1
        )
          return fail();
        return Object.freeze(
          Array.from({ length: input.length }, (_, n) => {
            const d = Object.getOwnPropertyDescriptor(input, String(n));
            if (!d?.enumerable || !("value" in d)) return fail();
            return copy(d.value, depth + 1);
          }),
        );
      }
      if (Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length > 128)
        return fail();
      return Object.freeze(
        Object.fromEntries(
          Reflect.ownKeys(input).map((key) => {
            if (typeof key !== "string") return fail();
            const d = Object.getOwnPropertyDescriptor(input, key);
            if (!d?.enumerable || !("value" in d)) return fail();
            return [key, copy(d.value, depth + 1)];
          }),
        ),
      );
    } finally {
      seen.delete(input);
    }
  };
  try {
    return copy(value, 0);
  } catch {
    return fail();
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return fail();
  return encoded;
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
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
export function parseCatalogProductDraftBaseline(value: unknown): CatalogProductDraftBaseline {
  try {
    const raw = productCommandRecord(copyBaselineValue(value), [
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
    const projection = productCommandRecord(raw.projection, [
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
export interface ProductDraftBaselineExpectedScope {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly productReference: string;
}
export interface ProductDraftBaselineView {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly baseline: CatalogProductDraftBaseline;
}
function expectedScope(value: unknown): ProductDraftBaselineExpectedScope {
  const raw = productCommandRecord(copyBaselineValue(value), [
    "brandReference",
    "storeReference",
    "productReference",
  ]);
  return Object.freeze({
    brandReference: parseCatalogReference(raw.brandReference),
    storeReference: parseCatalogReference(raw.storeReference),
    productReference: parseCatalogReference(raw.productReference),
  });
}
/** Shape/current scope/freshness validation is not trusted transport or permission evidence. */
export function parseProductDraftBaselineView(
  value: unknown,
  expected: ProductDraftBaselineExpectedScope,
  observedAt: number,
): ProductDraftBaselineView {
  try {
    const selected = expectedScope(expected),
      raw = productCommandRecord(copyBaselineValue(value), ["scope", "baseline"]),
      scope = productCommandRecord(raw.scope, ["brandReference", "storeReference"]),
      baseline = parseCatalogProductDraftBaseline(raw.baseline);
    const brandReference = parseCatalogReference(scope.brandReference),
      storeReference = parseCatalogReference(scope.storeReference);
    if (
      brandReference !== selected.brandReference ||
      storeReference !== selected.storeReference ||
      baseline.brandReference !== brandReference ||
      baseline.productReference !== selected.productReference ||
      !Number.isFinite(observedAt) ||
      Date.parse(baseline.projection.asOfUtc) > observedAt
    )
      return fail();
    if (observedAt - Date.parse(baseline.projection.asOfUtc) > 5000)
      throw new ProductDraftBaselineClientError("Stale");
    return Object.freeze({ scope: Object.freeze({ brandReference, storeReference }), baseline });
  } catch (error) {
    if (error instanceof ProductDraftBaselineClientError) throw error;
    return fail();
  }
}
/** Editing retains a received baseline; server expected-version/authority govern every Save. */
export function createProductDraftEditingSession(
  value: unknown,
  expected: ProductDraftBaselineExpectedScope,
  observedAt: number,
) {
  const selected = expectedScope(expected),
    view = parseProductDraftBaselineView(value, selected, observedAt);
  const parseDraft = (input: unknown, currentScope: ProductDraftBaselineExpectedScope) => {
    const current = expectedScope(currentScope);
    if (!same(current, selected)) throw new ProductDraftBaselineClientError("Stale");
    const draft = parseProductVersion(copyBaselineValue(input));
    if (
      draft.versionReference !== view.baseline.draft.versionReference ||
      draft.createdAt !== view.baseline.draft.createdAt ||
      draft.skus.some(
        (sku) =>
          sku.productReference !== selected.productReference ||
          sku.brandReference !== selected.brandReference,
      ) ||
      (view.baseline.draft.categoryClassification !== undefined &&
        draft.categoryClassification === undefined)
    )
      throw new ProductCommandClientError("Invalid");
    return draft;
  };
  return Object.freeze({
    view,
    observedAt,
    parseDraft,
    prepareSave(
      client: Pick<ReturnType<typeof createProductCommandClient>, "prepareDraft">,
      input: unknown,
      currentScope: ProductDraftBaselineExpectedScope,
    ) {
      const current = expectedScope(currentScope);
      if (!same(current, selected)) throw new ProductDraftBaselineClientError("Stale");
      const raw = productCommandRecord(copyBaselineValue(input), ["operationReference", "draft"]),
        draft = parseDraft(raw.draft, current);
      return client.prepareDraft(
        {
          productReference: view.baseline.productReference,
          expectedAggregateVersion: view.baseline.aggregateVersion,
          operationReference: parseCatalogReference(raw.operationReference),
          draft,
        },
        { brandReference: current.brandReference, storeReference: current.storeReference },
      );
    },
  });
}
export type ProductDraftEditingSession = ReturnType<typeof createProductDraftEditingSession>;
