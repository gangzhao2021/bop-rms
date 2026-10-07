import { expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  buildCatalogProductPublicationBusinessRules as build,
  parseCatalogProductPublicationBusinessRules as parse,
  classifyCatalogProductPublicationBusinessRules as classify,
  type CatalogProductPublicationBusinessClassificationInput,
} from "../application/product-publication-business-classification.js";
const id = (n: number) => `019024b0-0042-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-03T12:00:00.000Z",
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function input(): CatalogProductPublicationBusinessClassificationInput {
  return {
    activeSkuReferences: [id(1)],
    presentReferences: { Pricing: [], Recipe: [], Inventory: [], Menu: [] },
    rules: build([id(1)]),
    observedAt: at,
    effectiveFrom: at,
    productReference: id(2),
    versionReference: id(3),
    configurationReference: id(4),
    ruleDigest: hash("rules"),
    referenceDigests: {
      Pricing: hash("pricing"),
      Recipe: hash("recipe"),
      Inventory: hash("inventory"),
      Menu: hash("menu"),
    },
  };
}
it("builds the selected seven-day rule and a warning requirement in all four domains", () => {
  const f = input(),
    result = classify(f);
  expect(f.rules).toMatchObject({
    backdateAnchor: "ServerObservation",
    backdateMaximumMilliseconds: 604800000,
    requirements: [
      {
        skuReference: id(1),
        Pricing: "RequiredWarning",
        Recipe: "RequiredWarning",
        Inventory: "RequiredWarning",
        Menu: "RequiredWarning",
      },
    ],
  });
  expect(result.checks).toEqual([
    { code: "EffectivePeriod", outcome: "Pass" },
    { code: "ChangeImpact", outcome: "Warning" },
  ]);
  expect(result.findings.map((f) => f.reasonCode)).toEqual([
    "REQUIRED_PRICING_REFERENCE_MISSING",
    "REQUIRED_RECIPE_REFERENCE_MISSING",
    "REQUIRED_INVENTORY_REFERENCE_MISSING",
    "REQUIRED_MENU_REFERENCE_MISSING",
  ]);
  expect(result.findings.every((f) => f.outcome === "Warning" && f.references.length === 2)).toBe(
    true,
  );
});
it.each([
  [604800000, "Pass"],
  [604800001, "HardError"],
] as const)("applies inclusive server backdate boundary %i", (age, outcome) => {
  const result = classify({
    ...input(),
    effectiveFrom: new Date(Date.parse(at) - age).toISOString(),
  });
  expect(result.checks[0]).toEqual({ code: "EffectivePeriod", outcome });
});
it("does not mix missing-reference warnings into an independent period error", () => {
  const result = classify({ ...input(), effectiveFrom: "2026-09-01T00:00:00.000Z" });
  expect(result.checks).toEqual([
    { code: "EffectivePeriod", outcome: "HardError" },
    { code: "ChangeImpact", outcome: "Warning" },
  ]);
});
it("uses supplied exact presence sets, not a blanket four-domain warning", () => {
  const result = classify({
    ...input(),
    presentReferences: { Pricing: [id(1)], Recipe: [id(1)], Inventory: [id(1)], Menu: [id(1)] },
  });
  expect(result.findings).toEqual([]);
  expect(result.checks.every((c) => c.outcome === "Pass")).toBe(true);
});
it("keeps an explicitly configured error and absolute boundary without changing ordinary defaults", () => {
  const f = input(),
    rules = parse(
      {
        matchingBasis: "RecordedConfigurationReferences",
        earliestPermittedEffectiveFrom: at,
        requirements: [
          {
            skuReference: id(1),
            Pricing: "RequiredError",
            Recipe: "NotRequired",
            Inventory: "NotRequired",
            Menu: "NotRequired",
          },
        ],
      },
      f.activeSkuReferences,
    );
  const result = classify({ ...f, rules });
  expect(result.checks[1]?.outcome).toBe("HardError");
  expect(result.findings).toHaveLength(1);
  expect(build([id(1)])).toEqual(f.rules);
});
it("requires an exact decision for every Active SKU and rejects duplicate/foreign coverage", () => {
  const rules = build([id(1)]);
  for (const active of [[], [id(1), id(2)], [id(1), id(1)]])
    expect(() => parse(rules, active)).toThrowError();
  expect(() =>
    classify({
      ...input(),
      presentReferences: { Pricing: [id(2)], Recipe: [], Inventory: [], Menu: [] },
    }),
  ).toThrowError();
});
it("empty Active SKU set is independent of the PublishableSku check", () => {
  expect(classify({ ...input(), activeSkuReferences: [], rules: build([]) }).findings).toEqual([]);
});
it("retains stable rule bytes and reference findings across later observations", () => {
  const f = input(),
    before = hash(f.rules),
    later = { ...f, observedAt: "2026-10-03T13:00:00.000Z" };
  expect(classify(later)).toEqual(classify(f));
  expect(hash(build([id(1)]))).toBe(before);
});
it("rejects omitted/altered clock policy and accessors without invoking them", () => {
  const f = input(),
    getter = { called: false };
  expect(() =>
    parse({ ...f.rules, backdateMaximumMilliseconds: 0 }, f.activeSkuReferences),
  ).toThrowError();
  expect(() =>
    parse(
      { matchingBasis: "RecordedConfigurationReferences", requirements: f.rules.requirements },
      f.activeSkuReferences,
    ),
  ).toThrowError();
  const raw = { ...f.rules };
  Object.defineProperty(raw, "requirements", {
    enumerable: true,
    get() {
      getter.called = true;
      return [];
    },
  });
  expect(() => parse(raw, f.activeSkuReferences)).toThrowError();
  expect(getter.called).toBe(false);
});
