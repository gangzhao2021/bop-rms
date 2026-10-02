import { expect, it, vi } from "vitest";
import {
  matchOptionDraftInventoryConsumptionMetadata as assess,
  buildInventoryConfigurationReferenceSnapshot as build,
} from "../contracts/configuration-reference-source.js";
const id = (n: number) => "01902458-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-01T04:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
const request = {
  purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ" as const,
  tenantReference: id(4),
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(3),
  catalogIntentDigest: digest,
};
function raw() {
  const scope = { tenantReference: id(4), brandReference: id(1) };
  return {
    generation: "2",
    observedAt: at,
    counts: { items: "1", versions: "2", operations: "2" },
    items: [
      { ...scope, itemReference: id(10), itemType: "FinishedGood", createdAt: at, precise: true },
    ],
    versions: [1, 2].map((v) => ({
      ...scope,
      itemReference: id(10),
      itemVersion: String(v),
      itemType: "FinishedGood",
      lifecycle: v === 2 ? "Active" : "Inactive",
      recordedAt: at,
      precise: true,
    })),
    operations: [1, 2].map((v) => ({
      ...scope,
      itemReference: id(10),
      itemVersion: String(v),
      operationReference: id(30 + v),
      action: v === 1 ? "Create" : "Activate",
    })),
  };
}
const pins = () => ({
  profile: "CurrentFullOptionDraftConsumptionPinsV1",
  brandReference: id(1),
  optionSetReference: id(100),
  versionReference: id(101),
  sourceDigest: digest,
  contentDigest: digest,
  configurationDigest: digest,
  pins: [{ optionReference: id(110), reference: id(10), versionReference: id(32) }],
});
function run(
  input: unknown = pins(),
  r = raw(),
  now = at,
  activation = "2026-10-01T04:00:02.000Z",
) {
  return assess(input, build(r, request, at), request, now, activation);
}
it("matches exact current owning operation metadata without qualification", () => {
  const p = run();
  expect(p.decision).toBe("PassForMetadata");
  expect(p.quantityEligibility).toBe("NotEvaluated");
  expect(p.referenceEligibility).toBe("NotEvaluated");
  expect(p.bindingApplicability).toBe("NotEvaluated");
  expect(Object.isFrozen(p)).toBe(true);
  expect(Object.isFrozen(p.matches)).toBe(true);
});
it.each([
  ["reference", id(999), "MissingItem"],
  ["versionReference", id(999), "MissingVersion"],
  ["versionReference", id(31), "StaleVersion"],
])("refuses metadata pin %s", (key, v, status) => {
  const p = pins();
  Object.assign(p.pins[0] ?? {}, { [key]: v });
  const a = run(p);
  expect(a.decision).toBe("HardError");
  expect(a.matches[0]?.status).toBe(status);
});
it("refuses stored noncurrent lifecycle", () => {
  const r = raw();
  const v = r.versions[1];
  if (!v) throw Error("fixture");
  v.lifecycle = "Inactive";
  expect(run(pins(), r).matches[0]?.status).toBe("InactiveItem");
});
it("checks empty pins but retains source identity and obligations", () => {
  const p = pins();
  p.pins = [];
  const r = run(p);
  expect(r.decision).toBe("PassForMetadata");
  expect(r.ownerSourceDigest).toMatch(/^sha256:/);
  expect(r.eligibility).toBe("NotEvaluated");
});
it.each(["scope", "duplicate", "overflow", "field", "getter", "activation", "expiry"])(
  "refuses %s",
  (mode) => {
    const p = pins();
    if (mode === "scope") p.brandReference = id(999);
    if (mode === "duplicate")
      p.pins.push({
        ...(p.pins[0] ?? { optionReference: id(110), reference: id(10), versionReference: id(32) }),
      });
    if (mode === "overflow")
      p.pins = Array.from({ length: 101 }, (_, i) => ({
        optionReference: id(1000 + i),
        reference: id(10),
        versionReference: id(32),
      }));
    if (mode === "field") Object.assign(p, { Ready: true });
    const getter = vi.fn(() => id(10));
    if (mode === "getter")
      Object.defineProperty(p.pins[0], "reference", { get: getter, enumerable: true });
    expect(() =>
      run(
        p,
        raw(),
        mode === "expiry" ? "2026-10-01T04:00:05.001Z" : at,
        mode === "activation" ? "2026-10-01T03:59:59.999Z" : "2026-10-01T04:00:10.000Z",
      ),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
  },
);
it("refuses an existing operation owned by a different existing item", () => {
  const r = raw(),
    scope = { tenantReference: id(4), brandReference: id(1) };
  r.counts = { items: "2", versions: "3", operations: "3" };
  r.items.push({
    ...scope,
    itemReference: id(20),
    itemType: "FinishedGood",
    createdAt: at,
    precise: true,
  });
  r.versions.push({
    ...scope,
    itemReference: id(20),
    itemVersion: "1",
    itemType: "FinishedGood",
    lifecycle: "Active",
    recordedAt: at,
    precise: true,
  });
  r.operations.push({
    ...scope,
    itemReference: id(20),
    itemVersion: "1",
    operationReference: id(33),
    action: "Create",
  });
  const p = pins();
  const pin = p.pins[0];
  if (!pin) throw Error("fixture");
  pin.versionReference = id(33);
  expect(run(p, r).matches[0]?.status).toBe("WrongItem");
});
