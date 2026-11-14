import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parsePublishingDigest,
  parsePublishingOptionSetPublicationPolicy,
  publishingOptionSetPublicationPolicyDigest,
} from "@bop/publishing";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { parseCatalogOptionSetEditorContent } from "./option-set-editor-content.js";
import { evaluateCatalogOptionSetRuleSatisfiability } from "./option-set-rule-satisfiability.js";
import { CatalogError, parseCatalogInstant, parseCatalogReference } from "./product.js";
import { assessOptionSetContentPolicyRules } from "../domain/option-set-content-policy.js";

const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function record(value: unknown, keys: readonly string[]) {
  const r = copyCategoryPersistenceValue(value);
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(r, k))
  )
    return fail();
  return r as Record<string, unknown>;
}
export function parseCatalogOptionSetContentPolicyBinding(value: unknown) {
  const r = record(value, [
    "tenantReference",
    "brandReference",
    "optionSetReference",
    "versionReference",
    "expectedAggregateVersion",
    "sourceDigest",
    "contentDigest",
    "configurationDigest",
    "graphDigest",
    "originalIntentDigest",
    "observedAt",
    "validUntil",
    "activationAt",
  ]);
  const observedAt = parseCatalogInstant(r.observedAt),
    validUntil = parseCatalogInstant(r.validUntil),
    activationAt = parseCatalogInstant(r.activationAt);
  if (
    !Number.isSafeInteger(r.expectedAggregateVersion) ||
    (r.expectedAggregateVersion as number) < 1 ||
    (r.expectedAggregateVersion as number) > 2147483647 ||
    validUntil <= observedAt ||
    Date.parse(validUntil) - Date.parse(observedAt) > 30000 ||
    activationAt < observedAt
  )
    return fail();
  return Object.freeze({
    tenantReference: parseCatalogReference(r.tenantReference),
    brandReference: parseCatalogReference(r.brandReference),
    optionSetReference: parseCatalogReference(r.optionSetReference),
    versionReference: parseCatalogReference(r.versionReference),
    expectedAggregateVersion: r.expectedAggregateVersion as number,
    sourceDigest: parsePublishingDigest(r.sourceDigest),
    contentDigest: parsePublishingDigest(r.contentDigest),
    configurationDigest: parsePublishingDigest(r.configurationDigest),
    graphDigest: parsePublishingDigest(r.graphDigest),
    originalIntentDigest: parsePublishingDigest(r.originalIntentDigest),
    observedAt,
    validUntil,
    activationAt,
  });
}
export type CatalogOptionSetContentPolicyBinding = ReturnType<
  typeof parseCatalogOptionSetContentPolicyBinding
>;

/** Supplied graph derivation only. Current acquisition, Brand fields, reference
 * qualification, topology and independent approval remain separate owning checks. */
export function assessCatalogOptionSetContentPolicy(
  graphValue: unknown,
  policyValue: unknown,
  bindingValue: unknown,
  limitsValue: unknown = { maximumSearchNodes: 65536 },
) {
  try {
    const graph = record(graphValue, [
        "brandReference",
        "rootOptionSetReference",
        "rootVersionReference",
        "contents",
      ]),
      binding = parseCatalogOptionSetContentPolicyBinding(bindingValue),
      policy = parsePublishingOptionSetPublicationPolicy(policyValue),
      mechanical = evaluateCatalogOptionSetRuleSatisfiability(graph, limitsValue);
    if (!Array.isArray(graph.contents)) return fail();
    const prepared = graph.contents.map((v) => {
      const body = record(v, [
        "profile",
        "sourceAggregate",
        "optionDetails",
        "conditionalRules",
        "conflictRules",
        "scopeSet",
        "effectivePeriod",
      ]);
      const { sourceAggregate, ...additional } = body;
      return parseCatalogOptionSetEditorContent(sourceAggregate, additional);
    });
    const root = prepared.find(
      (n) =>
        n.content.sourceAggregate.optionSetReference === binding.optionSetReference &&
        n.content.sourceAggregate.draft.versionReference === binding.versionReference,
    );
    if (
      !root ||
      String(policy.tenantReference) !== binding.tenantReference ||
      String(policy.brandReference) !== binding.brandReference ||
      graph.brandReference !== binding.brandReference ||
      graph.rootOptionSetReference !== binding.optionSetReference ||
      graph.rootVersionReference !== binding.versionReference ||
      root.content.sourceAggregate.draft.versionReference !== binding.versionReference ||
      root.content.sourceAggregate.aggregateVersion !== binding.expectedAggregateVersion ||
      root.sourceDigest !== binding.sourceDigest ||
      root.contentDigest !== binding.contentDigest ||
      root.configurationDigest !== binding.configurationDigest ||
      mechanical.graphDigest !== binding.graphDigest ||
      Date.parse(policy.effectiveFrom) > Date.parse(binding.observedAt) ||
      (policy.effectiveUntil !== null &&
        (Date.parse(policy.effectiveUntil) <= Date.parse(binding.observedAt) ||
          Date.parse(binding.validUntil) > Date.parse(policy.effectiveUntil))) ||
      prepared.some(
        (n) =>
          n.content.sourceAggregate.updatedAt > binding.observedAt ||
          n.content.sourceAggregate.draft.updatedAt > binding.observedAt ||
          n.content.sourceAggregate.draft.options.some((o) => o.createdAt > binding.observedAt),
      )
    )
      return fail();
    const policyChecks = assessOptionSetContentPolicyRules(
      prepared.map((n) => n.content),
      {
        requiredLocales: policy.requiredLocales,
        mediaRequirement: policy.mediaRequirement,
        effectiveFrom: policy.effectiveFrom,
        effectiveUntil: policy.effectiveUntil,
      },
      binding.activationAt,
    );
    const checks = Object.freeze([
      ...policyChecks,
      Object.freeze({
        code: "MechanicalRules" as const,
        outcome:
          mechanical.status === "Satisfiable"
            ? ("Pass" as const)
            : mechanical.status === "Unsatisfiable"
              ? ("HardError" as const)
              : ("Indeterminate" as const),
      }),
    ]);
    const base = Object.freeze({
      profile: "CatalogOptionSetContentPolicyAssessmentV1" as const,
      ...binding,
      policyReference: policy.policyReference,
      policyVersion: policy.policyVersion,
      policyContentDigest: publishingOptionSetPublicationPolicyDigest(policy),
      approvalPolicy: policy.approvalPolicy,
      warningOverrideAllowed: policy.warningOverrideAllowed,
      checks,
      decision: checks.some((c) => c.outcome === "HardError")
        ? ("HardError" as const)
        : checks.some((c) => c.outcome === "Indeterminate")
          ? ("Indeterminate" as const)
          : ("PassForAssessedRules" as const),
      mechanicalStatus: mechanical.status,
      mechanicalReason: "reason" in mechanical ? mechanical.reason : null,
      searchNodes: mechanical.searchNodes,
      sourceAuthority: "NotEvaluated" as const,
      brandFieldRequirements: "NotEvaluated" as const,
      referenceEligibility: "NotEvaluated" as const,
      mediaReadiness: "NotEvaluated" as const,
      scopeTopology: "NotEvaluated" as const,
      independentApproval: "NotEvaluated" as const,
      publishValidation: "Incomplete" as const,
      eligibility: "NotEvaluated" as const,
    });
    return Object.freeze({ ...base, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(base)) });
  } catch {
    return fail();
  }
}
export type CatalogOptionSetContentPolicyAssessment = ReturnType<
  typeof assessCatalogOptionSetContentPolicy
>;
