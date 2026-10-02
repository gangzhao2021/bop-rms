import { parseCatalogReference } from "@rms/catalog";
import { expect, it, vi } from "vitest";
import { createCurrentProductContentPolicySource } from "./current-product-content-policy.js";
const at = "2026-09-30T06:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const input = () => ({
  aggregate: {},
  binding: {
    tenantReference: id(1),
    productReference: id(5),
    versionReference: id(6),
    expectedAggregateVersion: 1,
    contentDigest: digest,
    configurationDigest: digest,
    originalIntentDigest: digest,
    observedAt: at,
    validUntil: "2026-09-30T06:00:20.000Z",
  },
  brandRequest: {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    purposeCode: "CATALOG_PRODUCT_CONTENT" as const,
    configurationVersionReference: id(4),
    expectedBrandVersion: 1,
    originalIntentDigest: digest,
    observedAt: at,
    validUntil: "2026-09-30T06:00:20.000Z",
  },
  policyRequest: { policyReference: id(7), policyVersion: 1, observedAt: at },
});
const tx = { query: vi.fn() };
function fixture() {
  const brandSource = {
    withCurrentContent: vi.fn(async () => {
      throw new Error("synthetic owner unavailable");
    }),
  };
  const policySource = {
    withCurrentPolicy: vi.fn(async () => {
      throw new Error("synthetic owner unavailable");
    }),
    withHeldScopePolicy: vi.fn(),
    context: Object.freeze({
      tenantReference: parseCatalogReference(id(1)),
      brandReference: parseCatalogReference(id(2)),
      actorReference: parseCatalogReference(id(3)),
      actorKind: "User" as const,
    }),
  };
  const source = createCurrentProductContentPolicySource({
    brandSource,
    policySource,
    clock: { now: () => at },
  });
  return { brandSource, policySource, source };
}
it("does not evaluate or replace missing owning current sources with default policy", async () => {
  const f = fixture(),
    work = vi.fn();
  await expect(f.source.withCurrentAssessment(tx, input(), work)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.brandSource.withCurrentContent).toHaveBeenCalledOnce();
  expect(f.policySource.withCurrentPolicy).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});
it.each(["aggregate", "binding", "brandRequest", "policyRequest"])(
  "never invokes an outer %s getter",
  async (key) => {
    const f = fixture(),
      getter = vi.fn();
    const value = Object.defineProperty(input(), key, { get: getter });
    await expect(f.source.withCurrentAssessment(tx, value, vi.fn())).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(f.brandSource.withCurrentContent).not.toHaveBeenCalled();
  },
);
it("rejects a binding accessor before source acquisition", async () => {
  const f = fixture(),
    value = input(),
    getter = vi.fn();
  Object.defineProperty(value.binding, "validUntil", { get: getter });
  await expect(f.source.withCurrentAssessment(tx, value, vi.fn())).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(f.brandSource.withCurrentContent).not.toHaveBeenCalled();
});

it.each(["tenantReference", "brandReference", "actorReference"] as const)(
  "binds both sources to one current %s",
  async (key) => {
    const f = fixture(),
      value = input();
    value.brandRequest[key] = id(99);
    await expect(f.source.withCurrentAssessment(tx, value, vi.fn())).rejects.toThrow();
    expect(f.brandSource.withCurrentContent).not.toHaveBeenCalled();
  },
);
