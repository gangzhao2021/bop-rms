import { expect, it, vi } from "vitest";
import {
  CatalogError,
  parseProductLifecycleReviewRequest,
  validateProductLifecycleReviewEvidence,
  productLifecycleReviewAreas,
} from "../index.js";
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-29T12:00:00.000Z";
const request = () =>
  parseProductLifecycleReviewRequest({
    purposeCode: "CATALOG_LIFECYCLE_REVIEW",
    brandReference: id(1),
    actorReference: id(2),
    productReference: id(3),
    skuReference: id(4),
    operationReference: id(5),
    expectedAggregateVersion: 7,
    originalProductVersionReference: id(6),
    beforeLifecycle: "Active",
    targetLifecycle: "Suspended",
    reasonCode: "SYNTHETIC_REVIEW",
    activeSkuCount: 1,
  });
export function syntheticReview(value = request()) {
  const checkedAt = "2026-07-01T00:00:00.000Z",
    validUntil = "2027-01-01T00:00:00.000Z";
  return {
    reviewReference: id(900),
    request: value,
    policyReference: id(901),
    policyVersion: 1,
    decision: "Allowed",
    checkedAt,
    validUntil,
    sources: productLifecycleReviewAreas.map((area, i) => ({
      area,
      coverage: "Complete",
      sourceReference: id(910 + i),
      sourceRevision: "1",
      sourceDigest: "a".repeat(64),
      activeReferenceCount: area === "ActiveSkus" ? value.activeSkuCount : 0,
      checkedAt,
      validUntil,
    })),
  };
}
it("validates all nine owner sources and freezes copies without producing facts", () => {
  const value = syntheticReview(),
    parsed = validateProductLifecycleReviewEvidence(value, request(), at);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.sources)).toBe(true);
  expect(parsed.sources).toHaveLength(9);
  const first = value.sources[0];
  if (!first) throw new Error("Missing synthetic source");
  first.activeReferenceCount = 100;
  expect(parsed.sources.find((s) => s.area === "ActiveSkus")?.activeReferenceCount).toBe(1);
});
it.each([
  "brandReference",
  "actorReference",
  "productReference",
  "skuReference",
  "operationReference",
  "originalProductVersionReference",
])("rejects cross-request %s", (key) => {
  const value = syntheticReview();
  const other = { ...value.request, [key]: id(100) };
  expect(() =>
    validateProductLifecycleReviewEvidence({ ...value, request: other }, request(), at),
  ).toThrow(CatalogError);
});
it.each([
  { expectedAggregateVersion: 8 },
  { reasonCode: "OTHER" },
  { activeSkuCount: 2 },
  { beforeLifecycle: "Suspended" },
  { targetLifecycle: "Discontinued" },
])("rejects stale or changed intent %s", (patch) => {
  const value = syntheticReview();
  expect(() =>
    validateProductLifecycleReviewEvidence(
      { ...value, request: { ...value.request, ...patch } },
      request(),
      at,
    ),
  ).toThrow(CatalogError);
});
it.each(["Blocked", "ApprovalRequired", "WarningAcknowledgementRequired"])(
  "does not override %s",
  (decision) => {
    expect(() =>
      validateProductLifecycleReviewEvidence({ ...syntheticReview(), decision }, request(), at),
    ).toThrowError(expect.objectContaining({ code: "CATALOG_LIFECYCLE_CONFLICT" }));
  },
);
it.each([
  "Missing",
  "Duplicate",
  "Partial",
  "Expired",
  "Future",
  "WrongCount",
  "BadDigest",
  "Unknown",
])("rejects %s source evidence", (mode) => {
  const v = syntheticReview();
  const first = v.sources[0];
  if (!first) throw new Error("Missing synthetic source");
  if (mode === "Missing") v.sources.pop();
  if (mode === "Duplicate") v.sources[1] = { ...first };
  if (mode === "Partial") Object.assign(first, { coverage: "Partial" });
  if (mode === "Expired") first.validUntil = at;
  if (mode === "Future") first.checkedAt = "2026-09-30T00:00:00.000Z";
  if (mode === "WrongCount") first.activeReferenceCount = 0;
  if (mode === "BadDigest") first.sourceDigest = "secret-private";
  if (mode === "Unknown") Object.assign(first, { approval: true });
  expect(() => validateProductLifecycleReviewEvidence(v, request(), at)).toThrowError(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );
});
it("rejects accessors in array evidence without invoking them", () => {
  const v = syntheticReview(),
    getter = vi.fn(() => v.sources[1]);
  Object.defineProperty(v.sources, "0", { get: getter, enumerable: true });
  expect(() => validateProductLifecycleReviewEvidence(v, request(), at)).toThrow(CatalogError);
  expect(getter).not.toHaveBeenCalled();
});
it.each([
  { validUntil: at },
  { checkedAt: "2026-09-30T00:00:00.000Z" },
  { policyVersion: 0 },
  { reviewReference: "bad" },
  { decision: "Approved" },
  { approval: true },
])("rejects invalid review policy/time %s", (patch) => {
  expect(() =>
    validateProductLifecycleReviewEvidence({ ...syntheticReview(), ...patch }, request(), at),
  ).toThrow(CatalogError);
});
