import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  CatalogError,
  parseCatalogCode,
  parseCatalogHash,
  parseCatalogInstant,
  parseCatalogReference,
} from "./product.js";
import {
  parseProductPublicationVersion,
  productPublicationActions,
  productPublicationScopeLevels,
  type ProductPublicationAction,
  type ProductPublicationContext,
  type ProductPublicationScopeLevel,
  type ProductPublicationVersion,
} from "./product-publication.js";
import {
  parseProductPublicationVersionV2,
  type ProductPublicationVersionV2,
} from "./product-publication-v2.js";
import {
  bindCatalogProductScopeRetirementHeader,
  parseCatalogProductScopeRetirementHeader,
  type CatalogProductScopeRetirementHeader,
} from "./product-scope-retirement.js";
import { resolveProductPublicationVersion } from "../domain/product-publication.js";

export type CatalogProductRetirementPublication =
  ProductPublicationVersion | ProductPublicationVersionV2;
export interface CatalogProductRetirementHistoryEntry {
  readonly publicationAction: ProductPublicationAction;
  readonly publication: CatalogProductRetirementPublication;
}
export interface CatalogProductRetirementCoverage {
  readonly profile: "CatalogProductRetirementCoverageV1";
  readonly coverage: "CompleteRecordedPublicationRetirements";
  readonly sourceAuthority: "NotEvaluated";
  readonly eligibility: "NotEvaluated";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly productReference: string;
  readonly aggregateVersion: number;
  readonly sourceRevision: string;
  readonly observedAt: string;
  readonly history: readonly CatalogProductRetirementHistoryEntry[];
  readonly headers: readonly CatalogProductScopeRetirementHeader[];
  readonly latest: readonly CatalogProductRetirementPublication[];
  readonly digest: string;
}
const inputKeys = [
  "tenantReference",
  "brandReference",
  "productReference",
  "aggregateVersion",
  "sourceRevision",
  "observedAt",
  "history",
  "headers",
] as const;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const equal = (left: unknown, right: unknown) =>
  canonicalizeRfc8785(left) === canonicalizeRfc8785(right);
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return fail();
  return value as Record<string, unknown>;
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
function isV2(value: CatalogProductRetirementPublication): value is ProductPublicationVersionV2 {
  return "profile" in value;
}
function publication(value: unknown): CatalogProductRetirementPublication {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const p = Object.hasOwn(value, "profile")
    ? parseProductPublicationVersionV2(value)
    : parseProductPublicationVersion(value);
  // These are persisted ordinals and bytes, not caller instructions to normalize.
  if (!equal(value, p)) return fail();
  return p;
}
const actionStates: Record<ProductPublicationAction, ProductPublicationVersion["state"]> = {
  Validate: "Draft",
  SubmitReview: "InReview",
  Approve: "Approved",
  Reject: "Draft",
  SchedulePublish: "Scheduled",
  ReschedulePublish: "Scheduled",
  CancelScheduledPublish: "Draft",
  Publish: "Published",
  ActivateScheduled: "Published",
  Supersede: "Superseded",
};
function follows(
  action: ProductPublicationAction,
  previous: Pick<CatalogProductRetirementPublication, "state" | "approvalPolicy">,
): boolean {
  switch (action) {
    case "Validate":
    case "SubmitReview":
      return previous.state === "Draft";
    case "Approve":
    case "Reject":
      return previous.state === "InReview";
    case "SchedulePublish":
    case "Publish":
      return (
        previous.state === "Approved" ||
        (previous.state === "InReview" && previous.approvalPolicy === "NotRequired")
      );
    case "ReschedulePublish":
    case "CancelScheduledPublish":
    case "ActivateScheduled":
      return previous.state === "Scheduled";
    case "Supersede":
      return previous.state === "Published";
  }
}
/** Stable fingerprint of the exact immutable heads observed before an operation.
 * Observation time is excluded so complete history can independently reconstruct
 * each recorded fingerprint without rewriting prior source leases. */
export function catalogProductRetirementSourceHeadDigest(value: unknown): string {
  const r = record(copyCategoryPersistenceValue(value), [
      "tenantReference",
      "brandReference",
      "productReference",
      "aggregateVersion",
      "sourceRevision",
      "latest",
    ]),
    tenantReference = parseCatalogReference(r.tenantReference),
    brandReference = parseCatalogReference(r.brandReference),
    productReference = parseCatalogReference(r.productReference),
    aggregateVersion = r.aggregateVersion,
    sourceRevision = revision(r.sourceRevision);
  if (
    !Number.isSafeInteger(aggregateVersion) ||
    (aggregateVersion as number) < 1 ||
    (aggregateVersion as number) > 2147483647 ||
    !Array.isArray(r.latest) ||
    r.latest.length > 1000
  )
    return fail();
  const latest = r.latest
    .map(publication)
    .sort((a, b) => a.versionReference.localeCompare(b.versionReference));
  if (
    new Set(latest.map((p) => p.versionReference)).size !== latest.length ||
    latest.some(
      (p) =>
        p.tenantReference !== tenantReference ||
        p.brandReference !== brandReference ||
        p.productReference !== productReference ||
        p.productAggregateVersion >= (aggregateVersion as number),
    )
  )
    return fail();
  return hash({
    profile: "CatalogProductRetirementSourceHeadsV1",
    tenantReference,
    brandReference,
    productReference,
    aggregateVersion,
    sourceRevision,
    latest,
  });
}
/** Proves consistency and recorded retirement coverage of the supplied history.
 * Only the native reader can prove that SQL history was acquired completely and
 * under current authority; this pure value deliberately makes neither claim. */
