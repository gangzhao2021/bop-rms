import { expect, it, vi } from "vitest";
import {
  CatalogError,
  parseCatalogReference,
  type createPostgresProductPublicationSourceStore,
} from "@rms/catalog";
import { createCurrentProductApprovalDecisionSource } from "./current-product-approval-decision.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T08:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
const request = () => ({
  purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
  tenantReference: id(1),
  brandReference: id(2),
  actorReference: id(3),
  actorKind: "User",
  operationReference: id(21),
  productReference: id(5),
  versionReference: id(6),
  expectedProductAggregateVersion: 3,
  expectedPublicationVersion: 2,
  action: "Approve",
  contentDigest: digest,
  configurationDigest: digest,
  scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
  effectivePeriod: {
    timeZone: "UTC",
    effectiveFrom: { instant: at, localDateTime: "2026-09-30T08:00:00.000", utcOffsetMinutes: 0 },
    effectiveUntil: null,
  },
  scheduleReference: null,
  replacementVersionReference: null,
  successorDraftVersionReference: null,
  occurredAt: at,
  reasonCode: "SYNTHETIC_DECISION",
});
const tx = { query: vi.fn() };
function fixture() {
  const context = {
    tenantReference: parseCatalogReference(id(1)),
    brandReference: parseCatalogReference(id(2)),
    actorReference: parseCatalogReference(id(3)),
    actorKind: "User" as const,
  };
  const reviewSource: Pick<
    ReturnType<typeof createPostgresProductPublicationSourceStore>,
    "context" | "withCurrentReview"
  > = {
    context,
    withCurrentReview: vi.fn(async () => {
      throw new Error("synthetic owning approval missing");
    }),
  };
  const policySource = {
    context: { ...context },
    withCurrentPolicy: vi.fn(async () => {
      throw new Error("synthetic current policy missing");
    }),
    withHeldScopePolicy: vi.fn(),
  };
  const source = createCurrentProductApprovalDecisionSource({
    reviewSource,
    policySource,
    clock: { now: () => at },
    maximumApprovalValiditySeconds: 12,
  });
  return { reviewSource, policySource, source };
}
it("does not substitute a DTO or missing owning decision", async () => {
  const f = fixture(),
    work = vi.fn();
  await expect(f.source.withCurrentDecision(tx, request(), work)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.policySource.withCurrentPolicy).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});
it.each(["tenantReference", "brandReference", "actorReference", "actorKind"] as const)(
  "refuses different current source %s before acquisition",
  async (key) => {
    const f = fixture();
    Object.assign(f.policySource.context, {
      [key]: key === "actorKind" ? "System" : parseCatalogReference(id(99)),
    });
    await expect(f.source.withCurrentDecision(tx, request(), vi.fn())).rejects.toThrow();
    expect(f.reviewSource.withCurrentReview).not.toHaveBeenCalled();
  },
);
it("rejects request getters and unknown fields before any source", async () => {
  const f = fixture(),
    getter = vi.fn(),
    value = request();
  Object.defineProperty(value, "occurredAt", { get: getter });
  await expect(f.source.withCurrentDecision(tx, value, vi.fn())).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  await expect(
    f.source.withCurrentDecision(tx, { ...request(), approval: {} }, vi.fn()),
  ).rejects.toThrow();
  expect(f.reviewSource.withCurrentReview).not.toHaveBeenCalled();
});
it("retains current permission denial without exposing arbitrary owner errors", async () => {
  const f = fixture();
  vi.mocked(f.reviewSource.withCurrentReview).mockRejectedValueOnce(
    new CatalogError("CATALOG_PERMISSION_DENIED"),
  );
  await expect(f.source.withCurrentDecision(tx, request(), vi.fn())).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
});

it("requires operational duration at construction without a default", () => {
  const f = fixture();
  expect(() =>
    createCurrentProductApprovalDecisionSource({
      reviewSource: f.reviewSource,
      policySource: f.policySource,
      clock: { now: () => at },
      maximumApprovalValiditySeconds: 0,
    }),
  ).toThrow();
});
