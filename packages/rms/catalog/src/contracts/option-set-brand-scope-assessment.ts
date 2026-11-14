import { parseTenantStoreReferenceSnapshot } from "@bop/tenant";
import { parsePublishingDigest } from "@bop/publishing";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { parseCatalogOptionSetContentPolicyBinding } from "./option-set-content-policy.js";
import { parseCatalogOptionSetEditorContent } from "./option-set-editor-content.js";
import { evaluateCatalogOptionSetRuleSatisfiability } from "./option-set-rule-satisfiability.js";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogLocale,
  parseCatalogInstant,
} from "./product.js";
import { assessOptionSetBrandScopeRules } from "../domain/option-set-brand-scope-assessment.js";

const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function record(value: unknown, keys: readonly string[]) {
  const copied = copyCategoryPersistenceValue(value);
  if (
    !copied ||
    typeof copied !== "object" ||
    Array.isArray(copied) ||
    Object.keys(copied).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(copied, key))
  )
    return fail();
  return copied as Record<string, unknown>;
}
/** Normalized public current Brand facts. API maps the genuine held Tenant +
 * Publishing packet; this contract does not assert acquisition or approval. */
export function assessCatalogOptionSetBrandScope(
  graphValue: unknown,
  brandValue: unknown,
  rosterValue: unknown,
  bindingValue: unknown,
) {
  try {
    const binding = parseCatalogOptionSetContentPolicyBinding(bindingValue),
      graph = record(graphValue, [
        "brandReference",
        "rootOptionSetReference",
        "rootVersionReference",
        "contents",
      ]),
      brand = record(brandValue, [
        "profile",
        "tenantReference",
        "brandReference",
        "brandVersion",
        "configurationVersionReference",
        "contentDigest",
        "currentPublicationReference",
        "supportedLocales",
        "effectiveFrom",
        "effectiveUntil",
        "originalIntentDigest",
        "observedAt",
        "validUntil",
      ]),
      roster = parseTenantStoreReferenceSnapshot(rosterValue),
      mechanical = evaluateCatalogOptionSetRuleSatisfiability(graph);
    if (
      !Array.isArray(graph.contents) ||
      graph.contents.length < 1 ||
      graph.contents.length > 32 ||
      !Array.isArray(brand.supportedLocales) ||
      brand.supportedLocales.length < 1 ||
      brand.supportedLocales.length > 100
    )
      return fail();
    const prepared = graph.contents.map((value) => {
      const { sourceAggregate, ...additional } = record(value, [
        "profile",
        "sourceAggregate",
        "optionDetails",
        "conditionalRules",
        "conflictRules",
        "scopeSet",
        "effectivePeriod",
      ]);
      return parseCatalogOptionSetEditorContent(sourceAggregate, additional);
    });
    const root = prepared.find(
      (value) => value.content.sourceAggregate.optionSetReference === binding.optionSetReference,
    );
    const observedAt = parseCatalogInstant(brand.observedAt),
      validUntil = parseCatalogInstant(brand.validUntil),
      effectiveFrom = parseCatalogInstant(brand.effectiveFrom),
      effectiveUntil =
        brand.effectiveUntil === null ? null : parseCatalogInstant(brand.effectiveUntil),
      locales = brand.supportedLocales.map(parseCatalogLocale);
    if (
      !root ||
      brand.profile !== "CatalogOptionSetBrandConstraintsV1" ||
      brand.tenantReference !== binding.tenantReference ||
      brand.brandReference !== binding.brandReference ||
      !Number.isSafeInteger(brand.brandVersion) ||
      (brand.brandVersion as number) < 1 ||
      BigInt(brand.brandVersion as number) !== BigInt(roster.brandVersion) ||
      graph.brandReference !== binding.brandReference ||
      graph.rootOptionSetReference !== binding.optionSetReference ||
      graph.rootVersionReference !== binding.versionReference ||
      root.content.sourceAggregate.draft.versionReference !== binding.versionReference ||
      root.content.sourceAggregate.aggregateVersion !== binding.expectedAggregateVersion ||
      root.sourceDigest !== binding.sourceDigest ||
      root.contentDigest !== binding.contentDigest ||
      root.configurationDigest !== binding.configurationDigest ||
      mechanical.graphDigest !== binding.graphDigest ||
      ("reason" in mechanical &&
        ["IncompleteTriggerGraph", "AmbiguousTriggerVersion"].includes(mechanical.reason)) ||
      prepared.some(
        (value) =>
          value.content.sourceAggregate.brandReference !== binding.brandReference ||
          value.content.sourceAggregate.updatedAt > binding.observedAt,
      ) ||
      observedAt < binding.observedAt ||
      observedAt >= binding.validUntil ||
      validUntil <= observedAt ||
      validUntil > binding.validUntil ||
      roster.brandReference !== binding.brandReference ||
      roster.originalIntentDigest !== binding.originalIntentDigest ||
      roster.observedAt < binding.observedAt ||
      roster.observedAt >= binding.validUntil ||
      roster.observedAt >= validUntil ||
      parsePublishingDigest(brand.originalIntentDigest) !== binding.originalIntentDigest ||
      new Set(locales).size !== locales.length ||
      (effectiveUntil !== null &&
        (effectiveUntil <= effectiveFrom ||
          effectiveUntil <= observedAt ||
          validUntil > effectiveUntil)) ||
      effectiveFrom > observedAt
    )
      return fail();
    const configurationVersionReference = parseCatalogReference(
        brand.configurationVersionReference,
      ),
      currentPublicationReference = parseCatalogReference(brand.currentPublicationReference),
      contentDigest = parsePublishingDigest(brand.contentDigest);
    const rules = assessOptionSetBrandScopeRules(
      prepared.map((value) => value.content),
      { supportedLocales: locales, effectiveFrom, effectiveUntil },
      roster,
      binding.activationAt,
    );
    return Object.freeze({
      profile: "CatalogOptionSetBrandScopeAssessmentV1" as const,
      binding,
      brandConfiguration: Object.freeze({
        configurationVersionReference,
        currentPublicationReference,
        contentDigest,
      }),
      topologyGeneration: roster.generation,
      observedAt: roster.observedAt > observedAt ? roster.observedAt : observedAt,
      validUntil,
      ...rules,
      sourceAuthority: "NotEvaluated" as const,
      brandFieldRequirements: "NotEvaluated" as const,
      referenceEligibility: "NotEvaluated" as const,
      publishValidation: "Incomplete" as const,
    });
  } catch {
    return fail();
  }
}