export function buildCatalogProductRetirementCoverage(
  value: unknown,
): CatalogProductRetirementCoverage {
  try {
    const r = record(copyCategoryPersistenceValue(value), inputKeys),
      tenantReference = parseCatalogReference(r.tenantReference),
      brandReference = parseCatalogReference(r.brandReference),
      productReference = parseCatalogReference(r.productReference),
      aggregateVersion = r.aggregateVersion,
      sourceRevision = revision(r.sourceRevision),
      observedAt = parseCatalogInstant(r.observedAt);
    if (
      !Number.isSafeInteger(aggregateVersion) ||
      (aggregateVersion as number) < 1 ||
      (aggregateVersion as number) > 2147483647 ||
      !Array.isArray(r.history) ||
      r.history.length > 1000 ||
      !Array.isArray(r.headers) ||
      r.headers.length > 1000
    )
      return fail();
    const headers = r.headers.map(parseCatalogProductScopeRetirementHeader),
      headerByOperation = new Map<string, CatalogProductScopeRetirementHeader>();
    for (const header of headers) {
      if (
        headerByOperation.has(header.operationReference) ||
        BigInt(header.observedSourceRevision) >= BigInt(sourceRevision)
      )
        return fail();
      headerByOperation.set(header.operationReference, header);
    }
    const operations = new Map<string, CatalogProductRetirementPublication>(),
      latest = new Map<string, CatalogProductRetirementPublication>(),
      retired = new Set<string>(),
      boundHeaders: CatalogProductScopeRetirementHeader[] = [];
    let previousRoot = 0,
      previousAt = "",
      previousObservedRevision = 0n;
    const history = Object.freeze(
      r.history.map((value): CatalogProductRetirementHistoryEntry => {
        const entry = record(value, ["publicationAction", "publication"]),
          p = publication(entry.publication),
          a = entry.publicationAction as ProductPublicationAction;
        if (
          !productPublicationActions.includes(a) ||
          p.state !== actionStates[a] ||
          p.actorKind !== (a === "ActivateScheduled" || a === "Supersede" ? "System" : "User") ||
          p.tenantReference !== tenantReference ||
          p.brandReference !== brandReference ||
          p.productReference !== productReference ||
          p.productAggregateVersion + 1 > (aggregateVersion as number) ||
          p.productAggregateVersion <= previousRoot ||
          p.occurredAt < previousAt ||
          p.occurredAt > observedAt ||
          operations.has(p.operationReference)
        )
          return fail();
        const old = latest.get(p.versionReference);
        if (
          p.publicationVersion !== (old ? old.publicationVersion + 1 : 1) ||
          (!old && a !== "Validate") ||
          (old && (isV2(old) !== isV2(p) || !follows(a, old)))
        )
          return fail();
        if (
          old &&
          isV2(p) &&
          isV2(old) &&
          p.replacementIntentDigest !== old.replacementIntentDigest &&
          !(a === "Validate" && old.state === "Draft")
        )
          return fail();
        // Published content and selector bytes survive a later whole-version V1
        // Supersede; immutable history must not relocate a retired ordinal.
        if (
          old &&
          (old.state === "Published" || old.state === "Superseded") &&
          (a !== "Supersede" ||
            old.state !== "Published" ||
            p.scopeDigest !== old.scopeDigest ||
            p.periodDigest !== old.periodDigest ||
            p.contentDigest !== old.contentDigest ||
            p.configurationDigest !== old.configurationDigest ||
            p.publishedAt !== old.publishedAt)
        )
          return fail();
        const header = headerByOperation.get(p.operationReference);
        if (isV2(p)) {
          if (
            !header ||
            BigInt(header.observedSourceRevision) <= previousObservedRevision ||
            header.observedSourceHeadDigest !==
              catalogProductRetirementSourceHeadDigest({
                tenantReference,
                brandReference,
                productReference,
                aggregateVersion: p.productAggregateVersion,
                sourceRevision: header.observedSourceRevision,
                latest: [...latest.values()],
              })
          )
            return fail();
          let previousPublication: CatalogProductRetirementPublication | null = null;
          if (
            (a === "Publish" || a === "ActivateScheduled") &&
            p.replacementIntent.mode === "PermanentSelectorRetirement"
          ) {
            const target = operations.get(
              p.replacementIntent.previousPublicationOperationReference,
            );
            if (!target || latest.get(target.versionReference) !== target) return fail();
            previousPublication = target;
            const key = target.operationReference + ":" + p.replacementIntent.previousSelectorIndex;
            if (retired.has(key)) return fail();
            retired.add(key);
          }
          boundHeaders.push(
            bindCatalogProductScopeRetirementHeader(header, {
              publicationAction: a,
              publication: p,
              previousPublication,
            }),
          );
          previousObservedRevision = BigInt(header.observedSourceRevision);
        } else if (header) return fail();
        previousRoot = p.productAggregateVersion;
        previousAt = p.occurredAt;
        operations.set(p.operationReference, p);
        latest.set(p.versionReference, p);
        return Object.freeze({ publicationAction: a, publication: p });
      }),
    );
    if (boundHeaders.length !== headers.length || !equal(headers, boundHeaders)) return fail();
    const body = {
      profile: "CatalogProductRetirementCoverageV1" as const,
      coverage: "CompleteRecordedPublicationRetirements" as const,
      sourceAuthority: "NotEvaluated" as const,
      eligibility: "NotEvaluated" as const,
      tenantReference,
      brandReference,
      productReference,
      aggregateVersion: aggregateVersion as number,
      sourceRevision,
      observedAt,
      history,
      headers: Object.freeze(boundHeaders),
      latest: Object.freeze(
        [...latest.values()].sort((left, right) =>
          left.versionReference.localeCompare(right.versionReference),
        ),
      ),
    };
    return Object.freeze({ ...body, digest: hash(body) });
  } catch {
    return fail();
  }
}
export function parseCatalogProductRetirementCoverage(
  value: unknown,
): CatalogProductRetirementCoverage {
  try {
    const r = record(copyCategoryPersistenceValue(value), [
      ...inputKeys,
      "profile",
      "coverage",
      "sourceAuthority",
      "eligibility",
      "latest",
      "digest",
    ]);
    if (typeof r.digest !== "string" || !r.digest.startsWith("sha256:")) return fail();
    parseCatalogHash(r.digest.slice(7));
    const parsed = buildCatalogProductRetirementCoverage(
      Object.fromEntries(inputKeys.map((key) => [key, r[key]])),
    );
    if (!equal(r, parsed)) return fail();
    return parsed;
  } catch {
    return fail();
  }
}
function unique<T>(value: unknown, parser: (value: unknown) => T, maximum: number): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum) return fail();
  const result = value.map(parser);
  if (new Set(result).size !== result.length) return fail();
  return Object.freeze(result);
}
/** Historical resolution cannot assert future execution or current authority.
 * Current native callers separately enforce the owning source freshness lease. */
