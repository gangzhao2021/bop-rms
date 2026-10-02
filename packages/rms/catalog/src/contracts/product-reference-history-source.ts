import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseCatalogInstant, parseCatalogReference } from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  parseProductLifecycleReviewRequest,
  type ProductLifecycleReviewRequest,
} from "./product-lifecycle-review.js";
import {
  buildProductPricingBindingSourceSnapshot,
  parseProductPricingBindingSourceSnapshot,
  type ProductPricingBindingReference,
} from "./product-pricing-binding-source.js";
export const productReferenceHistorySourceMaximumRows = 1000;
export const productReferenceHistorySourceFields = Object.freeze([
  "recordedAggregateVersion",
  "recordCoverage",
  "versionReference",
  "skuReferences",
  "categoryCoverage",
  "categoryReferences",
  "primaryCategoryReference",
  "taxClassificationReference",
  "bindings",
] as const);
/** Held reads also derive current target facts; they require independent field authority. */
export const productReferenceHistoryCurrentSourceFields = Object.freeze([
  ...productReferenceHistorySourceFields,
  "aggregateVersion",
  "productLifecycle",
  "skuLifecycle",
  "activeSkuCount",
] as const);
export interface RecordedProductReferenceConfiguration {
  readonly versionReference: string;
  readonly skuReferences: readonly string[];
  readonly categoryCoverage: "Known" | "Unavailable";
  readonly categoryReferences: readonly string[] | null;
  readonly primaryCategoryReference: string | null;
  readonly taxClassificationReference: string | null;
  readonly bindings: readonly ProductPricingBindingReference[];
}
export interface ProductReferenceHistorySourceSnapshot {
  readonly request: ProductLifecycleReviewRequest;
  readonly profile: "RecordedDraftConfigurations";
  readonly coverage: "Complete";
  readonly publicationCoverage: "Unavailable";
  readonly futureScheduleCoverage: "Unavailable";
  readonly consistency: "StatementSnapshot";
  readonly observedAt: string;
  readonly recordedAggregateVersion: number;
  readonly configurations: readonly RecordedProductReferenceConfiguration[];
  readonly digest: string;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function exact(v: unknown, keys: readonly string[]) {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Reflect.ownKeys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    return fail();
  return v as Record<string, unknown>;
}
/** Immutable recorded Draft graphs, never an inferred publication, future schedule or approved sale. */
export function buildProductReferenceHistorySourceSnapshot(
  value: unknown,
  input: ProductLifecycleReviewRequest,
  now: string,
): ProductReferenceHistorySourceSnapshot {
  try {
    const request = parseProductLifecycleReviewRequest(input),
      raw = exact(copyCategoryPersistenceValue(value), [
        "observedAt",
        "targetExists",
        "recordedAggregateVersion",
        "recordCoverage",
        "configurations",
      ]),
      observedAt = parseCatalogInstant(raw.observedAt),
      at = parseCatalogInstant(now);
    if (
      raw.targetExists !== true ||
      raw.recordCoverage !== true ||
      !Number.isSafeInteger(raw.recordedAggregateVersion) ||
      (raw.recordedAggregateVersion as number) < request.expectedAggregateVersion ||
      (raw.recordedAggregateVersion as number) > 2147483647 ||
      observedAt > at ||
      Date.parse(at) - Date.parse(observedAt) > 5000 ||
      !Array.isArray(raw.configurations) ||
      raw.configurations.length === 0 ||
      raw.configurations.length > productReferenceHistorySourceMaximumRows
    )
      return fail();
    const distinct = new Map<string, RecordedProductReferenceConfiguration>();
    for (const value of raw.configurations) {
      const r = exact(value, [
          "versionReference",
          "categoryClassificationKnown",
          "categoryReferences",
          "primaryCategoryReference",
          "taxClassificationReference",
          "skuReferences",
          "bindings",
        ]),
        versionReference = parseCatalogReference(r.versionReference);
      // Reuse only the owning closed reference graph validation; historical version isn't current target truth.
      const graph = buildProductPricingBindingSourceSnapshot(
        { observedAt, targetExists: true, precise: true, ...r },
        { ...request, originalProductVersionReference: versionReference, skuReference: null },
        at,
      );
      const configuration: RecordedProductReferenceConfiguration = Object.freeze({
        versionReference: graph.versionReference,
        skuReferences: graph.skuReferences,
        categoryCoverage: graph.categoryCoverage,
        categoryReferences: graph.categoryReferences,
        primaryCategoryReference: graph.primaryCategoryReference,
        taxClassificationReference: graph.taxClassificationReference,
        bindings: graph.bindings,
      });
      distinct.set(canonicalizeRfc8785(configuration), configuration);
    }
    const configurations = Object.freeze(
      [...distinct.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v),
    );
    if (
      !configurations.some((c) => c.versionReference === request.originalProductVersionReference) ||
      (request.skuReference !== null &&
        !configurations.some((c) => c.skuReferences.includes(request.skuReference as string)))
    )
      return fail();
    const content = { request, profile: "RecordedDraftConfigurations" as const, configurations };
    return Object.freeze({
      ...content,
      coverage: "Complete",
      publicationCoverage: "Unavailable",
      futureScheduleCoverage: "Unavailable",
      consistency: "StatementSnapshot",
      observedAt,
      recordedAggregateVersion: raw.recordedAggregateVersion as number,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(content)),
    });
  } catch {
    return fail();
  }
}

