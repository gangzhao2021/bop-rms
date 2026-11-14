import { describe, expect, it } from "vitest";
import {
  applyCatalogTaxClassificationChange,
  catalogTaxClassificationCode,
} from "../contracts/product-tax-classification-registry-change.js";
import {
  assertCatalogProductTaxClassificationRegistrySuccessor,
  catalogProductTaxClassificationRegistryDigest,
  parseCatalogProductTaxClassificationRegistry,
} from "../contracts/product-tax-classification-registry.js";

const id = (n: number) => "01902433-0002-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-15T10:00:00.000Z";
function registry(
  version: number,
  definitions: unknown[],
  defaultClassificationReference: string | null = null,
  previous: unknown = null,
) {
  return parseCatalogProductTaxClassificationRegistry({
    profile: "CatalogProductTaxClassificationRegistryV1",
    tenantReference: id(1),
    brandReference: id(2),
    registryReference: id(3),
    versionReference: id(100 + version),
    registryVersion: version,
    defaultLocale: "en-CA",
    previousSnapshotDigest:
      previous === null ? null : catalogProductTaxClassificationRegistryDigest(previous),
    registeredAt: at,
    definitions,
    defaultClassificationReference,
  });
}
const first = registry(1, [
  {
    classificationReference: id(10),
    code: "PREPARED_FOOD",
    localizedNames: { "en-CA": "Prepared food", "fr-CA": "Aliments préparés" },
    lifecycle: "Active",
  },
  {
    classificationReference: id(11),
    code: "ALCOHOL",
    localizedNames: { "en-CA": "Alcohol" },
    lifecycle: "Active",
  },
]);
const ok = (value: ReturnType<typeof applyCatalogTaxClassificationChange>) => {
  if (!value.ok) throw new Error("refused: " + value.reason);
  return value;
};

describe("WP-2423 tax classification changes (Brand Owner)", () => {
  it("derives a permanent uppercase code from the name, unique among every code used", () => {
    expect(catalogTaxClassificationCode("Prepared food", new Set())).toBe("PREPARED_FOOD");
    expect(catalogTaxClassificationCode("Crème brûlée & café", new Set())).toBe(
      "CREME_BRULEE_CAFE",
    );
    expect(catalogTaxClassificationCode("5% items", new Set())).toBe("CLASSIFICATION_5_ITEMS");
    expect(catalogTaxClassificationCode("!!!", new Set())).toBe("CLASSIFICATION");
    expect(catalogTaxClassificationCode("Alcohol", new Set(["ALCOHOL", "ALCOHOL_2"]))).toBe(
      "ALCOHOL_3",
    );
    expect(catalogTaxClassificationCode("x".repeat(200), new Set()).length).toBeLessThanOrEqual(48);
  });
  it("adds classifications (first version included) with generated codes, Active", () => {
    const value = ok(
      applyCatalogTaxClassificationChange(null, "en-CA", {
        kind: "Add",
        entries: [
          { classificationReference: id(20), localizedNames: { "en-CA": " Fees " } },
          { classificationReference: id(21), localizedNames: { "en-CA": "Fees  extra" } },
        ],
      }),
    );
    expect(value.definitions).toEqual([
      {
        classificationReference: id(20),
        code: "FEES",
        localizedNames: { "en-CA": "Fees" },
        lifecycle: "Active",
      },
      {
        classificationReference: id(21),
        code: "FEES_EXTRA",
        localizedNames: { "en-CA": "Fees extra" },
        lifecycle: "Active",
      },
    ]);
    expect(value.defaultClassificationReference).toBeNull();
    // A retired code is never reused, even when its name is free again.
    const retired = registry(
      2,
      [{ ...first.definitions[1], lifecycle: "Retired" }, first.definitions[0]],
      null,
      first,
    );
    const again = ok(
      applyCatalogTaxClassificationChange(retired, "en-CA", {
        kind: "Add",
        entries: [{ classificationReference: id(22), localizedNames: { "en-CA": "alcohol" } }],
      }),
    );
    expect(again.definitions.find((d) => d.classificationReference === id(22))?.code).toBe(
      "ALCOHOL_2",
    );
  });
  it("refuses a name already in use (ignoring case), a missing default-language name and bad text", () => {
    for (const localizedNames of [
      { "en-CA": "ALCOHOL" },
      { "en-CA": "Other", "fr-CA": "aliments préparés" },
    ])
      expect(
        applyCatalogTaxClassificationChange(first, "en-CA", {
          kind: "Add",
          entries: [{ classificationReference: id(30), localizedNames }],
        }),
      ).toEqual({ ok: false, reason: "NameTaken" });
    for (const localizedNames of [
      { "fr-CA": "Frais" },
      { "en-CA": "<b>Fees</b>" },
      { "en-CA": "" },
    ])
      expect(
        applyCatalogTaxClassificationChange(first, "en-CA", {
          kind: "Add",
          entries: [{ classificationReference: id(30), localizedNames }],
        }),
      ).toEqual({ ok: false, reason: "Invalid" });
  });
  it("renames in place (same identity and code), sets and clears the default", () => {
    const renamed = ok(
      applyCatalogTaxClassificationChange(first, "en-CA", {
        kind: "Rename",
        classificationReference: id(11),
        localizedNames: { "en-CA": "Alcoholic drinks", "fr-CA": "Boissons alcoolisées" },
      }),
    );
    expect(renamed.definitions[1]).toEqual({
      classificationReference: id(11),
      code: "ALCOHOL",
      localizedNames: { "en-CA": "Alcoholic drinks", "fr-CA": "Boissons alcoolisées" },
      lifecycle: "Active",
    });
    // Renaming to its own name in another case is not a clash with itself.
    expect(
      applyCatalogTaxClassificationChange(first, "en-CA", {
        kind: "Rename",
        classificationReference: id(11),
        localizedNames: { "en-CA": "alcohol" },
      }).ok,
    ).toBe(true);
    const withDefault = ok(
      applyCatalogTaxClassificationChange(first, "en-CA", {
        kind: "SetDefault",
        classificationReference: id(10),
      }),
    );
    expect(withDefault.defaultClassificationReference).toBe(id(10));
    expect(
      applyCatalogTaxClassificationChange(first, "en-CA", {
        kind: "SetDefault",
        classificationReference: id(99),
      }),
    ).toEqual({ ok: false, reason: "NotFound" });
  });
  it("retires for good: the default is cleared, and a retired one cannot be renamed, chosen or retired again", () => {
    const withDefault = registry(2, [...first.definitions], id(10), first);
    const retired = ok(
      applyCatalogTaxClassificationChange(withDefault, "en-CA", {
        kind: "Retire",
        classificationReference: id(10),
      }),
    );
    expect(retired.defaultClassificationReference).toBeNull();
    expect(retired.definitions[0]?.lifecycle).toBe("Retired");
    const next = registry(3, [...retired.definitions], null, withDefault);
    // The owner's successor rule agrees: same identities and codes, retirement kept.
    expect(() =>
      assertCatalogProductTaxClassificationRegistrySuccessor(withDefault, next),
    ).not.toThrow();
    for (const change of [
      { kind: "Rename", classificationReference: id(10), localizedNames: { "en-CA": "Back" } },
      { kind: "SetDefault", classificationReference: id(10) },
      { kind: "Retire", classificationReference: id(10) },
    ] as const)
      expect(applyCatalogTaxClassificationChange(next, "en-CA", change)).toEqual({
        ok: false,
        reason: "Retired",
      });
  });
});
