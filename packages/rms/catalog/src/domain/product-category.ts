import {
  CatalogError,
  parseCatalogReference,
  parseProductCategoryClassification,
  type ProductCategoryClassification,
  type CatalogReference,
} from "./product.js";
import type { CategoryLifecycle } from "./category-menu.js";

export interface ProductCategoryReferenceFact {
  readonly categoryReference: CatalogReference;
  readonly brandReference: CatalogReference;
  readonly lifecycle: CategoryLifecycle;
}
export interface ProductCategoryAssignmentPolicy {
  readonly allowedLifecycles: readonly ("Draft" | "Active")[];
}
const invalid = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return invalid();
  const result: Record<string, unknown> = {};
  for (const key of fields) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !("value" in d) || !d.enumerable) return invalid();
    result[key] = d.value;
  }
  return result;
}
function items(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !length ||
    !("value" in length) ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0 ||
    length.value > 10000
  )
    return invalid();
  const n: number = length.value;
  if (Reflect.ownKeys(value).length !== n + 1) return invalid();
  const result: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !("value" in d) || !d.enumerable) return invalid();
    result.push(d.value);
  }
  return result;
}
/** Pure invariant validation only. Application/persistence must obtain these
 * facts and policy from current held public owners in the same transaction;
 * neither caller data nor this value proves authorization/source completeness.
 */
export function validateProductCategoryClassification(
  value: unknown,
  input: {
    readonly brandReference: string;
    readonly categories: readonly ProductCategoryReferenceFact[];
    readonly policy: ProductCategoryAssignmentPolicy;
  },
): ProductCategoryClassification {
  const classification = parseProductCategoryClassification(value);
  let brand: CatalogReference;
  let allowed: readonly unknown[];
  const facts = new Map<CatalogReference, ProductCategoryReferenceFact>();
  try {
    const scope = closed(input, ["brandReference", "categories", "policy"]);
    brand = parseCatalogReference(scope.brandReference);
    allowed = items(closed(scope.policy, ["allowedLifecycles"]).allowedLifecycles);
    if (
      allowed.some((x) => x !== "Draft" && x !== "Active") ||
      new Set(allowed).size !== allowed.length
    )
      return invalid();
    for (const value of items(scope.categories)) {
      const fact = closed(value, ["categoryReference", "brandReference", "lifecycle"]);
      const ref = parseCatalogReference(fact.categoryReference);
      const brandReference = parseCatalogReference(fact.brandReference);
      if (
        facts.has(ref) ||
        brandReference !== brand ||
        typeof fact.lifecycle !== "string" ||
        !["Draft", "Active", "Inactive", "Archived"].includes(fact.lifecycle)
      )
        return invalid();
      facts.set(
        ref,
        Object.freeze({
          categoryReference: ref,
          brandReference,
          lifecycle: fact.lifecycle as CategoryLifecycle,
        }),
      );
    }
  } catch {
    return invalid();
  }
  for (const ref of classification.categoryReferences) {
    const fact = facts.get(ref);
    if (!fact) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
    if (!allowed.includes(fact.lifecycle)) throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
  }
  return classification;
}
