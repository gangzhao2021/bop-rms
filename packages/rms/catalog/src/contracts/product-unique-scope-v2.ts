import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseTenantStoreReferenceSnapshot, tenantStoreReferenceDigest } from "@bop/tenant";
import {
  parsePublishingProductPublicationPolicy,
  publishingProductPublicationPolicyDigest,
} from "@bop/publishing";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  CatalogError,
  parseCatalogHash,
  parseCatalogInstant,
  parseCatalogReference,
} from "./product.js";
import { parseProductPublicationCommandV2 } from "./product-publication-v2.js";
import {
  catalogProductRetirementSourceHeadDigest,
  parseCatalogProductRetirementCoverage,
} from "./product-publication-source-v2.js";
import { assessProductUniqueScopeRulesV2 } from "../domain/product-unique-scope-v2.js";
import type { ProductUniqueScopeFinding } from "../domain/product-unique-scope.js";

const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function closed(value: unknown, fields: readonly string[]) {
  const r = copyCategoryPersistenceValue(value);
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(r, field))
  )
    return fail();
  return r as Record<string, unknown>;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("sha256:")) return fail();
  return "sha256:" + parseCatalogHash(value.slice(7));
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    return fail();
  return value as number;
}
function revision(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    return fail();
  return value;
}
const assessmentKeys = [
  "profile",
  "tenantReference",
  "brandReference",
  "productReference",
  "versionReference",
  "aggregateVersion",
  "contentDigest",
  "configurationDigest",
  "originalIntentDigest",
  "replacementIntentDigest",
  "sourceDigest",
  "sourceRevision",
  "sourceHeadDigest",
  "registeredStoreDigest",
  "policyReference",
  "policyVersion",
  "policyContentDigest",
  "policyPublicationReference",
  "observedAt",
  "validUntil",
  "check",
  "findings",
  "supportedTopology",
  "equalRankResolution",
  "sourceAuthority",
  "publishValidation",
  "eligibility",
  "digest",
] as const;

/** Strict immutable one-check result. Its digest is an integrity binding, not an
 * acquisition or permission receipt; the held owner must supply its provenance. */
