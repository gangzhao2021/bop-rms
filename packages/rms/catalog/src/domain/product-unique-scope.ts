import { CatalogError } from "./product.js";
import type {
  ProductPublicationCommand,
  ProductPublicationVersion,
  ProductPublicationScope,
} from "./product-publication.js";
export interface ProductUniqueScopeFinding {
  readonly reason:
    | "BRAND_NOT_ACTIVE"
    | "NO_REGISTERED_STORES"
    | "STORE_NOT_CURRENT_ACTIVE"
    | "CURRENT_TOPOLOGY_REQUIRED"
    | "EQUAL_RANK_REQUIRES_DISPOSITION";
  readonly versionReference: string | null;
  readonly selectorIndex: number;
  readonly counterpartIndex: number | null;
}
const restrictions = (s: ProductPublicationScope, dimension: "Channel" | "OrderType") =>
  s.level === dimension && s.reference !== null
    ? [s.reference]
    : dimension === "Channel"
      ? s.channelCodes
      : s.orderTypeCodes;
const later = (a: string, b: string) => (a > b ? a : b);
const intersect = (a: readonly string[], b: readonly string[]) =>
  a.length === 0 || b.length === 0 || a.some((v) => b.includes(v));
/** Conservative structural conflict check. It does not choose newest, resolve
 * unavailable membership or authorize whole-version supersession. */
export function assessProductUniqueScopeRules(input: {
  readonly command: Pick<
    ProductPublicationCommand,
    "versionReference" | "scopeSet" | "effectivePeriod"
  >;
  readonly latest: readonly Omit<ProductPublicationVersion, "validationDecision">[];
  readonly scopeOrder: readonly string[];
  readonly activeStores: ReadonlySet<string>;
  readonly brandActive: boolean;
  readonly registeredStoreCount: number;
  readonly observedAt: string;
}) {
  const findings: ProductUniqueScopeFinding[] = [],
    c = input.command;
  const add = (
    reason: ProductUniqueScopeFinding["reason"],
    selectorIndex: number,
    versionReference: string | null = null,
    counterpartIndex: number | null = null,
  ) => findings.push(Object.freeze({ reason, selectorIndex, versionReference, counterpartIndex }));
  if (!input.brandActive) add("BRAND_NOT_ACTIVE", 0);
  if (input.registeredStoreCount === 0) add("NO_REGISTERED_STORES", 0);
  const supported = (scope: ProductPublicationScope, index: number, version: string | null) => {
    if (scope.level === "Region" || scope.level === "StoreGroup") {
      add("CURRENT_TOPOLOGY_REQUIRED", index, version);
      return false;
    }
    if (
      scope.level === "Store" &&
      (scope.reference === null || !input.activeStores.has(scope.reference))
    ) {
      add("STORE_NOT_CURRENT_ACTIVE", index, version);
      return false;
    }
    return true;
  };
  const ownSupported = c.scopeSet.map((s, i) => supported(s, i, null));
  const prospectiveFrom = later(input.observedAt, c.effectivePeriod.effectiveFrom.instant);
  const prospectiveUntil = c.effectivePeriod.effectiveUntil?.instant ?? null;
  if (prospectiveUntil !== null && prospectiveUntil <= prospectiveFrom)
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  let pairs = 0;
  for (const previous of input.latest) {
    if (
      previous.versionReference === c.versionReference ||
      !["Published", "Superseded", "Scheduled"].includes(previous.state)
    )
      continue;
    if (previous.state !== "Scheduled" && previous.publishedAt === null)
      throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
    const previousFrom =
      previous.state === "Scheduled"
        ? previous.effectivePeriod.effectiveFrom.instant
        : later(
            previous.publishedAt ?? previous.effectivePeriod.effectiveFrom.instant,
            previous.effectivePeriod.effectiveFrom.instant,
          );
    const boundedEnds = [
      prospectiveUntil,
      previous.effectivePeriod.effectiveUntil?.instant ?? null,
      previous.supersededAt,
    ]
      .filter((v): v is string => v !== null)
      .sort();
    const until = boundedEnds[0] ?? null,
      from = later(prospectiveFrom, previousFrom);
    if (until !== null && until <= from) continue;
    for (const [oldIndex, old] of previous.scopeSet.entries()) {
      const oldSupported = supported(old, oldIndex, previous.versionReference);
      for (const [newIndex, current] of c.scopeSet.entries()) {
        if (++pairs > 10000) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        if (
          !ownSupported[newIndex] ||
          !oldSupported ||
          !intersect(restrictions(old, "Channel"), restrictions(current, "Channel")) ||
          !intersect(restrictions(old, "OrderType"), restrictions(current, "OrderType"))
        )
          continue;
        if (
          old.level === "Store" &&
          current.level === "Store" &&
          old.reference !== current.reference
        )
          continue;
        if (input.scopeOrder.indexOf(old.level) === input.scopeOrder.indexOf(current.level))
          add("EQUAL_RANK_REQUIRES_DISPOSITION", newIndex, previous.versionReference, oldIndex);
      }
    }
  }
  return Object.freeze({
    check: Object.freeze({
      code: "UniqueScope" as const,
      outcome: findings.length === 0 ? ("Pass" as const) : ("HardError" as const),
    }),
    findings: Object.freeze(findings),
    supportedTopology: "RegisteredBrandStoreOnly" as const,
    equalRankResolution: "ExplicitDispositionRequired" as const,
  });
}
