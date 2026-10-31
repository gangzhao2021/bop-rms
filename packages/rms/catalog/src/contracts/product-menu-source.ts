import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parsePublishingDigest } from "@bop/publishing";
import { CatalogError, parseCatalogReference, parseCatalogInstant } from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  parseProductLifecycleReviewRequest,
  type ProductLifecycleReviewRequest,
} from "./product-lifecycle-review.js";
export const productMenuSourceMaximumRows = 1000;
export const productMenuSourceFields = Object.freeze([
  "targetExists",
  "coverageComplete",
  "skuReferences",
  "productVersionReferences",
  "reviewReference",
  "brandReference",
  "menuReference",
  "menuVersionReference",
  "snapshotDigest",
  "createdAt",
  "sectionReference",
  "placementReference",
  "skuReference",
  "productVersionReference",
  "lifecycleState",
  "lifecycleVersion",
  "changedAt",
  "releaseReference",
  "releaseSequence",
  "releaseKind",
  "timingReference",
  "timeZone",
  "effectiveFrom",
  "effectiveUntil",
  "periodDigest",
] as const);
type State = "Draft" | "InReview" | "Approved" | "Published" | "Archived" | "Superseded";
export interface ProductMenuPeriod {
  readonly timingReference: string;
  readonly timeZone: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly periodDigest: string;
  readonly createdAt: string;
  readonly temporalStatus: "Future" | "Effective" | "Expired";
}
export interface ProductMenuRelease {
  readonly releaseReference: string;
  readonly releaseSequence: number;
  readonly releaseKind: "Publish" | "Rollback";
  readonly lifecycleVersion: number;
  readonly createdAt: string;
  readonly periods: readonly ProductMenuPeriod[];
}
export interface ProductMenuReviewReference {
  readonly reviewReference: string;
  readonly brandReference: string;
  readonly menuReference: string;
  readonly menuVersionReference: string;
  readonly snapshotDigest: string;
  readonly createdAt: string;
  readonly lifecycle: null | {
    readonly state: State;
    readonly version: number;
    readonly changedAt: string;
  };
  readonly placements: readonly {
    readonly sectionReference: string;
    readonly placementReference: string;
    readonly skuReference: string;
    readonly productVersionReference: string;
  }[];
  readonly releases: readonly ProductMenuRelease[];
}
export interface ProductMenuSourceSnapshot {
  readonly request: ProductLifecycleReviewRequest;
  readonly consistency: "StatementSnapshot";
  readonly coverage: "Complete";
  readonly observedAt: string;
  readonly digest: string;
  readonly skuReferences: readonly string[];
  readonly productVersionReferences: readonly string[];
  readonly reviews: readonly ProductMenuReviewReference[];
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function exact(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    return fail();
  return value as Record<string, unknown>;
}
function rows(value: unknown) {
  if (!Array.isArray(value) || value.length > productMenuSourceMaximumRows) return fail();
  return value as unknown[];
}
function integer(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2147483647)
    return fail();
  return value as number;
}
function refs(value: unknown) {
  const result = rows(value).map(parseCatalogReference);
  if (new Set(result).size !== result.length) return fail();
  return result.sort();
}
/** Projection of immutable review/publication metadata only; no health payload or sale/approval authority. */
export function buildProductMenuSourceSnapshot(
  value: unknown,
  input: ProductLifecycleReviewRequest,
  now: string,
): ProductMenuSourceSnapshot {
  try {
    const request = parseProductLifecycleReviewRequest(input),
      r = exact(copyCategoryPersistenceValue(value), [
        "observedAt",
        "targetExists",
        "coverageComplete",
        "skuReferences",
        "productVersionReferences",
        "reviews",
      ]),
      observedAt = parseCatalogInstant(r.observedAt),
      at = parseCatalogInstant(now);
    if (
      r.targetExists !== true ||
      r.coverageComplete !== true ||
      observedAt > at ||
      Date.parse(at) - Date.parse(observedAt) > 5000
    )
      return fail();
    const skuReferences = refs(r.skuReferences),
      productVersionReferences = refs(r.productVersionReferences);
    if (
      productVersionReferences.length === 0 ||
      !productVersionReferences.includes(
        parseCatalogReference(request.originalProductVersionReference),
      ) ||
      (request.skuReference !== null &&
        (skuReferences.length !== 1 || skuReferences[0] !== request.skuReference))
    )
      return fail();
    const seen = new Set<string>(),
      releasesSeen = new Set<string>(),
      periodsSeen = new Set<string>();
    const past = (v: unknown) => {
      const time = parseCatalogInstant(v);
      if (time > observedAt) return fail();
      return time;
    };
    const reviews = rows(r.reviews)
      .map((value) => {
        const review = exact(value, [
            "reviewReference",
            "brandReference",
            "menuReference",
            "menuVersionReference",
            "snapshotDigest",
            "createdAt",
            "coherent",
            "placements",
            "lifecycle",
            "releases",
          ]),
          reviewReference = parseCatalogReference(review.reviewReference),
          brandReference = parseCatalogReference(review.brandReference),
          menuReference = parseCatalogReference(review.menuReference),
          menuVersionReference = parseCatalogReference(review.menuVersionReference),
          snapshotDigest = parsePublishingDigest(review.snapshotDigest),
          createdAt = past(review.createdAt);
        if (
          review.coherent !== true ||
          brandReference !== request.brandReference ||
          seen.has(reviewReference)
        )
          return fail();
        seen.add(reviewReference);
        const placementsSeen = new Set<string>();
        const allPlacements = rows(review.placements).map((value) => {
          const p = exact(value, [
              "sectionReference",
              "placementReference",
              "skuReference",
              "productVersionReference",
            ]),
            placementReference = parseCatalogReference(p.placementReference),
            skuReference = parseCatalogReference(p.skuReference),
            productVersionReference = parseCatalogReference(p.productVersionReference);
          if (placementsSeen.has(placementReference)) return fail();
          placementsSeen.add(placementReference);
          const skuMatch = skuReferences.includes(skuReference),
            versionMatch = productVersionReferences.includes(productVersionReference);
          // Individual SKU review may omit other SKU placements for the same Product.
          if (
            (skuMatch && !versionMatch) ||
            (request.skuReference === null && versionMatch && !skuMatch)
          )
            return fail();
          return Object.freeze({
            sectionReference: parseCatalogReference(p.sectionReference),
            placementReference,
            skuReference,
            productVersionReference,
          });
        });
        const lifecycle =
          review.lifecycle === null
            ? null
            : (() => {
                const l = exact(review.lifecycle, ["state", "version", "changedAt", "coherent"]);
                if (
                  l.coherent !== true ||
                  ![
                    "Draft",
                    "InReview",
                    "Approved",
                    "Published",
                    "Archived",
                    "Superseded",
                  ].includes(l.state as string)
                )
                  return fail();
                const changedAt = past(l.changedAt);
                if (changedAt < createdAt) return fail();
                return Object.freeze({
                  state: l.state as State,
                  version: integer(l.version),
                  changedAt,
                });
              })();
        const sequences = new Set<number>();
        const releases = rows(review.releases)
          .map((value) => {
            const rel = exact(value, [
                "releaseReference",
                "releaseSequence",
                "releaseKind",
                "lifecycleVersion",
                "snapshotDigest",
                "createdAt",
                "coherent",
                "periods",
              ]),
              releaseReference = parseCatalogReference(rel.releaseReference),
              releaseSequence = integer(rel.releaseSequence),
              lifecycleVersion = integer(rel.lifecycleVersion),
              releasedAt = past(rel.createdAt);
            if (
              rel.coherent !== true ||
              !lifecycle ||
              lifecycleVersion > lifecycle.version ||
              releasedAt < createdAt ||
              parsePublishingDigest(rel.snapshotDigest) !== snapshotDigest ||
              sequences.has(releaseSequence) ||
              releasesSeen.has(releaseReference) ||
              (rel.releaseKind !== "Publish" && rel.releaseKind !== "Rollback")
            )
              return fail();
            sequences.add(releaseSequence);
            releasesSeen.add(releaseReference);
            const periods = rows(rel.periods)
              .map((value) => {
                const p = exact(value, [
                    "timingReference",
                    "timeZone",
                    "effectiveFrom",
                    "effectiveUntil",
                    "periodDigest",
                    "createdAt",
                    "precise",
                  ]),
                  timingReference = parseCatalogReference(p.timingReference),
                  effectiveFrom = parseCatalogInstant(p.effectiveFrom),
                  effectiveUntil =
                    p.effectiveUntil === null ? null : parseCatalogInstant(p.effectiveUntil),
                  periodCreatedAt = past(p.createdAt);
                if (
                  p.precise !== true ||
                  periodsSeen.has(timingReference) ||
                  typeof p.timeZone !== "string" ||
                  p.timeZone.length < 1 ||
                  p.timeZone.length > 63 ||
                  (effectiveUntil !== null && effectiveUntil <= effectiveFrom) ||
                  periodCreatedAt < releasedAt
                )
                  return fail();
                const zone = new Intl.DateTimeFormat("en-CA", {
                  timeZone: p.timeZone,
                }).resolvedOptions().timeZone;
                if (zone.startsWith("+") || zone.startsWith("-")) return fail();
                periodsSeen.add(timingReference);
                return Object.freeze({
                  timingReference,
                  timeZone: p.timeZone,
                  effectiveFrom,
                  effectiveUntil,
                  periodDigest: parsePublishingDigest(p.periodDigest),
                  createdAt: periodCreatedAt,
                  temporalStatus:
                    effectiveFrom > observedAt
                      ? ("Future" as const)
                      : effectiveUntil !== null && effectiveUntil <= observedAt
                        ? ("Expired" as const)
                        : ("Effective" as const),
                });
              })
              .sort((a, b) => a.timingReference.localeCompare(b.timingReference));
            return Object.freeze({
              releaseReference,
              releaseSequence,
              releaseKind: rel.releaseKind as "Publish" | "Rollback",
              lifecycleVersion,
              createdAt: releasedAt,
              periods: Object.freeze(periods),
            });
          })
          .sort((a, b) => a.releaseSequence - b.releaseSequence);
        const placements = allPlacements
          .filter((p) => skuReferences.includes(p.skuReference))
          .sort((a, b) => a.placementReference.localeCompare(b.placementReference));
        return Object.freeze({
          reviewReference,
          brandReference,
          menuReference,
          menuVersionReference,
          snapshotDigest,
          createdAt,
          lifecycle,
          placements: Object.freeze(placements),
          releases: Object.freeze(releases),
        });
      })
      .filter((r) => r.placements.length > 0)
      .sort((a, b) => a.reviewReference.localeCompare(b.reviewReference));
    const source = {
      request,
      skuReferences: Object.freeze(skuReferences),
      productVersionReferences: Object.freeze(productVersionReferences),
      reviews: Object.freeze(reviews),
    };
    return Object.freeze({
      ...source,
      coverage: "Complete",
      consistency: "StatementSnapshot",
      observedAt,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(source)),
    });
  } catch {
    return fail();
  }
}
