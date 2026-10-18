import { expect, it, vi } from "vitest";
import {
  productLifecycleReviewAreas,
  parseProductLifecycleReviewRequest,
  type ProductLifecycleReviewEvidence,
} from "@rms/catalog";
import {
  createMerchantProductLifecycleReviewLease,
  type MerchantProductLifecycleReview,
} from "./merchant-product-lifecycle-review.js";
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-29T12:00:00.000Z";
type Options = Parameters<typeof createMerchantProductLifecycleReviewLease>[0];
function setup(mode: "Apply" | "Replay" = "Apply") {
  const tx = { query: vi.fn() },
    checks: (() => Promise<void>)[] = [],
    request = parseProductLifecycleReviewRequest({
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
      reasonCode: "SYNTHETIC",
      activeSkuCount: 1,
    });
  const evidence: ProductLifecycleReviewEvidence = {
    reviewReference: id(900),
    request,
    policyReference: id(901),
    policyVersion: 1,
    decision: "Allowed",
    checkedAt: "2026-07-01T00:00:00.000Z",
    validUntil: "2027-01-01T00:00:00.000Z",
    sources: productLifecycleReviewAreas.map((area, i) => ({
      area,
      coverage: "Complete",
      sourceReference: id(910 + i),
      sourceRevision: "1",
      sourceDigest: "a".repeat(64),
      activeReferenceCount: area === "ActiveSkus" ? 1 : 0,
      checkedAt: "2026-07-01T00:00:00.000Z",
      validUntil: "2027-01-01T00:00:00.000Z",
    })),
  };
  const review = vi.fn<MerchantProductLifecycleReview>(async () => evidence);
  const options: Options = {
    transaction: tx,
    scope: {
      tenantReference: id(20),
      selectedStoreReference: id(21),
      actorReference: id(2),
      context: { brand: { brandReference: id(1) } },
    } as unknown as Options["scope"],
    sessionReference: id(22),
    request,
    mode,
    actionPermission: "catalog.sku.suspend",
    review,
    now: () => at,
    registerBeforeCommit: async (actual, check) => {
      expect(actual).toBe(tx);
      checks.push(check);
    },
  };
  return {
    options,
    lease: createMerchantProductLifecycleReviewLease(options),
    review,
    evidence,
    request,
    checks,
  };
}
async function commit(f: ReturnType<typeof setup>) {
  const check = f.checks[0];
  if (!check) throw new Error("Missing synthetic lease");
  await check();
}
it.each(["Apply", "Replay"] as const)(
  "holds exact %s actor/request/sources through COMMIT",
  async (mode) => {
    const f = setup(mode);
    await f.lease.holdAndRegister();
    const mutate = vi.fn(async () => "synthetic-result");
    expect(await f.lease.withCurrentReview(f.request, mutate)).toBe("synthetic-result");
    await commit(f);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(f.review).toHaveBeenCalledTimes(3);
    for (const [tx, input] of f.review.mock.calls) {
      expect(tx).toBe(f.options.transaction);
      expect(input.mode).toBe(mode);
      expect(input.tenantReference).toBe(id(20));
      expect(input.storeReference).toBe(id(21));
      expect(input.sessionReference).toBe(id(22));
      expect(input.request).toEqual(f.request);
      expect(Object.isFrozen(input)).toBe(true);
    }
  },
);
it("missing provider and wrong fine action fail closed", () => {
  const f = setup();
  for (const patch of [{ review: undefined }, { actionPermission: "catalog.product.manage" }])
    expect(() => createMerchantProductLifecycleReviewLease({ ...f.options, ...patch })).toThrow();
});
it("unregistered or different request cannot mutate", async () => {
  const f = setup(),
    mutate = vi.fn(async () => null);
  await expect(f.lease.withCurrentReview(f.request, mutate)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  await f.lease.holdAndRegister();
  await expect(
    f.lease.withCurrentReview({ ...f.request, reasonCode: "OTHER" }, mutate),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(mutate).not.toHaveBeenCalled();
});
it.each(["PolicyChanged", "ReviewChanged", "SourceChanged", "Expired", "Blocked", "Missing"])(
  "rejects %s at final COMMIT",
  async (mode) => {
    const f = setup();
    await f.lease.holdAndRegister();
    const next = { ...f.evidence };
    if (mode === "PolicyChanged") next.policyVersion = 2;
    if (mode === "ReviewChanged") next.reviewReference = id(950);
    if (mode === "SourceChanged")
      next.sources = f.evidence.sources.map((s) => ({ ...s, sourceRevision: "2" }));
    if (mode === "Expired") next.validUntil = at;
    if (mode === "Blocked") next.decision = "Blocked";
    if (mode === "Missing") next.sources = [];
    f.review.mockResolvedValue(next);
    await expect(commit(f)).rejects.toThrow();
    f.review.mockResolvedValue(f.evidence);
    await expect(f.lease.hold()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
