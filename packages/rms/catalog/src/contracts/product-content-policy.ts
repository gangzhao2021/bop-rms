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
import {
  assessProductContentPolicyRules,
  assessProductDraftContentPolicyRules,
} from "../domain/product-content-policy.js";
import { parseProductPublicationCommandV2 } from "./product-publication-v2.js";
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
export interface CatalogProductContentPolicyBindingV2 extends CatalogProductContentPolicyBinding {
  readonly profile: "CatalogProductContentPolicyBindingV2";
  readonly replacementIntentDigest: string;
}
const bindingKeys = [
  "tenantReference",
  "productReference",
  "versionReference",
  "expectedAggregateVersion",
  "contentDigest",
  "configurationDigest",
  "originalIntentDigest",
  "observedAt",
  "validUntil",
] as const;
export function parseCatalogProductContentPolicyBinding(
  value: unknown,
): CatalogProductContentPolicyBinding {
  return parseBinding(record(value, bindingKeys));
}
export function parseCatalogProductContentPolicyBindingV2(
  value: unknown,
): CatalogProductContentPolicyBindingV2 {
  const r = record(value, [...bindingKeys, "profile", "replacementIntentDigest"]);
  if (r.profile !== "CatalogProductContentPolicyBindingV2") return fail();
  return Object.freeze({
    ...parseBinding(r),
    profile: "CatalogProductContentPolicyBindingV2",
    replacementIntentDigest: parsePublishingDigest(r.replacementIntentDigest),
  });
}
function parseBinding(r: Record<string, unknown>): CatalogProductContentPolicyBinding {
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
    const body = {
      profile: "CatalogProductContentPolicyAssessmentV1" as const,
      ...assessContentPolicy(
        aggregateValue,
        brandValue,
        policyValue,
        parseCatalogProductContentPolicyBinding(bindingValue),
      ),
    };
    return Object.freeze({ ...body, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) });
  } catch {
    return fail();
  }
}
/** A complete V2 command is retained in the original intent hash. This pure
 * assessment cannot certify current acquisition, Media readiness or publishability. */
export function assessCatalogProductContentPolicyV2(
  commandValue: unknown,
  aggregateValue: unknown,
  brandValue: unknown,
  policyValue: unknown,
  bindingValue: unknown,
) {
  try {
    const c = parseProductPublicationCommandV2(commandValue),
      r = parseCatalogProductContentPolicyBindingV2(bindingValue);
    if (
      c.action !== "Validate" ||
      c.actorKind !== "User" ||
      c.occurredAt > r.observedAt ||
      r.tenantReference !== c.tenantReference ||
      r.productReference !== c.productReference ||
      r.versionReference !== c.versionReference ||
      r.expectedAggregateVersion !== c.expectedProductAggregateVersion ||
      r.contentDigest !== c.contentDigest ||
      r.configurationDigest !== c.configurationDigest ||
      r.originalIntentDigest !== "sha256:" + sha256Hex(canonicalizeRfc8785(c)) ||
      r.replacementIntentDigest !== c.replacementIntentDigest
    )
      return fail();
    const assessed = assessContentPolicy(aggregateValue, brandValue, policyValue, r);
    if (assessed.brandReference !== c.brandReference) return fail();
    const body = {
      profile: "CatalogProductContentPolicyAssessmentV2" as const,
      ...assessed,
      replacementIntentDigest: c.replacementIntentDigest,
    };
    return Object.freeze({ ...body, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) });
  } catch {
    return fail();
  }
}
export function assessCatalogProductDraftContentPolicy(
  aggregateValue: unknown,
  brandValue: unknown,
  policyValue: unknown,
  bindingValue: unknown,
) {
  try {
    const bound = bindContentPolicy(
        aggregateValue,
        brandValue,
        policyValue,
        parseCatalogProductContentPolicyBinding(bindingValue),
      ),
      body = {
        profile: "CatalogProductDraftContentPolicyAssessmentV1" as const,
        ...bound.content,
        ...assessProductDraftContentPolicyRules(bound.aggregate, bound.constraints),
      };
    return Object.freeze({ ...body, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) });
  } catch {
    return fail();
  }
}
function assessContentPolicy(
  aggregateValue: unknown,
  brandValue: unknown,
  policyValue: unknown,
  r: CatalogProductContentPolicyBinding,
) {
  const bound = bindContentPolicy(aggregateValue, brandValue, policyValue, r);
  const {
    sourceAuthority,
    publishValidation,
    mediaReadiness,
    referenceEligibility,
    brandFieldRequirements,
    eligibility,
    ...prefix
  } = bound.content;
  return Object.freeze({
    ...prefix,
    ...assessProductContentPolicyRules(bound.aggregate, bound.constraints),
    sourceAuthority,
    publishValidation,
    mediaReadiness,
    referenceEligibility,
    brandFieldRequirements,
    eligibility,
  });
}
function bindContentPolicy(
  aggregateValue: unknown,
  brandValue: unknown,
  policyValue: unknown,
  r: CatalogProductContentPolicyBinding,
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
    const constraints = Object.freeze({
      supportedLocales,
      requiredLocales: policy.requiredLocales,
      mediaRequirement: policy.mediaRequirement,
    });
    const content = Object.freeze({
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
    return Object.freeze({ aggregate, constraints, content: Object.freeze(minimal) });
  } catch {
    return fail();
  }
}
export type CatalogProductContentPolicyAssessment = ReturnType<
  typeof assessCatalogProductContentPolicy
>;
export type CatalogProductContentPolicyAssessmentV2 = ReturnType<
  typeof assessCatalogProductContentPolicyV2
>;
export type CatalogProductDraftContentPolicyAssessment = ReturnType<
  typeof assessCatalogProductDraftContentPolicy
>;
