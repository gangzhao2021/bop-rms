import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parsePublishingProductPublicationPolicy,
  parsePublishingDigest,
  publishingProductPublicationPolicyDigest,
} from "@bop/publishing";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogLocale,
  parseCatalogReference,
  parseProductAggregate,
} from "./product.js";
import { deriveCatalogProductPublicationContentIdentity } from "./product-publication-content.js";
import { assessProductContentPolicyRules } from "../domain/product-content-policy.js";
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function record(value: unknown, keys: readonly string[]) {
  const copied = copyCategoryPersistenceValue(value);
  if (!copied || typeof copied !== "object" || Array.isArray(copied)) return fail();
  if (Object.keys(copied).length !== keys.length || keys.some((key) => !Object.hasOwn(copied, key)))
    return fail();
  return copied as Record<string, unknown>;
}
export interface CatalogProductContentPolicyBinding {
  readonly tenantReference: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly expectedAggregateVersion: number;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly originalIntentDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
}
export function parseCatalogProductContentPolicyBinding(
  value: unknown,
): CatalogProductContentPolicyBinding {
  const r = record(value, [
    "tenantReference",
    "productReference",
    "versionReference",
    "expectedAggregateVersion",
    "contentDigest",
    "configurationDigest",
    "originalIntentDigest",
    "observedAt",
    "validUntil",
  ]);
  if (
    !Number.isSafeInteger(r.expectedAggregateVersion) ||
    (r.expectedAggregateVersion as number) < 1 ||
    (r.expectedAggregateVersion as number) > 2147483647
  )
    return fail();
  const observedAt = parseCatalogInstant(r.observedAt),
    validUntil = parseCatalogInstant(r.validUntil);
  if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 30000)
    return fail();
  return Object.freeze({
    tenantReference: parseCatalogReference(r.tenantReference),
    productReference: parseCatalogReference(r.productReference),
    versionReference: parseCatalogReference(r.versionReference),
    expectedAggregateVersion: r.expectedAggregateVersion as number,
    contentDigest: parsePublishingDigest(r.contentDigest),
    configurationDigest: parsePublishingDigest(r.configurationDigest),
    originalIntentDigest: parsePublishingDigest(r.originalIntentDigest),
    observedAt,
    validUntil,
  });
}
/** Supplied-source derivation. Actual current acquisition/authority remains the
 * composition's responsibility; this value cannot replace twelve-check validation. */
export function assessCatalogProductContentPolicy(
  aggregateValue: unknown,
  brandValue: unknown,
  policyValue: unknown,
  bindingValue: unknown,
) {
  try {
    const aggregate = parseProductAggregate(copyCategoryPersistenceValue(aggregateValue)),
      policy = parsePublishingProductPublicationPolicy(policyValue),
      b = record(brandValue, [
        "tenantReference",
        "brandReference",
        "brandVersion",
        "configurationVersionReference",
        "contentDigest",
        "currentPublicationReference",
        "supportedLocales",
        "observedAt",
        "validUntil",
        "originalIntentDigest",
      ]),
      r = parseCatalogProductContentPolicyBinding(bindingValue),
      tenant = parseCatalogReference(r.tenantReference),
      observedAt = parseCatalogInstant(r.observedAt),
      validUntil = parseCatalogInstant(r.validUntil),
      intent = parsePublishingDigest(r.originalIntentDigest),
      identity = deriveCatalogProductPublicationContentIdentity(aggregate);
    if (
      !Number.isSafeInteger(b.brandVersion) ||
      (b.brandVersion as number) < 1 ||
      (b.brandVersion as number) > 2147483647 ||
      b.tenantReference !== tenant ||
      b.brandReference !== aggregate.brandReference ||
      b.observedAt !== observedAt ||
      b.originalIntentDigest !== intent ||
      parseCatalogReference(policy.tenantReference) !== tenant ||
      parseCatalogReference(policy.brandReference) !== aggregate.brandReference ||
      parseCatalogInstant(policy.effectiveFrom) > observedAt ||
      (policy.effectiveUntil !== null &&
        parseCatalogInstant(policy.effectiveUntil) <= observedAt) ||
      r.productReference !== aggregate.productReference ||
      r.versionReference !== aggregate.draft.versionReference ||
      r.expectedAggregateVersion !== aggregate.aggregateVersion ||
      r.contentDigest !== identity.contentDigest ||
      r.configurationDigest !== identity.configurationDigest ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 30000 ||
      validUntil > parseCatalogInstant(b.validUntil) ||
      (policy.effectiveUntil !== null && validUntil > parseCatalogInstant(policy.effectiveUntil)) ||
      aggregate.updatedAt > observedAt ||
      !Array.isArray(b.supportedLocales) ||
      b.supportedLocales.length === 0 ||
      b.supportedLocales.length > 100
    )
      return fail();
    const supportedLocales = b.supportedLocales.map(parseCatalogLocale);
    if (new Set(supportedLocales).size !== supportedLocales.length) return fail();
    const rules = assessProductContentPolicyRules(aggregate, {
      supportedLocales,
      requiredLocales: policy.requiredLocales,
      mediaRequirement: policy.mediaRequirement,
    });
    const content = Object.freeze({
      profile: "CatalogProductContentPolicyAssessmentV1" as const,
      tenantReference: tenant,
      brandReference: aggregate.brandReference,
      productReference: aggregate.productReference,
      versionReference: aggregate.draft.versionReference,
      aggregateVersion: aggregate.aggregateVersion,
      ...identity,
      originalIntentDigest: intent,
      observedAt,
      validUntil,
      brandSource: Object.freeze({
        brandVersion: b.brandVersion as number,
        configurationVersionReference: parseCatalogReference(b.configurationVersionReference),
        contentDigest: parsePublishingDigest(b.contentDigest),
        currentPublicationReference: parseCatalogReference(b.currentPublicationReference),
      }),
      policyReference: policy.policyReference,
      policyVersion: policy.policyVersion,
      policyContentDigest: publishingProductPublicationPolicyDigest(policy),
      approvalPolicy: policy.approvalPolicy,
      warningOverrideAllowed: policy.warningOverrideAllowed,
      ...rules,
      sourceAuthority: "NotEvaluated" as const,
      publishValidation: "Incomplete" as const,
      mediaReadiness: "NotEvaluated" as const,
      referenceEligibility: "NotEvaluated" as const,
      brandFieldRequirements: "NotEvaluated" as const,
      eligibility: "NotEvaluated" as const,
    });
    // The minimal assessment contains no content, names, media IDs or reference graph.
    const { referenceConfiguration, ...minimal } = content;
    void referenceConfiguration;
    return Object.freeze({
      ...minimal,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(minimal)),
    });
  } catch {
    return fail();
  }
}
export type CatalogProductContentPolicyAssessment = ReturnType<
  typeof assessCatalogProductContentPolicy
>;
