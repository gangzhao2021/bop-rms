import { CatalogError } from "./product.js";
import {
  productPublicationScopeLevels,
  type ProductPublicationScope,
  type ProductPublicationScopeLevel,
  type ProductPublicationVersion,
} from "./product-publication.js";

const fail = (): never => {
  throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
};
export interface ProductSelectorOverlap {
  readonly previousVersionReference: string;
  readonly previousOperationReference: string;
  readonly previousIntentDigest: string;
  readonly previousScopeDigest: string;
  readonly previousSelectorIndex: number;
  readonly incomingSelectorIndex: number;
  readonly storeReference: string | null;
  /** Empty means all values, not absence of coverage. */
  readonly channelCodes: readonly string[];
  readonly orderTypeCodes: readonly string[];
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly relation:
    "IncomingSelectorPreferred" | "ExistingSelectorPreferred" | "EqualPrecedenceOverlap";
}
function intersection(a: readonly string[], b: readonly string[]): readonly string[] | null {
  if (a.length === 0) return Object.freeze([...b]);
  if (b.length === 0) return Object.freeze([...a]);
  const result = a.filter((value) => b.includes(value));
  return result.length === 0 ? null : Object.freeze(result);
}
const codes = (scope: ProductPublicationScope, dimension: "Channel" | "OrderType") =>
  scope.level === dimension && scope.reference !== null
    ? [scope.reference]
    : dimension === "Channel"
      ? scope.channelCodes
      : scope.orderTypeCodes;
const earlierEnd = (...values: (string | null)[]) => {
  const bounded = values.filter((v): v is string => v !== null).sort();
  return bounded[0] ?? null;
};
/** Selector-pair metadata only. Current context resolution of the complete union
 * remains authoritative; this plan never globally supersedes an old version. */
export function planProductSelectorOverlaps(input: {
  readonly incoming: ProductPublicationVersion;
  readonly existing: readonly ProductPublicationVersion[];
  readonly scopeOrder: readonly ProductPublicationScopeLevel[];
  readonly observedAt: string;
}) {
  const { incoming, existing, scopeOrder, observedAt } = input;
  if (
    scopeOrder.length !== productPublicationScopeLevels.length ||
    new Set(scopeOrder).size !== scopeOrder.length ||
    productPublicationScopeLevels.some((level) => !scopeOrder.includes(level)) ||
    scopeOrder.indexOf("Store") >= scopeOrder.indexOf("Brand") ||
    incoming.state !== "Published" ||
    incoming.publishedAt === null ||
    incoming.publishedAt > observedAt ||
    incoming.occurredAt > observedAt ||
    incoming.effectivePeriod.effectiveFrom.instant > incoming.publishedAt ||
    existing.length > 1000 ||
    new Set(existing.map((c) => c.versionReference)).size !== existing.length ||
    existing.reduce((sum, c) => sum + c.scopeSet.length, 0) * incoming.scopeSet.length > 10_000
  )
    return fail();
  const overlaps: ProductSelectorOverlap[] = [];
  const unresolved: {
    previousVersionReference: string;
    previousSelectorIndex: number;
    incomingSelectorIndex: number;
    reason: "CURRENT_TOPOLOGY_REQUIRED";
  }[] = [];
  for (const previous of existing) {
    if (
      previous.tenantReference !== incoming.tenantReference ||
      previous.brandReference !== incoming.brandReference ||
      previous.productReference !== incoming.productReference ||
      previous.versionReference === incoming.versionReference ||
      (previous.state !== "Published" && previous.state !== "Superseded") ||
      previous.publishedAt === null ||
      previous.occurredAt > observedAt ||
      previous.publishedAt > incoming.publishedAt
    )
      return fail();
    const effectiveFrom = [
      incoming.publishedAt,
      incoming.effectivePeriod.effectiveFrom.instant,
      previous.publishedAt,
      previous.effectivePeriod.effectiveFrom.instant,
    ]
      .sort()
      .at(-1);
    if (!effectiveFrom) return fail();
    const effectiveUntil = earlierEnd(
      incoming.effectivePeriod.effectiveUntil?.instant ?? null,
      previous.effectivePeriod.effectiveUntil?.instant ?? null,
      previous.supersededAt,
    );
    if (effectiveUntil !== null && effectiveUntil <= effectiveFrom) continue;
    for (const [previousSelectorIndex, oldScope] of previous.scopeSet.entries()) {
      for (const [incomingSelectorIndex, newScope] of incoming.scopeSet.entries()) {
        const channelCodes = intersection(codes(oldScope, "Channel"), codes(newScope, "Channel"));
        const orderTypeCodes = intersection(
          codes(oldScope, "OrderType"),
          codes(newScope, "OrderType"),
        );
        if (channelCodes === null || orderTypeCodes === null) continue;
        if (
          oldScope.level === "Store" &&
          newScope.level === "Store" &&
          oldScope.reference !== newScope.reference
        )
          continue;
        if (
          [oldScope.level, newScope.level].some(
            (level) => level === "Region" || level === "StoreGroup",
          )
        ) {
          unresolved.push(
            Object.freeze({
              previousVersionReference: previous.versionReference,
              previousSelectorIndex,
              incomingSelectorIndex,
              reason: "CURRENT_TOPOLOGY_REQUIRED",
            }),
          );
          continue;
        }
        const oldRank = scopeOrder.indexOf(oldScope.level),
          newRank = scopeOrder.indexOf(newScope.level);
        overlaps.push(
          Object.freeze({
            previousVersionReference: previous.versionReference,
            previousOperationReference: previous.operationReference,
            previousIntentDigest: previous.intentDigest,
            previousScopeDigest: previous.scopeDigest,
            previousSelectorIndex,
            incomingSelectorIndex,
            storeReference:
              oldScope.level === "Store"
                ? oldScope.reference
                : newScope.level === "Store"
                  ? newScope.reference
                  : null,
            channelCodes,
            orderTypeCodes,
            effectiveFrom,
            effectiveUntil,
            relation:
              newRank < oldRank
                ? "IncomingSelectorPreferred"
                : oldRank < newRank
                  ? "ExistingSelectorPreferred"
                  : "EqualPrecedenceOverlap",
          }),
        );
      }
    }
  }
  return Object.freeze({
    analysis:
      unresolved.length === 0
        ? ("CompleteSelectorAnalysis" as const)
        : ("TopologyRequired" as const),
    overlaps: Object.freeze(overlaps),
    unresolved: Object.freeze(unresolved),
    eligibility: "NotEvaluated" as const,
    sourceCoverage: "NotEvaluated" as const,
    currentPolicySource: "NotEvaluated" as const,
    wholeVersionSupersession: "NotEvaluated" as const,
  });
}
