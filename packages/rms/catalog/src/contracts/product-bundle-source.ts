import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogHash,
} from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  parseProductLifecycleReviewRequest,
  type ProductLifecycleReviewRequest,
} from "./product-lifecycle-review.js";
import type { BundleLifecycle } from "./bundle.js";
export const productBundleSourceMaximumRows = 1000;
const referenceFields = [
  "bundleReference",
  "brandReference",
  "aggregateVersion",
  "lifecycle",
  "currentVersionReference",
  "updatedAt",
  "bundleVersionReference",
  "versionStatus",
  "versionUpdatedAt",
  "publishedAt",
  "validationDigest",
  "groupReference",
  "sellableType",
  "sellableReference",
] as const;
export const productBundleSourceFields = Object.freeze([
  "targetExists",
  "skuReferences",
  ...referenceFields,
] as const);
export interface ProductBundleReference {
  readonly bundleReference: string;
  readonly brandReference: string;
  readonly aggregateVersion: number;
  readonly lifecycle: BundleLifecycle;
  readonly currentVersionReference: string;
  readonly updatedAt: string;
  readonly bundleVersionReference: string;
  readonly versionStatus: "Draft" | "Published";
  readonly versionUpdatedAt: string;
  readonly publishedAt: string | null;
  readonly validationDigest: string | null;
  readonly groupReference: string;
  readonly sellableType: "Product" | "Sku";
  readonly sellableReference: string;
  readonly isCurrentVersion: boolean;
}
export interface ProductBundleSourceSnapshot {
  readonly request: ProductLifecycleReviewRequest;
  readonly consistency: "StatementSnapshot";
  readonly coverage: "Complete";
  readonly observedAt: string;
  readonly digest: string;
  readonly skuReferences: readonly string[];
  readonly references: readonly ProductBundleReference[];
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
/** Complete references includes history; current sale and lifecycle policy remain separate facts. */
export function buildProductBundleSourceSnapshot(
  value: unknown,
  input: ProductLifecycleReviewRequest,
  now: string,
): ProductBundleSourceSnapshot {
  try {
    const request = parseProductLifecycleReviewRequest(input),
      r = exact(copyCategoryPersistenceValue(value), [
        "observedAt",
        "targetExists",
        "skuReferences",
        "references",
      ]),
      observedAt = parseCatalogInstant(r.observedAt),
      at = Date.parse(parseCatalogInstant(now));
    if (
      r.targetExists !== true ||
      Date.parse(observedAt) > at ||
      at - Date.parse(observedAt) > 5000 ||
      !Array.isArray(r.skuReferences) ||
      !Array.isArray(r.references) ||
      r.skuReferences.length > productBundleSourceMaximumRows ||
      r.references.length > productBundleSourceMaximumRows
    )
      return fail();
    const skuReferences = r.skuReferences.map(parseCatalogReference);
    if (
      new Set(skuReferences).size !== skuReferences.length ||
      (request.skuReference !== null &&
        (skuReferences.length !== 1 || skuReferences[0] !== request.skuReference))
    )
      return fail();
    const roots = new Map<string, string>(),
      versions = new Map<string, string>(),
      groups = new Map<string, string>(),
      identities = new Set<string>();
    const consistent = (map: Map<string, string>, key: string, value: unknown) => {
      const digest = canonicalizeRfc8785(value),
        prior = map.get(key);
      if (prior !== undefined && prior !== digest) return fail();
      map.set(key, digest);
    };
    const references = r.references.map((value) => {
      const row = exact(value, ["reference", "precise", "coherent"]);
      if (row.precise !== true || row.coherent !== true) return fail();
      const v = exact(row.reference, referenceFields),
        brandReference = parseCatalogReference(v.brandReference),
        sellableReference = parseCatalogReference(v.sellableReference),
        updatedAt = parseCatalogInstant(v.updatedAt),
        versionUpdatedAt = parseCatalogInstant(v.versionUpdatedAt),
        publishedAt = v.publishedAt === null ? null : parseCatalogInstant(v.publishedAt),
        validationDigest =
          v.validationDigest === null
            ? null
            : typeof v.validationDigest === "string" && v.validationDigest.startsWith("sha256:")
              ? "sha256:" + parseCatalogHash(v.validationDigest.slice(7))
              : fail();
      if (
        brandReference !== request.brandReference ||
        (v.sellableType === "Product"
          ? sellableReference !== request.productReference
          : v.sellableType !== "Sku" || !skuReferences.includes(sellableReference)) ||
        !Number.isSafeInteger(v.aggregateVersion) ||
        (v.aggregateVersion as number) < 1 ||
        (v.aggregateVersion as number) > 2147483647 ||
        !["Draft", "Published", "Suspended", "Discontinued", "Archived"].includes(
          v.lifecycle as string,
        ) ||
        (v.versionStatus !== "Draft" && v.versionStatus !== "Published") ||
        (v.versionStatus === "Draft"
          ? publishedAt !== null || validationDigest !== null
          : publishedAt === null || validationDigest === null) ||
        updatedAt > observedAt ||
        versionUpdatedAt > observedAt ||
        (publishedAt !== null && publishedAt > observedAt)
      )
        return fail();
      const root = {
        bundleReference: parseCatalogReference(v.bundleReference),
        brandReference,
        aggregateVersion: v.aggregateVersion as number,
        lifecycle: v.lifecycle as BundleLifecycle,
        currentVersionReference: parseCatalogReference(v.currentVersionReference),
        updatedAt,
      };
      const version = {
        bundleReference: root.bundleReference,
        bundleVersionReference: parseCatalogReference(v.bundleVersionReference),
        versionStatus: v.versionStatus as "Draft" | "Published",
        versionUpdatedAt,
        publishedAt,
        validationDigest,
      };
      const groupReference = parseCatalogReference(v.groupReference),
        identity = groupReference + ":" + sellableReference;
      consistent(roots, root.bundleReference, root);
      consistent(versions, version.bundleVersionReference, version);
      consistent(groups, groupReference, {
        bundleReference: root.bundleReference,
        bundleVersionReference: version.bundleVersionReference,
      });
      if (identities.has(identity)) return fail();
      identities.add(identity);
      return Object.freeze({
        ...root,
        ...version,
        groupReference,
        sellableType: v.sellableType as "Product" | "Sku",
        sellableReference,
        isCurrentVersion: root.currentVersionReference === version.bundleVersionReference,
      });
    });
    skuReferences.sort();
    references.sort(
      (a, b) =>
        a.groupReference.localeCompare(b.groupReference) ||
        a.sellableReference.localeCompare(b.sellableReference),
    );
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
