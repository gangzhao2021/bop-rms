import { expect, it } from "vitest";
import {
  CatalogError,
  OptionBindingSourceError,
  parseOptionSetAggregate,
  parseProductOptionBinding,
} from "@rms/catalog";
import {
  choiceGroupReason,
  menuCatalogError,
  MerchantMenuError,
  menuStopReason,
  throwSite,
} from "./merchant-menus.js";

/**
 * v15 2026-10-29: a listing review refused as "unavailable" says where it was refused (a file and
 * line, never a reference), so the cause is found from the page.
 */
it("names the source line an unavailable review was refused at, past its fail helper", () => {
  const fail = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  let caught: unknown;
  try {
    fail();
  } catch (error) {
    caught = error;
  }
  expect(throwSite(caught)).toMatch(/^merchant-menus-review-stop\.test\.ts:\d+$/u);
  expect(throwSite("not an error")).toBe("unknown");
});

/**
 * WP-2423 item 14: the page is told a reason from a closed list. A code naming a source line, or
 * anything else unforeseen, is "Unexpected": staff try again, and the log has the rest.
 */
it("sends only a named reason to the page", () => {
  for (const reason of [
    "NoAllergenList",
    "AllergenListChanged",
    "AllergenEvidenceDiffers",
    "NoAllergenEvidence",
    "NoDraft",
    "NotAuthorized",
    "NoConfiguration",
    "ChoiceGroup",
    "ChoiceGroupDefault",
  ]) {
    expect(menuStopReason(reason)).toBe(reason);
    expect(menuStopReason("Submit:" + reason)).toBe(reason);
  }
  for (const reason of [
    "Unknown",
    "Submit:Unavailable@merchant-menus.ts:123",
    "Submit:Unavailable@merchant-menus.ts:123:ChoiceGroupRule",
    "Unexpected:TypeError:CATALOG_DEPENDENCY_UNAVAILABLE",
    "",
  ])
    expect(menuStopReason(reason)).toBe("Unexpected");
});

/**
 * WP-2423 (v15 2026-11-05): "List it" checks the listing first. A dish's choice group that breaks a
 * rule there is named with the dish and the group, and nothing a Check refuses reads as the menu's
 * section names ("Invalid") or as a listing stopped part-way.
 */
const groupId = (n: number) => `018f5000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const serve = (versionReference: string, hot: "Active" | "Inactive", icedDefault: boolean) =>
  parseOptionSetAggregate({
    optionSetReference: groupId(3),
    brandReference: groupId(2),
    internalCode: "SERVE",
    lifecycle: "Draft",
    aggregateVersion: 2,
    draft: {
      versionReference,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Serve" },
      localizedDescriptions: {},
      displayStyle: "SingleChoice",
      minimumSelection: 1,
      maximumSelection: 1,
      allowRepeatedOption: false,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 1,
      options: [
        [groupId(5), "hot", hot, true],
        [groupId(6), "iced", "Active", icedDefault],
      ].map(([optionReference, stableCode, lifecycle, defaultEligible], sortOrder) => ({
        optionReference,
        optionSetReference: groupId(3),
        brandReference: groupId(2),
        stableCode,
        lifecycle,
        localizedNames: { "en-CA": String(stableCode) },
        localizedDescriptions: {},
        sortOrder,
        defaultEligible,
        triggeredOptionSetReference: null,
        conflictOptionReferences: [],
        createdAt: "2026-08-01T14:00:00.000Z",
        createdByActorReference: groupId(1),
      })),
      createdAt: "2026-08-01T14:00:00.000Z",
      updatedAt: "2026-08-01T14:00:00.000Z",
    },
    createdAt: "2026-08-01T14:00:00.000Z",
    createdByActorReference: groupId(1),
    updatedAt: "2026-08-01T14:00:00.000Z",
  });
const stored = parseProductOptionBinding({
  bindingReference: groupId(13),
  optionSetReference: groupId(3),
  // Pinned to an older version of the set than the current one.
  optionSetVersionReference: groupId(40),
  purpose: "CUSTOMER_CHOICE",
  sortOrder: 0,
  enabledOptionReferences: [groupId(5), groupId(6)],
  defaultSelections: [{ optionReference: groupId(5), quantity: 1 }],
  minimumSelectionOverride: null,
  maximumSelectionOverride: null,
  includedSkuReferences: [],
  excludedSkuReferences: [],
  channelCodes: [],
  storeOverrideAllowed: false,
});
it("says where a group is fixed, against the set's current version, not the pinned one", () => {
  // The pinned version still offered Hot; the current one does not, and Iced may not be a
  // default: only Option sets can fix it.
  expect(choiceGroupReason(stored, serve(groupId(41), "Inactive", false))).toBe(
    "ChoiceGroupDefault",
  );
  // The current version lets Iced be the default: saving the dish fixes it.
  expect(choiceGroupReason(stored, serve(groupId(41), "Inactive", true))).toBe("ChoiceGroup");
  // Hot offered again in the current version: saving moves the dish to it.
  expect(choiceGroupReason(stored, serve(groupId(41), "Active", false))).toBe("ChoiceGroup");
  // Not known: the dish is named and the Owner sent to it, as before.
  expect(choiceGroupReason(stored, undefined)).toBe("ChoiceGroup");
  expect(choiceGroupReason(null, serve(groupId(41), "Active", false))).toBe("ChoiceGroup");
});
it("names a choice group's default that is no longer offered on Check and on Submit", () => {
  for (const action of ["Check", "Submit"] as const) {
    const error = new OptionBindingSourceError("DefaultsBelowMinimum", groupId(12), stored);
    const at = { productName: "Soy milk", sizeName: "Regular", optionName: "Serve" };
    const blocked = menuCatalogError(error, action, { ...at, reason: "ChoiceGroupDefault" });
    expect(blocked).toBeInstanceOf(MerchantMenuError);
    expect(blocked.code).toBe("ReviewBlocked");
    expect(blocked.problem).toMatchObject({
      missing: "Stopped",
      reason: "ChoiceGroupDefault",
      productName: "Soy milk",
      optionName: "Serve",
    });
    // Nothing logged as unexpected: staff can act on it.
    expect(blocked.stoppedBy).toBeNull();
    const savable = menuCatalogError(error, action, { ...at, reason: "ChoiceGroup" });
    expect(savable.problem).toMatchObject({ reason: "ChoiceGroup", optionName: "Serve" });
  }
});
it("never answers a listing check with the section-names refusal", () => {
  const unavailable = menuCatalogError(
    new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE"),
    "Check",
    null,
  );
  expect(unavailable.code).toBe("ReviewBlocked");
  expect(unavailable.problem?.reason).toBe("Unexpected");
  expect(unavailable.stoppedBy?.reason).toMatch(/^Check:Unavailable@/u);
  const invalid = menuCatalogError(new CatalogError("CATALOG_INPUT_INVALID"), "Check", null);
  expect(invalid.code).toBe("ReviewBlocked");
  expect(invalid.problem?.reason).toBe("Unexpected");
  expect(menuCatalogError(new CatalogError("CATALOG_PERMISSION_DENIED"), "Check", null).code).toBe(
    "PermissionDenied",
  );
  // Editing a draft keeps its own answers.
  expect(menuCatalogError(new CatalogError("CATALOG_INPUT_INVALID"), "SaveDraft", null).code).toBe(
    "Invalid",
  );
  expect(
    menuCatalogError(new CatalogError("CATALOG_LIFECYCLE_CONFLICT"), "SaveDraft", null).code,
  ).toBe("Frozen");
});
