import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  CatalogError,
  parseCatalogHash,
  parseCatalogInstant,
  parseCatalogReference,
} from "./product.js";
import { parseCatalogProductEditorSnapshot } from "./product-editor-snapshot.js";
import { parseProductPublicationSourceRequest } from "./product-publication-source.js";
import {
  parseCatalogProductRetirementCoverage,
  type CatalogProductRetirementCoverage,
} from "./product-publication-source-v2.js";
import {
  parseCatalogProductPublicationReplacementIntent,
  parseCatalogProductScopeReplacementIntent,
  type CatalogProductScopeReplacementIntent,
} from "./product-scope-replacement-intent.js";
import type { ProductPublicationScope } from "./product-publication.js";

const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const equal = (left: unknown, right: unknown) =>
  canonicalizeRfc8785(left) === canonicalizeRfc8785(right);
const maximumBytes = 2 * 1024 * 1024;
function record(value: unknown, keys: readonly string[]) {
  const r = copyCategoryPersistenceValue(value);
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(r, key))
  )
    return fail();
  return r as Record<string, unknown>;
}
function digest(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("sha256:")) return fail();
  return "sha256:" + parseCatalogHash(value.slice(7));
}
function draft(value: unknown) {
  const r = record(value, [
    "versionReference",
    "contentDigest",
    "configurationDigest",
    "contentStatus",
  ]);
  if (r.contentStatus !== "Present" && r.contentStatus !== "Unavailable") return fail();
  return Object.freeze({
    versionReference: parseCatalogReference(r.versionReference),
    contentDigest: digest(r.contentDigest),
    configurationDigest: digest(r.configurationDigest),
    contentStatus: r.contentStatus,
  });
}
/** A recorded target, not permission, current topology or publication qualification. */
export interface CatalogProductRecordedReplacementTarget {
  readonly selector: ProductPublicationScope;
  readonly replacementIntent: CatalogProductScopeReplacementIntent;
}
function assemble(
  coverage: CatalogProductRetirementCoverage,
  storeReference: string,
  currentDraft: ReturnType<typeof draft>,
  editorObservedAt: string,
  observedAt: string,
) {
  const validUntil = new Date(
    Math.min(Date.parse(editorObservedAt), Date.parse(coverage.observedAt)) + 5000,
  ).toISOString();
  if (observedAt < editorObservedAt || observedAt < coverage.observedAt || observedAt >= validUntil)
    return fail();
  const targets: CatalogProductRecordedReplacementTarget[] = [];
  for (const p of coverage.latest) {
    if (
      p.state !== "Published" ||
      p.publishedAt === null ||
      p.publishedAt > observedAt ||
      p.occurredAt > observedAt ||
      p.supersededAt !== null ||
      p.effectivePeriod.effectiveFrom.instant > observedAt ||
      (p.effectivePeriod.effectiveUntil !== null &&
        p.effectivePeriod.effectiveUntil.instant <= observedAt) ||
      p.scopeSet.length < 1 ||
      p.scopeSet.some((scope) => scope.level !== "Store") ||
      new Set(p.scopeSet.map((scope) => scope.reference)).size !== p.scopeSet.length
    )
      continue;
    for (const [index, selector] of p.scopeSet.entries()) {
      if (
        selector.reference !== storeReference ||
        coverage.headers.some((header) =>
          header.retirements.some(
            (row) =>
              row.replacementIntent.previousPublicationOperationReference ===
                p.operationReference &&
              row.replacementIntent.previousSelectorIndex === index &&
              row.retiredAt <= observedAt,
          ),
        )
      )
        continue;
      const body = {
        profile: "CatalogProductExactStoreSelectorReplacementV1" as const,
        mode: "PermanentSelectorRetirement" as const,
        previousVersionReference: p.versionReference,
        previousPublicationOperationReference: p.operationReference,
        expectedPreviousPublicationVersion: p.publicationVersion,
        previousIntentDigest: p.intentDigest,
        previousScopeDigest: p.scopeDigest,
        previousPeriodDigest: p.periodDigest,
        previousSelectorIndex: index,
        previousSelectorDigest: hash(selector),
      };
      targets.push(
        Object.freeze({
          selector,
          replacementIntent: parseCatalogProductScopeReplacementIntent({
            ...body,
            digest: hash(body),
          }),
        }),
      );
    }
  }
  const noneBody = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    noReplacementIntent = parseCatalogProductPublicationReplacementIntent({
      ...noneBody,
      digest: hash(noneBody),
    });
  if (noReplacementIntent.mode !== "None") return fail();
  const body = {
    profile: "CatalogProductPublicationManagementV2" as const,
    tenantReference: coverage.tenantReference,
    brandReference: coverage.brandReference,
    storeReference,
    productReference: coverage.productReference,
    aggregateVersion: coverage.aggregateVersion,
    observedAt,
    validUntil,
    editorObservedAt,
    sourceObservedAt: coverage.observedAt,
    sourceRevision: coverage.sourceRevision,
    sourceDigest: coverage.digest,
    coverage: "CompleteRecordedPublicationManagement" as const,
    eligibility: "NotEvaluated" as const,
    publishValidation: "Incomplete" as const,
    draft: currentDraft,
    versions: coverage.latest,
    history: coverage.history,
    scopeRetirementHeaders: coverage.headers,
    noReplacementIntent,
    replacementTargets: Object.freeze(targets),
  };
  const result = Object.freeze({ ...body, digest: hash(body) });
  if (new TextEncoder().encode(canonicalizeRfc8785(result)).length > maximumBytes) return fail();
  return result;
}
/** Compose only inside the held owning editor and retirement-aware source callbacks.
 * Observation does not renew either original five-second source lease. */