/** Validate the public recorded profile without accepting changed scope, digest, coverage or derived facts. */
export function parseProductReferenceHistorySourceSnapshot(
  value: unknown,
  input: ProductLifecycleReviewRequest,
  now: string,
): ProductReferenceHistorySourceSnapshot {
  try {
    const raw = exact(copyCategoryPersistenceValue(value), [
      "request",
      "profile",
      "coverage",
      "publicationCoverage",
      "futureScheduleCoverage",
      "consistency",
      "observedAt",
      "recordedAggregateVersion",
      "configurations",
      "digest",
    ]);
    if (!Array.isArray(raw.configurations)) return fail();
    const configurations = raw.configurations.map((value) => {
      const c = exact(value, [
        "versionReference",
        "skuReferences",
        "categoryCoverage",
        "categoryReferences",
        "primaryCategoryReference",
        "taxClassificationReference",
        "bindings",
      ]);
      if (c.categoryCoverage !== "Known" && c.categoryCoverage !== "Unavailable") return fail();
      return {
        versionReference: c.versionReference,
        skuReferences: c.skuReferences,
        categoryClassificationKnown: c.categoryCoverage === "Known",
        categoryReferences: c.categoryReferences,
        primaryCategoryReference: c.primaryCategoryReference,
        taxClassificationReference: c.taxClassificationReference,
        bindings: c.bindings,
      };
    });
    const parsed = buildProductReferenceHistorySourceSnapshot(
      {
        observedAt: raw.observedAt,
        targetExists: true,
        recordedAggregateVersion: raw.recordedAggregateVersion,
        recordCoverage: true,
        configurations,
      },
      input,
      now,
    );
    if (canonicalizeRfc8785(parsed) !== canonicalizeRfc8785(raw)) return fail();
    return parsed;
  } catch {
    return fail();
  }
}

/** Current and recorded reference profiles must describe the same original owner revision.
 * Supplied DTOs remain data; the caller still needs both actual current source holders. */
export function parseProductCurrentReferenceHistoryPair(
  currentValue: unknown,
  recordedValue: unknown,
  input: ProductLifecycleReviewRequest,
  now: string,
) {
  try {
    const request = parseProductLifecycleReviewRequest(input),
      current = parseProductPricingBindingSourceSnapshot(currentValue, request, now),
      recorded = parseProductReferenceHistorySourceSnapshot(recordedValue, request, now);
    if (recorded.recordedAggregateVersion !== request.expectedAggregateVersion) return fail();
    const graph: RecordedProductReferenceConfiguration = {
      versionReference: current.versionReference,
      skuReferences: current.skuReferences,
      categoryCoverage: current.categoryCoverage,
      categoryReferences: current.categoryReferences,
      primaryCategoryReference: current.primaryCategoryReference,
      taxClassificationReference: current.taxClassificationReference,
      bindings: current.bindings,
    };
    const key = canonicalizeRfc8785(graph);
    if (!recorded.configurations.some((c) => canonicalizeRfc8785(c) === key)) return fail();
    return Object.freeze({ current, recorded });
  } catch {
    return fail();
  }
}
