import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseCatalogInstant } from "../contracts/product.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
} from "../contracts/product-publication-v2.js";
import { parseCatalogProductUniqueScopeAssessmentV2 } from "../contracts/product-unique-scope-v2.js";
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));

/** Merge a held owner's complete V2 assessment, never a caller exemption list.
 * Neither this function nor the assessment digest establishes acquisition or
 * permission. All ten other checks and their evidence remain indispensable. */
export function applyCatalogProductUniqueScopeValidationV2(
  commandValue: unknown,
  validationValue: unknown,
  assessmentValue: unknown,
  nowValue: unknown,
) {
  try {
    const c = parseProductPublicationCommandV2(commandValue),
      v = parseProductPublicationValidationV2(validationValue),
      scope = parseCatalogProductUniqueScopeAssessmentV2(assessmentValue),
      now = parseCatalogInstant(nowValue);
    if (
      c.action !== "Validate" ||
      c.actorKind !== "User" ||
      scope.tenantReference !== c.tenantReference ||
      scope.brandReference !== c.brandReference ||
      scope.productReference !== c.productReference ||
      scope.versionReference !== c.versionReference ||
      scope.aggregateVersion !== c.expectedProductAggregateVersion ||
      scope.contentDigest !== c.contentDigest ||
      scope.configurationDigest !== c.configurationDigest ||
      scope.originalIntentDigest !== hash(c) ||
      scope.replacementIntentDigest !== c.replacementIntentDigest ||
      scope.equalRankResolution !==
        (c.replacementIntent.mode === "None"
          ? "NoReplacementRequested"
          : "ExactStoreSelectorRetirementBound") ||
      v.replacementIntentDigest !== c.replacementIntentDigest ||
      scope.policyReference !== v.policyReference ||
      scope.policyVersion !== v.policyVersion ||
      v.productAggregateVersion !== c.expectedProductAggregateVersion ||
      v.contentDigest !== c.contentDigest ||
      v.configurationDigest !== c.configurationDigest ||
      v.scopeDigest !== hash(c.scopeSet) ||
      v.periodDigest !== hash(c.effectivePeriod) ||
      c.occurredAt > scope.observedAt ||
      scope.observedAt > now ||
      scope.validUntil <= now ||
      v.checkedAt > now ||
      v.validUntil <= now ||
      v.checks.find((check) => check.code === "UniqueScope")?.outcome !== "Pass"
    )
      return fail();
    const individual = v.checks
        .filter((check) => check.code !== "HardErrorsCleared")
        .map((check) => (check.code === "UniqueScope" ? scope.check : check)),
      // Pending approval remains independent of the technical HardError summary.
      hard = individual.some((check) => check.outcome === "HardError");
    return parseProductPublicationValidationV2({
      ...v,
      checks: [...individual, { code: "HardErrorsCleared", outcome: hard ? "HardError" : "Pass" }],
      validUntil: scope.validUntil < v.validUntil ? scope.validUntil : v.validUntil,
    });
  } catch {
    return fail();
  }
}
