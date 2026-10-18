import { describe, expect, it } from "vitest";
import {
  parseBrandStoreTopologyDraft,
  validateBrandStoreTopologyDraftStores,
} from "../contracts/brand-store-topology.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z";
function draft() {
  return {
    profile: "BrandStoreTopologyDraftV1",
    tenantReference: id(1),
    brandReference: id(2),
    draftReference: id(3),
    selectors: [
      { kind: "StoreGroup", reference: id(6), code: "NORTH", name: "North stores" },
      { kind: "Region", reference: id(5), code: "NORTH", name: "North region" },
      { kind: "Region", reference: id(7), code: "SECOND", name: "Second region" },
    ],
    assignments: [
      { storeReference: id(9), selectorReference: id(7) },
      { storeReference: id(9), selectorReference: id(5) },
      { storeReference: id(9), selectorReference: id(6) },
    ],
  };
}
function roster() {
  return {
    profile: "TenantStoreReferenceV1",
    brandReference: id(2),
    brandLifecycle: "Active",
    brandVersion: "1",
    generation: "1",
    referenceCount: "1",
    originalIntentDigest: `sha256:${"a".repeat(64)}`,
    observedAt: at,
    references: [
      { storeReference: id(9), lifecycle: "Draft", version: "1", createdAt: at, updatedAt: at },
    ],
  };
}
describe("Brand Store topology Draft intent", () => {
  it("detaches and canonically sorts explicit sets without imposing Region cardinality or current eligibility", () => {
    const input = draft(),
      parsed = validateBrandStoreTopologyDraftStores(input, roster());
    expect(Object.keys(parsed)).toHaveLength(6);
    expect(parsed.selectors.map((s) => s.reference)).toEqual([id(5), id(7), id(6)]);
    expect(parsed.assignments.map((a) => a.selectorReference)).toEqual([id(5), id(6), id(7)]);
    const firstSelector = input.selectors[0];
    if (!firstSelector) throw new Error("Missing controlled selector");
    firstSelector.name = "Changed";
    expect(parsed.selectors[2]?.name).toBe("North stores");
    expect(Object.isFrozen(parsed.assignments[0])).toBe(true);
    expect(Object.isFrozen(parsed.selectors)).toBe(true);
    expect(parseBrandStoreTopologyDraft(parsed)).toEqual(parsed);
  });
  it("permits an empty proposed Draft without asserting known-empty current membership", () => {
    const parsed = parseBrandStoreTopologyDraft({ ...draft(), selectors: [], assignments: [] });
    expect(parsed.assignments).toEqual([]);
    expect(parsed).not.toHaveProperty("qualification");
    expect(parsed).not.toHaveProperty("lifecycle");
  });
  it("requires exact Brand and actual registered Store identities without requiring Active operation", () => {
    expect(validateBrandStoreTopologyDraftStores(draft(), roster()).assignments).toHaveLength(3);
    expect(() =>
      validateBrandStoreTopologyDraftStores(draft(), { ...roster(), brandReference: id(50) }),
    ).toThrow();
    expect(() =>
      validateBrandStoreTopologyDraftStores(draft(), {
        ...roster(),
        references: [],
        referenceCount: "0",
      }),
    ).toThrow();
    expect(() =>
      validateBrandStoreTopologyDraftStores(
        { ...draft(), assignments: [{ storeReference: id(50), selectorReference: id(5) }] },
        roster(),
      ),
    ).toThrow();
  });
  it.each([
    { profile: "CurrentTopology" },
    { tenantReference: "bad" },
    { extra: true },
    { selectors: [{ ...draft().selectors[0], name: " Secret\n" }] },
    { selectors: [{ ...draft().selectors[0], code: "north" }] },
    { selectors: [{ ...draft().selectors[0], kind: "Country" }] },
    { selectors: [...draft().selectors, { ...draft().selectors[0], reference: id(50) }] },
    { selectors: [...draft().selectors, { ...draft().selectors[0], code: "NEW" }] },
    { assignments: [...draft().assignments, draft().assignments[0]] },
    { assignments: [{ storeReference: id(9), selectorReference: id(50) }] },
    { selectors: new Array(1) },
    { assignments: new Array(1) },
    { selectors: Array.from({ length: 1001 }, () => draft().selectors[0]) },
    { assignments: Array.from({ length: 10001 }, () => draft().assignments[0]) },
    { selectors: [{ ...draft().selectors[0], name: "x".repeat(121) }] },
    { selectors: [{ ...draft().selectors[0], name: { nested: { name: "deep" } } }] },
  ])("rejects malformed, duplicate, dangling or unbounded intent %j", (change) => {
    expect(() => parseBrandStoreTopologyDraft({ ...draft(), ...change })).toThrow(
      expect.objectContaining({ code: "ORGANIZATION_INPUT_INVALID" }),
    );
  });
  it("does not execute object or array accessors and rejects extra array members", () => {
    let touched = false;
    for (const target of ["selectors", "name", "array"]) {
      const input = draft();
      const firstSelector = input.selectors[0];
      if (!firstSelector) throw new Error("Missing controlled selector");
      const object =
        target === "selectors" ? input : target === "name" ? firstSelector : input.assignments;
      Object.defineProperty(object, target === "array" ? "0" : target, {
        enumerable: true,
        get() {
          touched = true;
          return "unsafe";
        },
      });
      expect(() => parseBrandStoreTopologyDraft(input)).toThrow();
    }
    expect(touched).toBe(false);
    const entries = Object.assign(draft().assignments, { unexpected: true });
    expect(() => parseBrandStoreTopologyDraft({ ...draft(), assignments: entries })).toThrow();
  });
});
