import { canonicalizeRfc8785 } from "@bop/audit";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogHash,
  parseCatalogLifecycleReasonCode,
  parseProductAggregate,
  parseProductLifecycle,
  transitionCatalogLifecycle,
  type ProductLifecycle,
} from "./product.js";
export const productLifecycleReviewAreas = Object.freeze([
  "ActiveSkus",
  "PublishedMenus",
  "Bundles",
  "Pricing",
  "Recipes",
  "Inventory",
  "Availability",
  "FutureVersions",
  "WorkflowTasks",
] as const);
export type ProductLifecycleReviewArea = (typeof productLifecycleReviewAreas)[number];
export interface ProductLifecycleReviewRequest {
  readonly purposeCode: "CATALOG_LIFECYCLE_REVIEW";
  readonly brandReference: string;
  readonly actorReference: string;
  readonly productReference: string;
  readonly skuReference: string | null;
  readonly operationReference: string;
  readonly expectedAggregateVersion: number;
  readonly originalProductVersionReference: string;
  readonly beforeLifecycle: ProductLifecycle;
  readonly targetLifecycle: ProductLifecycle;
  readonly reasonCode: string;
  readonly activeSkuCount: number;
}
export interface ProductLifecycleReviewEvidence {
  readonly reviewReference: string;
  readonly request: ProductLifecycleReviewRequest;
  readonly policyReference: string;
  readonly policyVersion: number;
  readonly decision: "Allowed" | "Blocked" | "ApprovalRequired" | "WarningAcknowledgementRequired";
  readonly checkedAt: string;
  readonly validUntil: string;
  readonly sources: readonly {
    readonly area: ProductLifecycleReviewArea;
    readonly coverage: "Complete";
    readonly sourceReference: string;
    readonly sourceRevision: string;
    readonly sourceDigest: string;
    readonly activeReferenceCount: number;
    readonly checkedAt: string;
    readonly validUntil: string;
  }[];
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
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value),
    result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = descriptors[key];
    if (!d || !("value" in d) || !d.enumerable) return fail();
    result[key] = d.value;
  }
  return result;
}
function integer(value: unknown, minimum = 0) {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) >= 2147483647
  )
    return fail();
  return value as number;
}
export function requiresProductLifecycleReview(target: unknown) {
  return ["Suspended", "Discontinued", "Archived", "Draft"].includes(parseProductLifecycle(target));
}
export function parseProductLifecycleReviewRequest(value: unknown): ProductLifecycleReviewRequest {
  try {
    const r = exact(value, [
      "purposeCode",
      "brandReference",
      "actorReference",
      "productReference",
      "skuReference",
      "operationReference",
      "expectedAggregateVersion",
      "originalProductVersionReference",
      "beforeLifecycle",
      "targetLifecycle",
      "reasonCode",
      "activeSkuCount",
    ]);
    if (
      r.purposeCode !== "CATALOG_LIFECYCLE_REVIEW" ||
      !requiresProductLifecycleReview(r.targetLifecycle)
    )
      return fail();
    const beforeLifecycle = parseProductLifecycle(r.beforeLifecycle),
      targetLifecycle = parseProductLifecycle(r.targetLifecycle);
    transitionCatalogLifecycle(beforeLifecycle, targetLifecycle);
    return Object.freeze({
      purposeCode: "CATALOG_LIFECYCLE_REVIEW",
      brandReference: parseCatalogReference(r.brandReference),
      actorReference: parseCatalogReference(r.actorReference),
      productReference: parseCatalogReference(r.productReference),
      skuReference: r.skuReference === null ? null : parseCatalogReference(r.skuReference),
      operationReference: parseCatalogReference(r.operationReference),
      expectedAggregateVersion: integer(r.expectedAggregateVersion, 1),
      originalProductVersionReference: parseCatalogReference(r.originalProductVersionReference),
      beforeLifecycle,
      targetLifecycle,
      reasonCode: parseCatalogLifecycleReasonCode(r.reasonCode),
      activeSkuCount: integer(r.activeSkuCount),
    });
  } catch {
    return fail();
  }
}
/** The original owner aggregate version is authoritative, never caller before-state. */
export function createProductLifecycleReviewRequest(input: {
  readonly aggregate: unknown;
  readonly actorReference: string;
  readonly skuReference: string | null;
  readonly operationReference: string;
  readonly targetLifecycle: ProductLifecycle;
  readonly reasonCode: string;
}): ProductLifecycleReviewRequest {
  const aggregate = parseProductAggregate(input.aggregate),
    beforeLifecycle =
      input.skuReference === null
        ? aggregate.lifecycle
        : aggregate.draft.skus.find((s) => s.skuReference === input.skuReference)?.lifecycle;
  if (beforeLifecycle === undefined) return fail();
  return parseProductLifecycleReviewRequest({
    purposeCode: "CATALOG_LIFECYCLE_REVIEW",
    brandReference: aggregate.brandReference,
    actorReference: input.actorReference,
    productReference: aggregate.productReference,
    skuReference: input.skuReference,
    operationReference: input.operationReference,
    expectedAggregateVersion: aggregate.aggregateVersion,
    originalProductVersionReference: aggregate.draft.versionReference,
    beforeLifecycle,
    targetLifecycle: input.targetLifecycle,
    reasonCode: input.reasonCode,
    activeSkuCount: aggregate.draft.skus.filter((s) => s.lifecycle === "Active").length,
  });
}
/** This validates supplied owner evidence; it does not produce source facts or approval. */
export function validateProductLifecycleReviewEvidence(
  value: unknown,
  expected: ProductLifecycleReviewRequest,
  observedAt: string,
): ProductLifecycleReviewEvidence {
  try {
    const at = Date.parse(parseCatalogInstant(observedAt)),
      r = exact(value, [
        "reviewReference",
        "request",
        "policyReference",
        "policyVersion",
        "decision",
        "checkedAt",
        "validUntil",
        "sources",
      ]),
      request = parseProductLifecycleReviewRequest(r.request);
    if (
      canonicalizeRfc8785(request) !==
      canonicalizeRfc8785(parseProductLifecycleReviewRequest(expected))
    )
      return fail();
    if (
      !["Allowed", "Blocked", "ApprovalRequired", "WarningAcknowledgementRequired"].includes(
        r.decision as string,
      )
    )
      return fail();
    const time = (start: unknown, end: unknown) => {
      const checkedAt = parseCatalogInstant(start),
        validUntil = parseCatalogInstant(end);
      if (
        Date.parse(checkedAt) > at ||
        Date.parse(validUntil) <= at ||
        Date.parse(validUntil) <= Date.parse(checkedAt)
      )
        return fail();
      return { checkedAt, validUntil };
    };
    if (
      !Array.isArray(r.sources) ||
      Object.getPrototypeOf(r.sources) !== Array.prototype ||
      r.sources.length !== productLifecycleReviewAreas.length ||
      Reflect.ownKeys(r.sources).length !== r.sources.length + 1
    )
      return fail();
    const sources = Array.from({ length: productLifecycleReviewAreas.length }, (_, index) => {
      const d = Object.getOwnPropertyDescriptor(r.sources, String(index));
      if (!d || !("value" in d) || !d.enumerable) return fail();
      const s = exact(d.value, [
        "area",
        "coverage",
        "sourceReference",
        "sourceRevision",
        "sourceDigest",
        "activeReferenceCount",
        "checkedAt",
        "validUntil",
      ]);
      if (
        !productLifecycleReviewAreas.includes(s.area as ProductLifecycleReviewArea) ||
        s.coverage !== "Complete" ||
        typeof s.sourceRevision !== "string" ||
        !/^(0|[1-9][0-9]{0,18})$/u.test(s.sourceRevision) ||
        s.sourceRevision.trim() !== s.sourceRevision
      )
        return fail();
      const activeReferenceCount = integer(s.activeReferenceCount);
      if (s.area === "ActiveSkus" && activeReferenceCount !== request.activeSkuCount) return fail();
      return Object.freeze({
        area: s.area as ProductLifecycleReviewArea,
        coverage: "Complete" as const,
        sourceReference: parseCatalogReference(s.sourceReference),
        sourceRevision: s.sourceRevision,
        sourceDigest: parseCatalogHash(s.sourceDigest),
        activeReferenceCount,
        ...time(s.checkedAt, s.validUntil),
      });
    });
    if (new Set(sources.map((s) => s.area)).size !== productLifecycleReviewAreas.length)
      return fail();
    const evidence = Object.freeze({
      reviewReference: parseCatalogReference(r.reviewReference),
      request,
      policyReference: parseCatalogReference(r.policyReference),
      policyVersion: integer(r.policyVersion, 1),
      decision: r.decision as ProductLifecycleReviewEvidence["decision"],
      ...time(r.checkedAt, r.validUntil),
      sources: Object.freeze(sources.sort((a, b) => a.area.localeCompare(b.area))),
    });
    if (evidence.decision !== "Allowed") throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
    return evidence;
  } catch (error) {
    if (error instanceof CatalogError && error.code === "CATALOG_LIFECYCLE_CONFLICT") throw error;
    return fail();
  }
}
