import { describe, expect, it } from "vitest";

import {
  parseBundleAggregate,
  simulateBundleConfiguration,
  toPublishedBundleFact,
} from "../domain/bundle.js";

const id = (n: number) => `018f9000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  bundle: id(1),
  brand: id(2),
  actor: id(3),
  version: id(4),
  group: id(5),
  burger: id(6),
  salad: id(7),
  optionSetVersion: id(8),
  availability: id(9),
} as const;
const at = "2026-08-13T14:00:00.000Z";
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("synthetic Bundle fixture is incomplete");
  return value;
}

function aggregate(versionOverrides: Record<string, unknown> = {}) {
  return {
    bundleReference: ids.bundle,
    brandReference: ids.brand,
    internalCode: "LUNCH_COMBO",
    lifecycle: "Draft",
    aggregateVersion: 1,
    currentVersion: {
      versionReference: ids.version,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Lunch combo" },
      localizedDescriptions: { "en-CA": "Choose one lunch item" },
      priceMode: "Computed",
      fixedPrice: null,
      componentGroups: [
        {
          groupReference: ids.group,
          stableCode: "MAIN",
          localizedNames: { "en-CA": "Main" },
          minimumSelection: 1,
          maximumSelection: 1,
          eligibleSellables: [
            { sellableReference: ids.burger, sellableType: "Sku", upgradePrice: null },
            {
              sellableReference: ids.salad,
              sellableType: "Product",
              upgradePrice: { currencyCode: "CAD", amountMinor: "125" },
            },
          ],
          optionSetVersionReference: ids.optionSetVersion,
        },
      ],
      availabilityRuleReferences: [ids.availability],
      validationDigest: null,
      createdAt: at,
      updatedAt: at,
      publishedAt: null,
      ...versionOverrides,
    },
    createdAt: at,
    createdByActorReference: ids.actor,
    updatedAt: at,
  };
}

function evidence(sellableReference = ids.burger) {
  return {
    groupReference: ids.group,
    sellableReference,
    quantity: 1,
    available: true,
    unitPrice: { currencyCode: "CAD", amountMinor: "1099" },
    observedAt: "2026-08-13T13:59:00.000Z",
    expiresAt: "2026-08-13T14:01:00.000Z",
  };
}

describe("Bundle configuration and simulation", () => {
  it("parses a Brand-scoped Draft with Product/SKU children and no nested Bundle", () => {
    expect(parseBundleAggregate(aggregate())).toMatchObject({
      bundleReference: ids.bundle,
      internalCode: "LUNCH_COMBO",
      lifecycle: "Draft",
      currentVersion: { priceMode: "Computed" },
    });
  });

  it("computes exact integer-minor-unit money including an upgrade", () => {
    expect(
      simulateBundleConfiguration({
        aggregate: parseBundleAggregate(aggregate()),
        evidence: [evidence(ids.salad)],
        at,
      }),
    ).toEqual({ currencyCode: "CAD", totalAmountMinor: "1224", selectionCount: 1 });
  });

  it("uses the fixed price without binary floating point", () => {
    const candidate = aggregate({
      priceMode: "Fixed",
      fixedPrice: { currencyCode: "CAD", amountMinor: "1499" },
    });
    expect(
      simulateBundleConfiguration({
        aggregate: parseBundleAggregate(candidate),
        evidence: [evidence()],
        at,
      }).totalAmountMinor,
    ).toBe("1499");
  });

  it("rejects nested Bundle, invalid bounds, duplicate eligible references and markup", () => {
    for (const mutate of [
      (candidate: ReturnType<typeof aggregate>) => {
        required(
          required(candidate.currentVersion.componentGroups[0]).eligibleSellables[0],
        ).sellableType = "Bundle";
      },
      (candidate: ReturnType<typeof aggregate>) => {
        required(candidate.currentVersion.componentGroups[0]).minimumSelection = 2;
      },
      (candidate: ReturnType<typeof aggregate>) => {
        required(
          required(candidate.currentVersion.componentGroups[0]).eligibleSellables[1],
        ).sellableReference = ids.burger;
      },
      (candidate: ReturnType<typeof aggregate>) => {
        candidate.currentVersion.localizedNames["en-CA"] = "<b>unsafe</b>";
      },
    ]) {
      const candidate = aggregate();
      mutate(candidate);
      expect(() => parseBundleAggregate(candidate)).toThrowError(
        expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
      );
    }
  });

  it("fails closed for missing eligibility, unavailable or stale external evidence", () => {
    expect(() =>
      simulateBundleConfiguration({
        aggregate: parseBundleAggregate(aggregate()),
        evidence: [{ ...evidence(), available: false }],
        at,
      }),
    ).toThrowError(expect.objectContaining({ code: "CATALOG_UNAVAILABLE" }));
    expect(() =>
      simulateBundleConfiguration({
        aggregate: parseBundleAggregate(aggregate()),
        evidence: [{ ...evidence(), expiresAt: at }],
        at,
      }),
    ).toThrowError(expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }));
  });

  it("rejects under-selection, duplicate evidence and mixed currencies", () => {
    const parsed = parseBundleAggregate(aggregate());
    for (const candidate of [
      [],
      [evidence(), evidence()],
      [
        {
          ...evidence(ids.salad),
          unitPrice: { currencyCode: "USD", amountMinor: "1099" },
        },
      ],
    ])
      expect(() =>
        simulateBundleConfiguration({ aggregate: parsed, evidence: candidate, at }),
      ).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));
  });

  it("exposes only a validated published fact to Menu consumers", () => {
    expect(() => toPublishedBundleFact(aggregate())).toThrowError(
      expect.objectContaining({ code: "CATALOG_UNAVAILABLE" }),
    );
    const digest = "a".repeat(64);
    const published = parseBundleAggregate({
      ...aggregate({
        status: "Published",
        validationDigest: digest,
        publishedAt: at,
      }),
      lifecycle: "Published",
    });
    expect(toPublishedBundleFact(published)).toMatchObject({
      bundleReference: ids.bundle,
      versionReference: ids.version,
      validationDigest: digest,
      priceMode: "Computed",
    });
  });
});
