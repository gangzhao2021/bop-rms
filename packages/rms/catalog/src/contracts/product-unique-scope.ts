import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseTenantStoreReferenceSnapshot, tenantStoreReferenceDigest } from "@bop/tenant";
import {
  parsePublishingProductPublicationPolicy,
  publishingProductPublicationPolicyDigest,
} from "@bop/publishing";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { CatalogError, parseCatalogInstant, parseCatalogReference } from "./product.js";
import {
  parseProductPublicationCommand,
  parseProductPublicationVersion,
} from "./product-publication.js";
import { assessProductUniqueScopeRules } from "../domain/product-unique-scope.js";
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function closed(value: unknown, fields: readonly string[]) {
  const copy = copyCategoryPersistenceValue(value);
  if (
    !copy ||
    typeof copy !== "object" ||
    Array.isArray(copy) ||
    Object.keys(copy).length !== fields.length ||
    fields.some((f) => !Object.hasOwn(copy, f))
  )
    return fail();
  return copy as Record<string, unknown>;
}
/** A pure, minimal one-check result. Actual SQL acquisition and authority are
 * the composition's responsibility; this cannot supply a twelve-check receipt. */
export function assessCatalogProductUniqueScope(
  commandValue: unknown,
  historyValue: unknown,
  storesValue: unknown,
  policyValue: unknown,
  nowValue: unknown,
) {
  const c = parseProductPublicationCommand(commandValue),
    h = closed(historyValue, [
      "profile",
      "tenantReference",
      "brandReference",
      "productReference",
      "aggregateVersion",
      "observedAt",
      "coverage",
      "eligibility",
      "history",
      "latest",
      "digest",
    ]),
    stores = parseTenantStoreReferenceSnapshot(storesValue),
    p = closed(policyValue, ["content", "currentPublicationReference", "observedAt", "validUntil"]),
    policy = parsePublishingProductPublicationPolicy(p.content),
    observedAt = parseCatalogInstant(h.observedAt),
    now = parseCatalogInstant(nowValue),
    policyUntil = parseCatalogInstant(p.validUntil),
    policyPublicationReference = parseCatalogReference(p.currentPublicationReference),
    originalIntentDigest = hash(c);
  const { digest: sourceDigest, ...historyContent } = h;
  if (
    c.action !== "Validate" ||
    c.actorKind !== "User" ||
    c.occurredAt > observedAt ||
    h.profile !== "CatalogProductPublicationSourceV1" ||
    h.coverage !== "Complete" ||
    h.eligibility !== "NotEvaluated" ||
    h.tenantReference !== c.tenantReference ||
    h.brandReference !== c.brandReference ||
    h.productReference !== c.productReference ||
    h.aggregateVersion !== c.expectedProductAggregateVersion ||
    !Array.isArray(h.history) ||
    h.history.length > 1000 ||
    !Array.isArray(h.latest) ||
    h.latest.length > 1000 ||
    sourceDigest !== hash(historyContent) ||
    stores.brandReference !== c.brandReference ||
    stores.originalIntentDigest !== originalIntentDigest ||
    stores.observedAt !== observedAt ||
    policy.tenantReference !== c.tenantReference ||
    policy.brandReference !== c.brandReference ||
    p.observedAt !== observedAt ||
    parseCatalogInstant(policy.effectiveFrom) > observedAt ||
    policyUntil <= observedAt ||
    Date.parse(policyUntil) - Date.parse(observedAt) > 30000 ||
    (policy.effectiveUntil !== null && policyUntil > parseCatalogInstant(policy.effectiveUntil)) ||
    now < observedAt ||
    Date.parse(now) - Date.parse(observedAt) >= 5000 ||
    now >= policyUntil
  )
    return fail();
  const latest = h.latest.map(parseProductPublicationVersion),
    heads = new Map<string, ReturnType<typeof parseProductPublicationVersion>>();
  for (const item of h.history) {
    const entry = closed(item, ["action", "publication", "configuration"]),
      publication = parseProductPublicationVersion(entry.publication);
    const before = heads.get(publication.versionReference);
    if (
      publication.tenantReference !== c.tenantReference ||
      publication.brandReference !== c.brandReference ||
      publication.productReference !== c.productReference ||
      publication.productAggregateVersion >= c.expectedProductAggregateVersion ||
      publication.occurredAt > observedAt ||
      (before !== undefined && publication.publicationVersion <= before.publicationVersion)
    )
      return fail();
    heads.set(publication.versionReference, publication);
  }
  if (
    new Set(latest.map((v) => v.versionReference)).size !== latest.length ||
    latest.length !== heads.size ||
    latest.some(
      (v) => canonicalizeRfc8785(v) !== canonicalizeRfc8785(heads.get(v.versionReference)),
    )
  )
    return fail();
  if ((heads.get(c.versionReference)?.publicationVersion ?? 0) !== c.expectedPublicationVersion)
    return fail();
  const historyUntil = new Date(Date.parse(observedAt) + 5000).toISOString(),
    validUntil = historyUntil < policyUntil ? historyUntil : policyUntil;
  const result = {
    profile: "CatalogProductUniqueScopeAssessmentV1" as const,
    tenantReference: c.tenantReference,
    brandReference: c.brandReference,
    productReference: c.productReference,
    versionReference: c.versionReference,
    aggregateVersion: c.expectedProductAggregateVersion,
    originalIntentDigest,
    sourceDigest: sourceDigest as string,
    registeredStoreDigest: tenantStoreReferenceDigest(stores),
    policyReference: policy.policyReference,
    policyVersion: policy.policyVersion,
    policyContentDigest: publishingProductPublicationPolicyDigest(policy),
    policyPublicationReference,
    observedAt,
    validUntil,
    ...assessProductUniqueScopeRules({
      command: c,
      latest,
      scopeOrder: policy.scopeOrder,
      activeStores: new Set(
        stores.references.filter((s) => s.lifecycle === "Active").map((s) => s.storeReference),
      ),
      brandActive: stores.brandLifecycle === "Active",
      registeredStoreCount: stores.references.length,
      observedAt,
    }),
    sourceAuthority: "NotEvaluated" as const,
    publishValidation: "Incomplete" as const,
    eligibility: "NotEvaluated" as const,
  };
  return Object.freeze({ ...result, digest: hash(result) });
}
export type CatalogProductUniqueScopeAssessment = ReturnType<
  typeof assessCatalogProductUniqueScope
>;
