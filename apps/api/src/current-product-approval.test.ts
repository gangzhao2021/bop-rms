import { expect, it, vi } from "vitest";
import {
  CatalogError,
  parseCatalogReference,
  type createPostgresProductPublicationSourceStore,
} from "@rms/catalog";
import { createCurrentProductApprovalSource } from "./current-product-approval.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T08:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
const request = () => ({
  productReference: id(5),
  versionReference: id(6),
  expectedAggregateVersion: 4,
  expectedPublicationVersion: 3,
  contentDigest: digest,
  configurationDigest: digest,
  scopeDigest: digest,
  periodDigest: digest,
  policyReference: id(19),
  policyVersion: 1,
  originalIntentDigest: digest,
  observedAt: at,
  validUntil: "2026-09-30T08:00:20.000Z",
});
const tx = { query: vi.fn() };
function fixture() {
  const context = {
    tenantReference: parseCatalogReference(id(1)),
    brandReference: parseCatalogReference(id(2)),
    actorReference: parseCatalogReference(id(3)),
    actorKind: "User" as const,
  };
  const approvalSource: Pick<
    ReturnType<typeof createPostgresProductPublicationSourceStore>,
    "context" | "withCurrentApproval"
  > = {
    context,
    withCurrentApproval: vi.fn(async () => {
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
  const source = createCurrentProductApprovalSource({
    approvalSource,
    policySource,
    clock: { now: () => at },
  });
  return { approvalSource, policySource, source };
}
it("does not substitute a DTO or missing owning decision", async () => {
  const f = fixture(),
    work = vi.fn();
  await expect(f.source.withCurrentApproval(tx, request(), work)).rejects.toMatchObject({
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
    await expect(f.source.withCurrentApproval(tx, request(), vi.fn())).rejects.toThrow();
    expect(f.approvalSource.withCurrentApproval).not.toHaveBeenCalled();
  },
);
it("rejects request getters and unknown fields before any source", async () => {
  const f = fixture(),
    getter = vi.fn(),
    value = request();
  Object.defineProperty(value, "validUntil", { get: getter });
  await expect(f.source.withCurrentApproval(tx, value, vi.fn())).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  await expect(
    f.source.withCurrentApproval(tx, { ...request(), approval: {} }, vi.fn()),
  ).rejects.toThrow();
  expect(f.approvalSource.withCurrentApproval).not.toHaveBeenCalled();
});
it("retains current permission denial without exposing arbitrary owner errors", async () => {
  const f = fixture();
  vi.mocked(f.approvalSource.withCurrentApproval).mockRejectedValueOnce(
    new CatalogError("CATALOG_PERMISSION_DENIED"),
  );
  await expect(f.source.withCurrentApproval(tx, request(), vi.fn())).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
});