export function buildCatalogProductPublicationManagementV2(
  editorValue: unknown,
  coverageValue: unknown,
  scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  },
  input: unknown,
  observation: unknown,
) {
  try {
    const request = parseProductPublicationSourceRequest(input),
      editor = parseCatalogProductEditorSnapshot(editorValue),
      coverage = parseCatalogProductRetirementCoverage(coverageValue),
      safeScope = record(scope, ["tenantReference", "brandReference", "storeReference"]),
      tenantReference = parseCatalogReference(safeScope.tenantReference),
      brandReference = parseCatalogReference(safeScope.brandReference),
      storeReference = parseCatalogReference(safeScope.storeReference),
      now = parseCatalogInstant(observation);
    if (
      editor.tenantReference !== tenantReference ||
      editor.brandReference !== brandReference ||
      editor.productReference !== request.productReference ||
      editor.aggregateVersion !== request.expectedAggregateVersion ||
      coverage.tenantReference !== tenantReference ||
      coverage.brandReference !== brandReference ||
      coverage.productReference !== request.productReference ||
      coverage.aggregateVersion !== request.expectedAggregateVersion
    )
      return fail();
    return assemble(
      coverage,
      storeReference,
      draft({
        versionReference: editor.aggregate.draft.versionReference,
        contentDigest: editor.contentDigest,
        configurationDigest: editor.configurationDigest,
        contentStatus: editor.contentStatus,
      }),
      editor.observedAt,
      now,
    );
  } catch {
    return fail();
  }
}
export type CatalogProductPublicationManagementV2 = ReturnType<
  typeof buildCatalogProductPublicationManagementV2
>;
/** Closed transport integrity. Rebuild the complete source and each target; an
 * integrity digest alone cannot invent eligibility or a different target tuple. */
export function parseCatalogProductPublicationManagementV2(
  value: unknown,
): CatalogProductPublicationManagementV2 {
  try {
    const r = record(value, [
        "profile",
        "tenantReference",
        "brandReference",
        "storeReference",
        "productReference",
        "aggregateVersion",
        "observedAt",
        "validUntil",
        "editorObservedAt",
        "sourceObservedAt",
        "sourceRevision",
        "sourceDigest",
        "coverage",
        "eligibility",
        "publishValidation",
        "draft",
        "versions",
        "history",
        "scopeRetirementHeaders",
        "noReplacementIntent",
        "replacementTargets",
        "digest",
      ]),
      coverage = parseCatalogProductRetirementCoverage({
        profile: "CatalogProductRetirementCoverageV1",
        coverage: "CompleteRecordedPublicationRetirements",
        sourceAuthority: "NotEvaluated",
        eligibility: "NotEvaluated",
        tenantReference: r.tenantReference,
        brandReference: r.brandReference,
        productReference: r.productReference,
        aggregateVersion: r.aggregateVersion,
        sourceRevision: r.sourceRevision,
        observedAt: r.sourceObservedAt,
        history: r.history,
        headers: r.scopeRetirementHeaders,
        latest: r.versions,
        digest: r.sourceDigest,
      }),
      result = assemble(
        coverage,
        parseCatalogReference(r.storeReference),
        draft(r.draft),
        parseCatalogInstant(r.editorObservedAt),
        parseCatalogInstant(r.observedAt),
      );
    if (!equal(result, r)) return fail();
    return result;
  } catch {
    return fail();
  }
}