export function parseCatalogProductUniqueScopeAssessmentV2(value: unknown) {
  try {
    const r = closed(value, assessmentKeys),
      check = closed(r.check, ["code", "outcome"]),
      observedAt = parseCatalogInstant(r.observedAt),
      validUntil = parseCatalogInstant(r.validUntil);
    if (
      r.profile !== "CatalogProductUniqueScopeAssessmentV2" ||
      r.supportedTopology !== "RegisteredBrandStoreOnly" ||
      !["ExactStoreSelectorRetirementBound", "NoReplacementRequested"].includes(
        r.equalRankResolution as string,
      ) ||
      r.sourceAuthority !== "NotEvaluated" ||
      r.publishValidation !== "Incomplete" ||
      r.eligibility !== "NotEvaluated" ||
      check.code !== "UniqueScope" ||
      !["Pass", "HardError"].includes(check.outcome as string) ||
      !Array.isArray(r.findings) ||
      r.findings.length > 10000 ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000
    )
      return fail();
    const findings = Object.freeze(
      r.findings.map((value): ProductUniqueScopeFinding => {
        const f = closed(value, [
            "reason",
            "versionReference",
            "selectorIndex",
            "counterpartIndex",
          ]),
          reason = f.reason as ProductUniqueScopeFinding["reason"],
          versionReference =
            f.versionReference === null ? null : parseCatalogReference(f.versionReference),
          selectorIndex = integer(f.selectorIndex, 0, 999),
          counterpartIndex =
            f.counterpartIndex === null ? null : integer(f.counterpartIndex, 0, 999);
        if (
          ![
            "BRAND_NOT_ACTIVE",
            "NO_REGISTERED_STORES",
            "STORE_NOT_CURRENT_ACTIVE",
            "CURRENT_TOPOLOGY_REQUIRED",
            "EQUAL_RANK_REQUIRES_DISPOSITION",
          ].includes(reason) ||
          (reason === "EQUAL_RANK_REQUIRES_DISPOSITION"
            ? versionReference === null ||
              counterpartIndex === null ||
              (r.equalRankResolution === "ExactStoreSelectorRetirementBound" && selectorIndex !== 0)
            : counterpartIndex !== null) ||
          (["BRAND_NOT_ACTIVE", "NO_REGISTERED_STORES"].includes(reason) &&
            (versionReference !== null || selectorIndex !== 0)) ||
          (r.equalRankResolution === "ExactStoreSelectorRetirementBound" &&
            versionReference === null &&
            selectorIndex !== 0)
        )
          return fail();
        return Object.freeze({ reason, versionReference, selectorIndex, counterpartIndex });
      }),
    );
    if (
      (findings.length === 0 ? "Pass" : "HardError") !== check.outcome ||
      new Set(findings.map((f) => canonicalizeRfc8785(f))).size !== findings.length
    )
      return fail();
    const body = {
      profile: "CatalogProductUniqueScopeAssessmentV2" as const,
      tenantReference: parseCatalogReference(r.tenantReference),
      brandReference: parseCatalogReference(r.brandReference),
      productReference: parseCatalogReference(r.productReference),
      versionReference: parseCatalogReference(r.versionReference),
      aggregateVersion: integer(r.aggregateVersion, 1, 2147483647),
      contentDigest: digest(r.contentDigest),
      configurationDigest: digest(r.configurationDigest),
      originalIntentDigest: digest(r.originalIntentDigest),
      replacementIntentDigest: digest(r.replacementIntentDigest),
      sourceDigest: digest(r.sourceDigest),
      sourceRevision: revision(r.sourceRevision),
      sourceHeadDigest: digest(r.sourceHeadDigest),
      registeredStoreDigest: digest(r.registeredStoreDigest),
      policyReference: parseCatalogReference(r.policyReference),
      policyVersion: integer(r.policyVersion, 1, 2147483647),
      policyContentDigest: digest(r.policyContentDigest),
      policyPublicationReference: parseCatalogReference(r.policyPublicationReference),
      observedAt,
      validUntil,
      check: Object.freeze({
        code: "UniqueScope" as const,
        outcome: check.outcome as "Pass" | "HardError",
      }),
      findings,
      supportedTopology: "RegisteredBrandStoreOnly" as const,
      equalRankResolution: r.equalRankResolution as
        "ExactStoreSelectorRetirementBound" | "NoReplacementRequested",
      sourceAuthority: "NotEvaluated" as const,
      publishValidation: "Incomplete" as const,
      eligibility: "NotEvaluated" as const,
    };
    if (digest(r.digest) !== hash(body)) return fail();
    return Object.freeze({ ...body, digest: hash(body) });
  } catch {
    return fail();
  }
}
export type CatalogProductUniqueScopeAssessmentV2 = ReturnType<
  typeof parseCatalogProductUniqueScopeAssessmentV2
>;

/** Pure necessary condition only. Complete SQL acquisition and all current field
 * permissions remain obligations of the source holding this result. */