export function resolveCatalogProductPublicationWithRetirements(
  coverageValue: unknown,
  contextValue: unknown,
  explicitCurrentScopeOrder: unknown,
) {
  const coverage = parseCatalogProductRetirementCoverage(coverageValue),
    r = record(
      copyCategoryPersistenceValue({ context: contextValue, order: explicitCurrentScopeOrder }),
      ["context", "order"],
    ),
    c = record(r.context, [
      "storeReference",
      "storeGroupReferences",
      "regionReferences",
      "channelCode",
      "orderTypeCode",
      "at",
    ]);
  const context: ProductPublicationContext = Object.freeze({
    storeReference: parseCatalogReference(c.storeReference),
    storeGroupReferences: unique(c.storeGroupReferences, parseCatalogReference, 1000),
    regionReferences: unique(c.regionReferences, parseCatalogReference, 1000),
    channelCode: parseCatalogCode(c.channelCode),
    orderTypeCode: parseCatalogCode(c.orderTypeCode),
    at: parseCatalogInstant(c.at),
  });
  const order = unique(
    r.order,
    (value): ProductPublicationScopeLevel => {
      if (!productPublicationScopeLevels.includes(value as ProductPublicationScopeLevel))
        return fail();
      return value as ProductPublicationScopeLevel;
    },
    6,
  );
  if (order.length !== 6 || context.at > coverage.observedAt) return fail();
  const excluded = new Set<string>();
  for (const header of coverage.headers)
    for (const row of header.retirements) {
      if (row.retiredAt > context.at) continue;
      const original = coverage.history.find(
          (entry) =>
            entry.publication.operationReference ===
            row.replacementIntent.previousPublicationOperationReference,
        )?.publication,
        selector = original?.scopeSet[row.replacementIntent.previousSelectorIndex];
      if (!original || !selector) return fail();
      if (
        selector.reference === context.storeReference &&
        (selector.channelCodes.length === 0 ||
          selector.channelCodes.includes(context.channelCode)) &&
        (selector.orderTypeCodes.length === 0 ||
          selector.orderTypeCodes.includes(context.orderTypeCode))
      )
        excluded.add(original.versionReference);
    }
  // Each accepted original is distinct Store-only selectors: omitting the whole
  // version for this matching context cannot hide another matching selector.
  // Original V1/V2 objects and all scope/period digests remain untouched.
  return resolveProductPublicationVersion(
    coverage.latest.filter((p) => !excluded.has(p.versionReference)),
    context,
    order,
  );
}
