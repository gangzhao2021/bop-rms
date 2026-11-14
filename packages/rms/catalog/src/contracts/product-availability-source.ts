import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseCatalogInstant, parseCatalogReference } from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  parseProductLifecycleReviewRequest,
  type ProductLifecycleReviewRequest,
} from "./product-lifecycle-review.js";

export const productAvailabilitySourceMaximumRows = 1000;
export const productAvailabilitySourceFields = Object.freeze([
  "targetExists",
  "skuReferences",
  "ruleReference",
  "brandReference",
  "sellableType",
  "sellableReference",
  "storeReference",
  "aggregateVersion",
  "lifecycle",
  "effectiveFrom",
  "effectiveUntil",
  "updatedAt",
] as const);
export interface ProductAvailabilityReference {
  readonly ruleReference: string;
  readonly brandReference: string;
  readonly sellableType: "Product" | "Sku";
  readonly sellableReference: string;
  readonly storeReference: string | null;
  readonly aggregateVersion: number;
  readonly lifecycle: "Draft" | "Active" | "Inactive" | "Archived";
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly updatedAt: string;
}
export interface ProductAvailabilitySourceSnapshot {
  readonly request: ProductLifecycleReviewRequest;
  readonly consistency: "StatementSnapshot";
  readonly coverage: "Complete";
  readonly observedAt: string;
  readonly digest: string;
  readonly skuReferences: readonly string[];
  readonly references: readonly ProductAvailabilityReference[];
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function exact(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    return fail();
  return value as Record<string, unknown>;
}
/** All relevant references, including other Stores, future/expired and inactive rules.
 * No sale decision, source revision, policy approval or held-writer guarantee. */
export function buildProductAvailabilitySourceSnapshot(
  value: unknown,
  input: ProductLifecycleReviewRequest,
  now: string,
): ProductAvailabilitySourceSnapshot {
  try {
    const request = parseProductLifecycleReviewRequest(input),
      r = exact(copyCategoryPersistenceValue(value), [
        "observedAt",
        "targetExists",
        "skuReferences",
        "rules",
      ]),
      observedAt = parseCatalogInstant(r.observedAt),
      at = Date.parse(parseCatalogInstant(now));
    if (
      r.targetExists !== true ||
      Date.parse(observedAt) > at ||
      at - Date.parse(observedAt) > 5000 ||
      !Array.isArray(r.skuReferences) ||
      !Array.isArray(r.rules) ||
      r.skuReferences.length > productAvailabilitySourceMaximumRows ||
      r.rules.length > productAvailabilitySourceMaximumRows
    )
      return fail();
    const skuReferences = r.skuReferences.map(parseCatalogReference);
    if (
      new Set(skuReferences).size !== skuReferences.length ||
      (request.skuReference !== null &&
        (skuReferences.length !== 1 || skuReferences[0] !== request.skuReference))
    )
      return fail();
    const references = r.rules.map((value) => {
      const row = exact(value, ["rule", "precise"]);
      if (row.precise !== true) return fail();
      const rule = exact(row.rule, [
          "ruleReference",
          "brandReference",
          "sellableType",
          "sellableReference",
          "storeReference",
          "aggregateVersion",
          "lifecycle",
          "effectiveFrom",
          "effectiveUntil",
          "updatedAt",
        ]),
        brandReference = parseCatalogReference(rule.brandReference),
        sellableReference = parseCatalogReference(rule.sellableReference),
        effectiveFrom = parseCatalogInstant(rule.effectiveFrom),
        effectiveUntil =
          rule.effectiveUntil === null ? null : parseCatalogInstant(rule.effectiveUntil),
        updatedAt = parseCatalogInstant(rule.updatedAt);
      if (
        brandReference !== request.brandReference ||
        (rule.sellableType === "Product"
          ? sellableReference !== request.productReference
          : rule.sellableType !== "Sku" || !skuReferences.includes(sellableReference)) ||
        !Number.isSafeInteger(rule.aggregateVersion) ||
        (rule.aggregateVersion as number) < 1 ||
        (rule.aggregateVersion as number) > 2147483647 ||
        !["Draft", "Active", "Inactive", "Archived"].includes(rule.lifecycle as string) ||
        updatedAt > observedAt ||
        (effectiveUntil !== null && effectiveUntil <= effectiveFrom)
      )
        return fail();
      return Object.freeze({
        ruleReference: parseCatalogReference(rule.ruleReference),
        brandReference,
        sellableType: rule.sellableType as "Product" | "Sku",
        sellableReference,
        storeReference:
          rule.storeReference === null ? null : parseCatalogReference(rule.storeReference),
        aggregateVersion: rule.aggregateVersion as number,
        lifecycle: rule.lifecycle as ProductAvailabilityReference["lifecycle"],
        effectiveFrom,
        effectiveUntil,
        updatedAt,
      });
    });
    if (new Set(references.map((rule) => rule.ruleReference)).size !== references.length)
      return fail();
    skuReferences.sort();
    references.sort((a, b) => a.ruleReference.localeCompare(b.ruleReference));
    const source = {
      request,
      skuReferences: Object.freeze(skuReferences),
      references: Object.freeze(references),
    };
    return Object.freeze({
      ...source,
      consistency: "StatementSnapshot",
      coverage: "Complete",
      observedAt,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(source)),
    });
  } catch {
    return fail();
  }
}