export function assessCatalogProductUniqueScopeV2(
  commandValue: unknown,
  coverageValue: unknown,
  storesValue: unknown,
  policyValue: unknown,
  nowValue: unknown,
): CatalogProductUniqueScopeAssessmentV2 {
  try {
    const c = parseProductPublicationCommandV2(copyCategoryPersistenceValue(commandValue)),
      coverage = parseCatalogProductRetirementCoverage(coverageValue),
      stores = parseTenantStoreReferenceSnapshot(copyCategoryPersistenceValue(storesValue)),
      p = closed(policyValue, [
        "content",
        "currentPublicationReference",
        "observedAt",
        "validUntil",
      ]),
      policy = parsePublishingProductPublicationPolicy(p.content),
      policyUntil = parseCatalogInstant(p.validUntil),
      policyPublicationReference = parseCatalogReference(p.currentPublicationReference),
      observedAt = parseCatalogInstant(coverage.observedAt),
      now = parseCatalogInstant(nowValue),
      originalIntentDigest = hash(c),
      intent = c.replacementIntent,
      current = coverage.latest.find((head) => head.versionReference === c.versionReference);
    if (
      c.action !== "Validate" ||
      c.actorKind !== "User" ||
      c.occurredAt > observedAt ||
      coverage.tenantReference !== c.tenantReference ||
      coverage.brandReference !== c.brandReference ||
      coverage.productReference !== c.productReference ||
      coverage.aggregateVersion !== c.expectedProductAggregateVersion ||
      (current?.publicationVersion ?? 0) !== c.expectedPublicationVersion ||
      (current !== undefined &&
        (!("profile" in current) ||
          current.state !== "Draft" ||
          current.occurredAt > c.occurredAt)) ||
      stores.brandReference !== c.brandReference ||
      stores.originalIntentDigest !== originalIntentDigest ||
      stores.observedAt !== observedAt ||
      policy.tenantReference !== c.tenantReference ||
      policy.brandReference !== c.brandReference ||
      p.observedAt !== observedAt ||
      parseCatalogInstant(policy.effectiveFrom) > observedAt ||
      policyUntil <= observedAt ||
      Date.parse(policyUntil) - Date.parse(observedAt) > 30000 ||
      (policy.effectiveUntil !== null &&
        policyUntil > parseCatalogInstant(policy.effectiveUntil)) ||
      now < observedAt ||
      Date.parse(now) - Date.parse(observedAt) >= 5000 ||
      now >= policyUntil
    )
      return fail();
    if (intent.mode === "PermanentSelectorRetirement") {
      const previous = coverage.latest.find(
          (head) => head.versionReference === intent.previousVersionReference,
        ),
        selector = previous?.scopeSet[intent.previousSelectorIndex];
      if (
        !previous ||
        previous.state !== "Published" ||
        previous.operationReference !== intent.previousPublicationOperationReference ||
        previous.publicationVersion !== intent.expectedPreviousPublicationVersion ||
        previous.intentDigest !== intent.previousIntentDigest ||
        previous.scopeDigest !== intent.previousScopeDigest ||
        previous.periodDigest !== intent.previousPeriodDigest ||
        previous.occurredAt > c.occurredAt ||
        previous.publishedAt === null ||
        previous.publishedAt > observedAt ||
        previous.effectivePeriod.effectiveFrom.instant > observedAt ||
        (previous.effectivePeriod.effectiveUntil !== null &&
          observedAt >= previous.effectivePeriod.effectiveUntil.instant) ||
        previous.scopeSet.length < 1 ||
        previous.scopeSet.some((scope) => scope.level !== "Store") ||
        new Set(previous.scopeSet.map((scope) => scope.reference)).size !==
          previous.scopeSet.length ||
        !selector ||
        hash(selector) !== intent.previousSelectorDigest ||
        !equal(selector, c.scopeSet[0]) ||
        coverage.headers.some((header) =>
          header.retirements.some(
            (row) =>
              row.replacementIntent.previousPublicationOperationReference ===
                previous.operationReference &&
              row.replacementIntent.previousSelectorIndex === intent.previousSelectorIndex,
          ),
        )
      )
        return fail();
    }
    const historyUntil = new Date(Date.parse(observedAt) + 5000).toISOString(),
      body = {
        profile: "CatalogProductUniqueScopeAssessmentV2",
        tenantReference: c.tenantReference,
        brandReference: c.brandReference,
        productReference: c.productReference,
        versionReference: c.versionReference,
        aggregateVersion: c.expectedProductAggregateVersion,
        contentDigest: c.contentDigest,
        configurationDigest: c.configurationDigest,
        originalIntentDigest,
        replacementIntentDigest: c.replacementIntentDigest,
        sourceDigest: coverage.digest,
        sourceRevision: coverage.sourceRevision,
        sourceHeadDigest: catalogProductRetirementSourceHeadDigest({
          tenantReference: coverage.tenantReference,
          brandReference: coverage.brandReference,
          productReference: coverage.productReference,
          aggregateVersion: coverage.aggregateVersion,
          sourceRevision: coverage.sourceRevision,
          latest: coverage.latest,
        }),
        registeredStoreDigest: tenantStoreReferenceDigest(stores),
        policyReference: policy.policyReference,
        policyVersion: policy.policyVersion,
        policyContentDigest: publishingProductPublicationPolicyDigest(policy),
        policyPublicationReference,
        observedAt,
        validUntil: historyUntil < policyUntil ? historyUntil : policyUntil,
        ...assessProductUniqueScopeRulesV2({
          command: c,
          latest: coverage.latest,
          scopeOrder: policy.scopeOrder,
          activeStores: new Set(
            stores.references
              .filter((store) => store.lifecycle === "Active")
              .map((store) => store.storeReference),
          ),
          brandActive: stores.brandLifecycle === "Active",
          registeredStoreCount: stores.references.length,
          observedAt,
          replacementIntent: intent,
          retirementHeaders: coverage.headers,
        }),
        sourceAuthority: "NotEvaluated",
        publishValidation: "Incomplete",
        eligibility: "NotEvaluated",
      };
    return parseCatalogProductUniqueScopeAssessmentV2({ ...body, digest: hash(body) });
  } catch {
    return fail();
  }
}
