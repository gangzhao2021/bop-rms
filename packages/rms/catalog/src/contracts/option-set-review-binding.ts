import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parsePublishingDigest } from "@bop/publishing";
import { CatalogError, parseCatalogInstant, parseCatalogReference } from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
export const optionContentReviewValidationCodes = Object.freeze([
  "CURRENT_REFERENCES",
  "PUBLISHING_POLICY",
  "RULE_SATISFIABILITY",
  "SCOPE_TOPOLOGY",
] as const);
/** Stable review intent only. Caller must derive pins from actual current owners;
 * a valid binding never proves recorded approval or full validation. */
export function createCatalogOptionSetContentReviewBinding(value: unknown) {
  const fields = [
    "tenantReference",
    "brandReference",
    "optionSetReference",
    "versionReference",
    "expectedAggregateVersion",
    "sourceDigest",
    "contentDigest",
    "configurationDigest",
    "graphDigest",
    "policyReference",
    "policyVersion",
    "policyContentDigest",
    "currentPolicyPublicationReference",
    "originalIntentDigest",
    "activationAt",
  ];
  const v = copyCategoryPersistenceValue(value);
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).length !== fields.length ||
    fields.some((k) => !Object.hasOwn(v, k))
  )
    throw new CatalogError("CATALOG_INPUT_INVALID");
  const r = v as Record<string, unknown>;
  for (const k of ["expectedAggregateVersion", "policyVersion"])
    if (!Number.isSafeInteger(r[k]) || (r[k] as number) < 1 || (r[k] as number) > 2147483647)
      throw new CatalogError("CATALOG_INPUT_INVALID");
  const body = Object.freeze({
    profile: "CatalogOptionSetContentReviewBindingV1" as const,
    tenantReference: parseCatalogReference(r.tenantReference),
    brandReference: parseCatalogReference(r.brandReference),
    optionSetReference: parseCatalogReference(r.optionSetReference),
    versionReference: parseCatalogReference(r.versionReference),
    expectedAggregateVersion: r.expectedAggregateVersion as number,
    sourceDigest: parsePublishingDigest(r.sourceDigest),
    contentDigest: parsePublishingDigest(r.contentDigest),
    configurationDigest: parsePublishingDigest(r.configurationDigest),
    graphDigest: parsePublishingDigest(r.graphDigest),
    policyReference: parseCatalogReference(r.policyReference),
    policyVersion: r.policyVersion as number,
    policyContentDigest: parsePublishingDigest(r.policyContentDigest),
    currentPolicyPublicationReference: parseCatalogReference(r.currentPolicyPublicationReference),
    originalIntentDigest: parsePublishingDigest(r.originalIntentDigest),
    activationAt: parseCatalogInstant(r.activationAt),
  });
  return Object.freeze({ ...body, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) });
}
