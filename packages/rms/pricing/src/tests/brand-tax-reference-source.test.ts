import { expect, it } from "vitest";
import {
  buildBrandTaxReferenceSnapshot as build,
  parseBrandTaxReferenceSnapshot as parse,
} from "../contracts/brand-tax-reference-source.js";
import { buildTaxConfigurationReferenceSourceSnapshot as tax } from "../contracts/tax-configuration-reference-source.js";
const id = (n: number) => `01902411-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T00:00:00.000Z";
const request = {
  purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ" as const,
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(3),
  catalogIntentDigest: "sha256:" + "a".repeat(64),
};
function fixture() {
  return {
    storeInventory: {
      profile: "TenantStoreReferenceV1",
      brandReference: id(1),
      brandLifecycle: "Active",
      brandVersion: "1",
      generation: "2",
      referenceCount: "2",
      originalIntentDigest: request.catalogIntentDigest,
      observedAt: at,
      references: [
        {
          storeReference: id(11),
          lifecycle: "Archived",
          version: "2",
          createdAt: at,
          updatedAt: at,
        },
        { storeReference: id(12), lifecycle: "Draft", version: "1", createdAt: at, updatedAt: at },
      ],
    },
    generation: "2",
    referenceCount: "1",
    rootScope: [
      {
        configurationReference: id(20),
        storeReference: id(11),
        present: false,
        aggregateVersion: "1",
        currentVersionReference: null,
      },
    ],
    stores: [11, 12].map((n) =>
      tax({ observedAt: at, references: [] }, { ...request, storeReference: id(n) }, at),
    ),
  };
}
it("proves complete empty/removed scopes without dropping inactive Stores", () => {
  const result = build(fixture(), request, at);
  expect(result.stores).toHaveLength(2);
  expect(result.rootScope[0]?.present).toBe(false);
  expect(parse(result, request, at)).toEqual(result);
  expect(result.scopeCoverage).toBe("AllRegisteredStores");
});
it("rejects orphan roots, incomplete Store permission coverage and root count gaps", () => {
  const f = fixture();
  expect(() =>
    build({ ...f, rootScope: [{ ...f.rootScope[0], storeReference: id(99) }] }, request, at),
  ).toThrow();
  expect(() => build({ ...f, stores: [f.stores[0]] }, request, at)).toThrow();
  expect(() => build({ ...f, referenceCount: "2" }, request, at)).toThrow();
  expect(() =>
    build({ ...f, rootScope: [{ ...f.rootScope[0], present: true }] }, request, at),
  ).toThrow();
});
it("binds exact original Actor/operation/Brand intent and rejects self-rehashed alteration", () => {
  const result = build(fixture(), request, at);
  for (const changed of [
    { ...request, actorReference: id(4) },
    { ...request, operationReference: id(4) },
    { ...request, brandReference: id(4) },
    { ...request, catalogIntentDigest: "sha256:" + "b".repeat(64) },
  ])
    expect(() => parse(result, changed, at)).toThrow();
  expect(() => parse({ ...result, generation: "3" }, request, at)).toThrow();
});
it("rejects getters/sparse/oversized/duplicate scopes and malformed generation", () => {
  const f = fixture();
  let calls = 0;
  Object.defineProperty(f.rootScope[0], "present", {
    enumerable: true,
    get() {
      calls++;
      return false;
    },
  });
  expect(() => build(f, request, at)).toThrow();
  expect(calls).toBe(0);
  const valid = fixture();
  expect(() => build({ ...valid, rootScope: new Array(10001) }, request, at)).toThrow();
  expect(() =>
    build(
      { ...valid, referenceCount: "2", rootScope: [valid.rootScope[0], valid.rootScope[0]] },
      request,
      at,
    ),
  ).toThrow();
  expect(() => build({ ...valid, generation: "01" }, request, at)).toThrow();
});
it("rejects stale/invalid clock and altered scope/profile metadata", () => {
  const f = fixture();
  expect(() => build(f, request, "2026-09-29T00:00:05.001Z")).toThrow();
  expect(() => build(f, request, "invalid")).toThrow();
  const result = build(f, request, at);
  expect(() => parse({ ...result, consistency: "StatementSnapshot" }, request, at)).toThrow();
});
