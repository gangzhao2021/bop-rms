import { describe, expect, it } from "vitest";
import { navigationForStoreFeatures, storeFeatureScreens } from "./merchant-store-features.js";

describe("WP-2423 item 8 ⑦ DEC-STORE-FEATURES navigation", () => {
  const all = {
    counterOrder: true,
    pickup: true,
    inventory: true,
    loyalty: true,
    complianceDocuments: true,
  };
  const navigation = [
    "HOME-OVERVIEW",
    "OPS-ORDER-ENTRY",
    "FUL-PICKUP-QUEUE",
    "DIN-FLOOR-BOARD",
    "INV-ITEM-LIST",
    "INV-RECEIPT-LIST",
    "RECIPE-OPTION-LIST",
    "CAT-AVAILABILITY",
    "CMP-ALLERGEN-REVIEW",
  ].map((screenId) => ({ screenId }));
  it("lists every screen while every module is in use", () => {
    expect(navigationForStoreFeatures(navigation, all)).toEqual(navigation);
  });
  it("leaves out only the screens of a module turned off; allergens and sold out stay", () => {
    expect(
      navigationForStoreFeatures(navigation, { ...all, counterOrder: false, inventory: false }).map(
        (item) => item.screenId,
      ),
    ).toEqual([
      "HOME-OVERVIEW",
      "FUL-PICKUP-QUEUE",
      "DIN-FLOOR-BOARD",
      "CAT-AVAILABILITY",
      "CMP-ALLERGEN-REVIEW",
    ]);
    expect(Object.keys(storeFeatureScreens)).not.toContain("CMP-ALLERGEN-REVIEW");
  });
  it("keeps the Pickup screen while counter orders are handed over there", () => {
    const shown = (modules: Partial<typeof all>) =>
      navigationForStoreFeatures(navigation, { ...all, ...modules }).some(
        (item) => item.screenId === "FUL-PICKUP-QUEUE",
      );
    expect(shown({ pickup: false })).toBe(true);
    expect(shown({ counterOrder: false })).toBe(true);
    expect(shown({ pickup: false, counterOrder: false })).toBe(false);
  });
});
