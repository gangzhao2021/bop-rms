import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "../contracts/category-persistence.js";
import { CatalogError, parseCatalogInstant, parseCatalogReference } from "../contracts/product.js";
import { parsePublishingDigest } from "@bop/publishing";
import {
  parseProductPublicationCommand,
  parseProductPublicationValidation,
} from "../contracts/product-publication.js";
import type { CatalogProductContentPolicyAssessment } from "../contracts/product-content-policy.js";
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Necessary conditions only. Current provenance belongs to held public owners;
 * successful presence/locale assessment never replaces independent full checks. */
export function applyCatalogProductContentPolicyValidation(
  commandValue: unknown,
  validationValue: unknown,
  assessmentValue: CatalogProductContentPolicyAssessment,
  nowValue: unknown,
) {
  try {
    const c = parseProductPublicationCommand(copyCategoryPersistenceValue(commandValue)),
      v = parseProductPublicationValidation(copyCategoryPersistenceValue(validationValue)),
      a = copyCategoryPersistenceValue(assessmentValue) as CatalogProductContentPolicyAssessment,
      now = parseCatalogInstant(nowValue);
    const keys = [
      "profile",
      "tenantReference",
      "brandReference",
      "productReference",
      "versionReference",
      "aggregateVersion",
      "contentDigest",
      "configurationDigest",
      "originalIntentDigest",
      "observedAt",
      "validUntil",
      "brandSource",
      "policyReference",
      "policyVersion",
      "policyContentDigest",
      "approvalPolicy",
      "warningOverrideAllowed",
      "checks",
      "decision",
      "sourceAuthority",
      "publishValidation",
      "mediaReadiness",
      "referenceEligibility",
      "brandFieldRequirements",
      "eligibility",
      "digest",
    ];
    if (
      !a ||
      typeof a !== "object" ||
      Array.isArray(a) ||
      Object.keys(a).length !== keys.length ||
      keys.some((k) => !Object.hasOwn(a, k))
    )
      return fail();
    const { digest, ...body } = a;
    const brand = a.brandSource;
    if (
      !brand ||
      typeof brand !== "object" ||
      Array.isArray(brand) ||
      Object.keys(brand).length !== 4 ||
      [
        "brandVersion",
        "configurationVersionReference",
        "contentDigest",
        "currentPublicationReference",
      ].some((k) => !Object.hasOwn(brand, k)) ||
      !Number.isSafeInteger(brand.brandVersion) ||
      brand.brandVersion < 1 ||
      brand.brandVersion > 2147483647 ||
      typeof a.warningOverrideAllowed !== "boolean"
    )
      return fail();
    parseCatalogReference(brand.configurationVersionReference);
    parseCatalogReference(brand.currentPublicationReference);
    parsePublishingDigest(brand.contentDigest);
    parsePublishingDigest(a.policyContentDigest);
    const codes = [
      "SupportedLocales",
      "RequiredProductNames",
      "CompleteContent",
      "RequiredMediaPresence",
    ];
    if (
      c.action !== "Validate" ||
      c.actorKind !== "User" ||
      a.profile !== "CatalogProductContentPolicyAssessmentV1" ||
      a.tenantReference !== c.tenantReference ||
      a.brandReference !== c.brandReference ||
      a.productReference !== c.productReference ||
      a.versionReference !== c.versionReference ||
      a.aggregateVersion !== c.expectedProductAggregateVersion ||
      a.aggregateVersion !== v.productAggregateVersion ||
      a.contentDigest !== c.contentDigest ||
      a.contentDigest !== v.contentDigest ||
      a.configurationDigest !== c.configurationDigest ||
      a.configurationDigest !== v.configurationDigest ||
      v.scopeDigest !== "sha256:" + sha256Hex(canonicalizeRfc8785(c.scopeSet)) ||
      v.periodDigest !== "sha256:" + sha256Hex(canonicalizeRfc8785(c.effectivePeriod)) ||
      a.originalIntentDigest !== "sha256:" + sha256Hex(canonicalizeRfc8785(c)) ||
      a.policyReference !== v.policyReference ||
      a.policyVersion !== v.policyVersion ||
      a.approvalPolicy !== v.approvalPolicy ||
      parseCatalogInstant(a.observedAt) > now ||
      c.occurredAt > a.observedAt ||
      parseCatalogInstant(a.validUntil) <= now ||
      a.validUntil <= a.observedAt ||
      Date.parse(a.validUntil) - Date.parse(a.observedAt) > 30000 ||
      v.checkedAt > now ||
      a.sourceAuthority !== "NotEvaluated" ||
      a.publishValidation !== "Incomplete" ||
      a.mediaReadiness !== "NotEvaluated" ||
      a.referenceEligibility !== "NotEvaluated" ||
      a.brandFieldRequirements !== "NotEvaluated" ||
      a.eligibility !== "NotEvaluated" ||
      !Array.isArray(a.checks) ||
      a.checks.length !== codes.length ||
      a.checks.some(
        (check, i) =>
          !check ||
          Object.keys(check).length !== 2 ||
          check.code !== codes[i] ||
          !["Pass", "HardError"].includes(check.outcome),
      ) ||
      a.decision !==
        (a.checks.some((check) => check.outcome === "HardError")
          ? "HardError"
          : "PassForAssessedRules") ||
      digest !== "sha256:" + sha256Hex(canonicalizeRfc8785(body)) ||
      a.checks.find((check) => check.code === "CompleteContent")?.outcome !== "Pass"
    )
      return fail();
    const localesFailed = a.checks.some(
        (check) =>
          ["SupportedLocales", "RequiredProductNames"].includes(check.code) &&
          check.outcome === "HardError",
      ),
      mediaMissing =
        a.checks.find((check) => check.code === "RequiredMediaPresence")?.outcome === "HardError";
    const checks = v.checks
      .filter((check) => check.code !== "HardErrorsCleared")
      .map((check) =>
        (check.code === "DefaultLocaleName" && localesFailed) ||
        (check.code === "MediaReady" && mediaMissing)
          ? { code: check.code, outcome: "HardError" as const }
          : check,
      );
    return parseProductPublicationValidation({
      ...v,
      validUntil: [v.validUntil, a.validUntil].sort()[0],
      checks: [
        ...checks,
        {
          code: "HardErrorsCleared",
          outcome: checks.some((check) => check.outcome === "HardError") ? "HardError" : "Pass",
        },
      ],
    });
  } catch {
    return fail();
  }
}
