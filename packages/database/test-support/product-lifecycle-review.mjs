import { productLifecycleReviewAreas } from "../../rms/catalog/src/index.ts";
// Synthetic source/policy fixture only. Zero counts are not real dependency absence.
export function syntheticLifecycleReview(request) {
  const id = (n) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
    checkedAt = "2026-07-01T00:00:00.000Z",
    validUntil = "2027-01-01T00:00:00.000Z";
  return {
    reviewReference: id(900),
    request,
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
      activeReferenceCount: area === "ActiveSkus" ? request.activeSkuCount : 0,
      checkedAt,
      validUntil,
    })),
  };
}
