import { expect, it, vi } from "vitest";
import { CatalogError, parseCatalogReference } from "@rms/catalog";
import { createCurrentProductCandidateContentPolicySource } from "./current-product-candidate-content-policy.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T06:00:00.000Z";
const context = Object.freeze({
  tenantReference: parseCatalogReference(id(1)),
  brandReference: parseCatalogReference(id(2)),
  actorReference: parseCatalogReference(id(3)),
  actorKind: "User" as const,
});
function input() {
  return {
    command: {
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      ...context,
      operationReference: id(5),
      productReference: id(6),
      versionReference: id(7),
      expectedProductAggregateVersion: 1,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: "sha256:" + "a".repeat(64),
      configurationDigest: "sha256:" + "b".repeat(64),
      scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC_VALIDATE",
    },
    configurationVersionReference: id(8),
    expectedBrandVersion: 1,
    policyReference: id(9),
    policyVersion: 1,
  };
}
function fixture() {
  const candidateSource = {
      context,
      withCurrentCandidate: vi.fn(async () => {
        throw new Error("synthetic unavailable owner");
      }),
    },
    brandSource = {
      withCurrentContent: vi.fn(async () => {
        throw new Error("synthetic unavailable owner");
      }),
    },
    policySource = {
      context,
      withCurrentPolicy: vi.fn(async () => {
        throw new Error("synthetic unavailable owner");
      }),
      withHeldScopePolicy: vi.fn(),
    },
    source = createCurrentProductCandidateContentPolicySource({
      candidateSource,
      brandSource,
      policySource,
      clock: { now: () => at },
    });
  return { candidateSource, brandSource, policySource, source };
}
const tx = { query: vi.fn() };
it("refuses missing actual candidate without acquiring unrelated sources or calling work", async () => {
  const f = fixture(),
    work = vi.fn();
  await expect(f.source.withCurrentAssessment(tx, input(), work)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.candidateSource.withCurrentCandidate).toHaveBeenCalledOnce();
  expect(f.brandSource.withCurrentContent).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});
it.each([
  "command",
  "configurationVersionReference",
  "expectedBrandVersion",
  "policyReference",
  "policyVersion",
])("rejects %s getters before candidate acquisition", async (key) => {
  const f = fixture(),
    getter = vi.fn(),
    value = Object.defineProperty(input(), key, { get: getter });
  await expect(f.source.withCurrentAssessment(tx, value, vi.fn())).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(f.candidateSource.withCurrentCandidate).not.toHaveBeenCalled();
});
it.each(["tenantReference", "brandReference", "actorReference"] as const)(
  "requires one current owner %s",
  async (key) => {
    const f = fixture(),
      value = input();
    value.command[key] = parseCatalogReference(id(99));
    await expect(f.source.withCurrentAssessment(tx, value, vi.fn())).rejects.toThrow();
    expect(f.candidateSource.withCurrentCandidate).not.toHaveBeenCalled();
  },
);
it("never accepts a supplied aggregate as a candidate source", async () => {
  const f = fixture();
  await expect(
    f.source.withCurrentAssessment(tx, { ...input(), aggregate: {} }, vi.fn()),
  ).rejects.toThrow();
  expect(f.candidateSource.withCurrentCandidate).not.toHaveBeenCalled();
});
it("preserves current permission denial from the actual candidate owner", async () => {
  const f = fixture();
  f.candidateSource.withCurrentCandidate.mockRejectedValue(
    new CatalogError("CATALOG_PERMISSION_DENIED"),
  );
  await expect(f.source.withCurrentAssessment(tx, input(), vi.fn())).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
});
