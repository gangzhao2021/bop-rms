import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogCode,
} from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  parseProductLifecycleReviewRequest,
  type ProductLifecycleReviewRequest,
} from "./product-lifecycle-review.js";
export const productPricingBindingSourceMaximumRows = 1000;
export const productPricingBindingSourceFields = Object.freeze([
  "targetExists",
  "versionReference",
  "categoryClassificationKnown",
  "categoryReferences",
  "primaryCategoryReference",
  "taxClassificationReference",
  "skuReferences",
  "bindingReference",
  "optionSetReference",
  "optionSetVersionReference",
  "enabledOptionReferences",
  "includedSkuReferences",
  "excludedSkuReferences",
  "channelCodes",
] as const);
/** Held reads also derive current target facts; they require independent field authority. */
export const productPricingBindingCurrentSourceFields = Object.freeze([
  ...productPricingBindingSourceFields,
  "aggregateVersion",
  "productLifecycle",
  "skuLifecycle",
  "activeSkuCount",
] as const);
export interface ProductPricingBindingReference {
  readonly bindingReference: string;
  readonly optionSetReference: string;
  readonly optionSetVersionReference: string;
  readonly enabledOptionReferences: readonly string[];
  readonly includedSkuReferences: readonly string[];
  readonly excludedSkuReferences: readonly string[];
  readonly channelCodes: readonly string[];
}
export interface ProductPricingBindingSourceSnapshot {
  readonly request: ProductLifecycleReviewRequest;
  readonly profile: "CurrentDraftBindings";
  readonly coverage: "Complete";
  readonly consistency: "StatementSnapshot";
  readonly observedAt: string;
  readonly digest: string;
  readonly versionReference: string;
  readonly skuReferences: readonly string[];
  readonly categoryCoverage: "Known" | "Unavailable";
  readonly categoryReferences: readonly string[] | null;
  readonly primaryCategoryReference: string | null;
  readonly taxClassificationReference: string | null;
  readonly bindings: readonly ProductPricingBindingReference[];
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
function list(
  v: unknown,
  parse: (v: unknown) => string = parseCatalogReference,
): readonly string[] {
  if (!Array.isArray(v) || v.length > productPricingBindingSourceMaximumRows) return fail();
  const values = v.map(parse);
  if (values.some((value, index) => value !== v[index])) return fail();
  if (new Set(values).size !== values.length) return fail();
  return Object.freeze(values.sort());
}
const optional = (v: unknown) => (v === null ? null : parseCatalogReference(v));
/** Current persisted Draft reference facts only; unknown classification isn't absence, and membership isn't sale approval. */
export function buildProductPricingBindingSourceSnapshot(
  value: unknown,
  input: ProductLifecycleReviewRequest,
  now: string,
): ProductPricingBindingSourceSnapshot {
  try {
    const request = parseProductLifecycleReviewRequest(input),
      raw = exact(copyCategoryPersistenceValue(value), [
        "observedAt",
        "targetExists",
        "precise",
        "versionReference",
        "categoryClassificationKnown",
        "categoryReferences",
        "primaryCategoryReference",
        "taxClassificationReference",
        "skuReferences",
        "bindings",
      ]),
      observedAt = parseCatalogInstant(raw.observedAt),
      at = parseCatalogInstant(now);
    if (
      raw.targetExists !== true ||
      raw.precise !== true ||
      observedAt > at ||
      Date.parse(at) - Date.parse(observedAt) > 5000 ||
      typeof raw.categoryClassificationKnown !== "boolean" ||
      !Array.isArray(raw.bindings) ||
      raw.bindings.length > productPricingBindingSourceMaximumRows
    )
      return fail();
    const versionReference = parseCatalogReference(raw.versionReference),
      skuReferences = list(raw.skuReferences),
      primaryCategoryReference = optional(raw.primaryCategoryReference),
      taxClassificationReference = optional(raw.taxClassificationReference),
      categoryReferences = raw.categoryClassificationKnown ? list(raw.categoryReferences) : null;
    if (
      versionReference !== request.originalProductVersionReference ||
      (request.skuReference !== null && !skuReferences.includes(request.skuReference)) ||
      (!raw.categoryClassificationKnown &&
        (raw.categoryReferences !== null || primaryCategoryReference !== null)) ||
      (primaryCategoryReference !== null && !categoryReferences?.includes(primaryCategoryReference))
    )
      return fail();
    const seen = new Set<string>();
    const bindings = raw.bindings
      .map((value) => {
        const b = exact(value, [
            "bindingReference",
            "optionSetReference",
            "optionSetVersionReference",
            "enabledOptionReferences",
            "includedSkuReferences",
            "excludedSkuReferences",
            "channelCodes",
          ]),
          bindingReference = parseCatalogReference(b.bindingReference),
          includedSkuReferences = list(b.includedSkuReferences),
          excludedSkuReferences = list(b.excludedSkuReferences);
        if (
          seen.has(bindingReference) ||
          [...includedSkuReferences, ...excludedSkuReferences].some(
            (s) => !skuReferences.includes(s),
          ) ||
          includedSkuReferences.some((s) => excludedSkuReferences.includes(s))
        )
          return fail();
        seen.add(bindingReference);
        return Object.freeze({
          bindingReference,
          optionSetReference: parseCatalogReference(b.optionSetReference),
          optionSetVersionReference: parseCatalogReference(b.optionSetVersionReference),
          enabledOptionReferences: list(b.enabledOptionReferences),
          includedSkuReferences,
          excludedSkuReferences,
          channelCodes: list(b.channelCodes, parseCatalogCode),
        });
      })
      .sort((a, b) => a.bindingReference.localeCompare(b.bindingReference));
    const source = {
      request,
      profile: "CurrentDraftBindings" as const,
      versionReference,
      skuReferences,
      categoryCoverage: raw.categoryClassificationKnown
        ? ("Known" as const)
        : ("Unavailable" as const),
      categoryReferences,
      primaryCategoryReference,
      taxClassificationReference,
      bindings: Object.freeze(bindings),
    };
    return Object.freeze({
      ...source,
      coverage: "Complete",
      consistency: "StatementSnapshot",
      observedAt,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(source)),
    });
  } catch {
    return fail();
  }
}

/** Validate the public profile without accepting altered coverage, request, digest or derived metadata. */
export function parseProductPricingBindingSourceSnapshot(
  value: unknown,
  input: ProductLifecycleReviewRequest,
  now: string,
): ProductPricingBindingSourceSnapshot {
  try {
    const raw = exact(copyCategoryPersistenceValue(value), [
      "request",
      "profile",
      "coverage",
      "consistency",
      "observedAt",
      "digest",
      "versionReference",
      "skuReferences",
      "categoryCoverage",
      "categoryReferences",
      "primaryCategoryReference",
      "taxClassificationReference",
      "bindings",
    ]);
    if (raw.categoryCoverage !== "Known" && raw.categoryCoverage !== "Unavailable") return fail();
    const parsed = buildProductPricingBindingSourceSnapshot(
      {
        observedAt: raw.observedAt,
        targetExists: true,
        precise: true,
        versionReference: raw.versionReference,
        categoryClassificationKnown: raw.categoryCoverage === "Known",
        categoryReferences: raw.categoryReferences,
        primaryCategoryReference: raw.primaryCategoryReference,
        taxClassificationReference: raw.taxClassificationReference,
        skuReferences: raw.skuReferences,
        bindings: raw.bindings,
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
