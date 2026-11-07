import { expect, it } from "vitest";
import { resolveCurrentCatalogSelectionRules } from "../application/current-selection-rules.js";
import { withOptionsOffNow } from "../application/options-off-now.js";
import { publishedDefaultOptionSelections } from "../domain/published-menu-projection.js";

/** WP-2423 sold-out-and-allergen-safety (M22, M24): choices a Store cannot sell now. */
const id = (n: number) => "01902402-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-10T12:00:00.000Z";
function pair(minimumSelection = 1) {
  const option = (offset: number) => ({
    optionReference: id(10 + offset),
    optionSetReference: id(10),
    brandReference: id(1),
    stableCode: "OPTION_" + offset,
    lifecycle: "Active",
    localizedNames: { "en-CA": "Synthetic option" },
    localizedDescriptions: {},
    sortOrder: offset,
    defaultEligible: true,
    triggeredOptionSetReference: null,
    conflictOptionReferences: [],
    createdAt: at,
    createdByActorReference: id(2),
  });
  return {
    binding: {
      bindingReference: id(11),
      optionSetReference: id(10),
      optionSetVersionReference: id(12),
      purpose: "CHOICE",
      sortOrder: 0,
      enabledOptionReferences: [id(13), id(14)],
      defaultSelections: [{ optionReference: id(13), quantity: 1 }],
      minimumSelectionOverride: null,
      maximumSelectionOverride: null,
      includedSkuReferences: [],
      excludedSkuReferences: [],
      channelCodes: [],
      storeOverrideAllowed: false,
    },
    optionSet: {
      optionSetReference: id(10),
      brandReference: id(1),
      internalCode: "SET_10",
      lifecycle: "Draft",
      aggregateVersion: 1,
      createdAt: at,
      createdByActorReference: id(2),
      updatedAt: at,
      draft: {
        versionReference: id(12),
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic set" },
        localizedDescriptions: {},
        displayStyle: "Quantity",
        minimumSelection,
        maximumSelection: 4,
        allowRepeatedOption: true,
        perOptionMaximumQuantity: 3,
        maximumTotalQuantity: 4,
        options: [option(3), option(4)],
        createdAt: at,
        updatedAt: at,
      },
    },
  };
}

it("turns a choice off for now in Sale reads only, leaving the Brand's option set as it is", () => {
  const p = pair() as never as Parameters<typeof withOptionsOffNow>[0][number];
  const off = withOptionsOffNow([p], new Map([[id(13), "SoldOut"]]));
  expect(off[0]?.optionSet.draft.options.map((o) => o.lifecycle)).toEqual(["Inactive", "Active"]);
  expect(p.optionSet.draft.options.map((o) => o.lifecycle)).toEqual(["Active", "Active"]);
  // Selling offers what is left and keeps the group's minimum.
  const rules = resolveCurrentCatalogSelectionRules(off, undefined, { rules: "Sale" });
  expect(rules[0]?.options.map((o) => o.optionReference)).toEqual([id(14)]);
  // Nothing off: the same bindings come back.
  expect(withOptionsOffNow([p], new Map())).toEqual([p]);
});

it("a required slot with every choice off is a rule nothing satisfies", () => {
  const p = pair() as never as Parameters<typeof withOptionsOffNow>[0][number];
  const off = withOptionsOffNow(
    [p],
    new Map([
      [id(13), "SoldOut"],
      [id(14), "NotOffered"],
    ]),
  );
  const rules = resolveCurrentCatalogSelectionRules(off, undefined, { rules: "Sale" });
  expect(rules[0]).toMatchObject({ minimumQuantity: 1, options: [] });
});

it("observes stock for the dish as guests can order it: a default that is off moves to the next choice", () => {
  const rule = {
    bindingReference: id(11),
    optionSetVersionReference: id(12),
    minimumSelections: 1,
    maximumSelections: 1,
    enabledOptionReferences: [id(13), id(14)],
    defaultOptionReferences: [id(13)],
    options: [
      {
        optionReference: id(13),
        localizedNames: {},
        maximumQuantity: 1,
        conflictOptionReferences: [],
        selectedByDefault: true,
      },
      {
        optionReference: id(14),
        localizedNames: {},
        maximumQuantity: 1,
        conflictOptionReferences: [],
        selectedByDefault: false,
      },
    ],
  } as never;
  expect(publishedDefaultOptionSelections([rule], "CUSTOMER_PWA")).toEqual([
    { bindingReference: id(11), optionReference: id(13), quantity: 1 },
  ]);
  expect(
    publishedDefaultOptionSelections([rule], "CUSTOMER_PWA", new Map([[id(13), "SoldOut"]])),
  ).toEqual([{ bindingReference: id(11), optionReference: id(14), quantity: 1 }]);
  // Every choice off: none stands in (the dish is not orderable; it reads sold out).
  expect(
    publishedDefaultOptionSelections([rule], "CUSTOMER_PWA", new Set([id(13), id(14)])),
  ).toEqual([]);
});
