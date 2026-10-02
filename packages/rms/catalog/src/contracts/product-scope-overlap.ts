import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseCatalogInstant } from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  parseProductPublicationVersion,
  productPublicationScopeLevels,
} from "./product-publication.js";
import { planProductSelectorOverlaps } from "../domain/product-scope-overlap.js";
const fail = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
/** Closed, detached and fingerprinted structural plan. Supplied precedence is not
 * a current owning policy source. Persist only after the writer holds that source. */
export function buildCatalogProductScopeOverlapPlan(value: unknown) {
  const v = copyCategoryPersistenceValue(value);
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail();
  const r = v as Record<string, unknown>;
  const keys = ["incoming", "existing", "scopeOrder", "observedAt"];
  if (
    Object.keys(r).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(r, key)) ||
    !Array.isArray(r.existing) ||
    r.existing.length > 1000 ||
    !Array.isArray(r.scopeOrder) ||
    r.scopeOrder.some(
      (level) => !(productPublicationScopeLevels as readonly unknown[]).includes(level),
    )
  )
    return fail();
  const incoming = parseProductPublicationVersion(r.incoming);
  const existing = r.existing
    .map(parseProductPublicationVersion)
    .sort((a, b) =>
      a.versionReference < b.versionReference
        ? -1
        : a.versionReference > b.versionReference
          ? 1
          : 0,
    );
  for (const c of [incoming, ...existing]) {
    if (c.scopeDigest !== hash(c.scopeSet) || c.periodDigest !== hash(c.effectivePeriod))
      return fail();
  }
  const observedAt = parseCatalogInstant(r.observedAt);
  const scopeOrder = Object.freeze([
    ...r.scopeOrder,
  ]) as readonly (typeof productPublicationScopeLevels)[number][];
  const relations = planProductSelectorOverlaps({ incoming, existing, scopeOrder, observedAt });
  const plan = Object.freeze({
    profile: "CatalogProductScopeOverlapPlanV1" as const,
    tenantReference: incoming.tenantReference,
    brandReference: incoming.brandReference,
    productReference: incoming.productReference,
    incomingVersionReference: incoming.versionReference,
    incomingOperationReference: incoming.operationReference,
    incomingIntentDigest: incoming.intentDigest,
    incomingScopeDigest: incoming.scopeDigest,
    policyReference: incoming.policyReference,
    policyVersion: incoming.policyVersion,
    scopeOrder,
    observedAt,
    ...relations,
  });
  return Object.freeze({ ...plan, digest: hash(plan) });
}
export type CatalogProductScopeOverlapPlan = ReturnType<typeof buildCatalogProductScopeOverlapPlan>;
