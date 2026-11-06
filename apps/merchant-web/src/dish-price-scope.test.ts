import { describe, expect, it } from "vitest";
import {
  expectedFor,
  parseSavedPrice,
  priceScopeChoices,
  shownPrice,
  singleStorePrice,
  type PriceBasis,
} from "./dish-price-scope.js";

const ownPriceStore: PriceBasis = {
  brandPriceMinor: "1400",
  pendingBrandPriceMinor: null,
  storePriceMinor: "1200",
};
const several = { severalStores: true, mayAllStores: true, mayThisStore: true };

describe("WP-2423 M70: where a dish's price changes", () => {
  it("at a Store with its own price, shows that price and compares each scope with its own", () => {
    expect(shownPrice(ownPriceStore, true)).toBe("1200");
    expect(expectedFor(ownPriceStore, "ThisStore")).toBe("1200");
    // Every Store: compared with the Brand price, never with this Store's own.
    expect(expectedFor(ownPriceStore, "AllStores")).toBe("1400");
    expect(expectedFor({ ...ownPriceStore, pendingBrandPriceMinor: "1500" }, "AllStores")).toBe(
      "1500",
    );
  });

  it("offers what the person may do; a new dish's first price is for every Store", () => {
    expect(priceScopeChoices(several, ownPriceStore, false)).toEqual(["ThisStore", "AllStores"]);
    expect(priceScopeChoices({ ...several, mayAllStores: false }, ownPriceStore, false)).toEqual([
      "ThisStore",
    ]);
    expect(priceScopeChoices({ ...several, mayThisStore: false }, ownPriceStore, true)).toEqual([
      "AllStores",
    ]);
    expect(priceScopeChoices({ ...several, mayAllStores: false }, ownPriceStore, true)).toEqual([
      "AllStores",
    ]);
    expect(priceScopeChoices(singleStorePrice, ownPriceStore, false)).toEqual(["AllStores"]);
  });

  it("a save's answer becomes what the next save compares with (price, then options alone)", () => {
    // The price was 12.00 here; "only this Store" saved 13.00.
    const after = parseSavedPrice({
      brandPriceMinor: "1400",
      pendingBrandPriceMinor: null,
      storePriceMinor: "1300",
    });
    expect(after).not.toBeNull();
    // The field still says 13.00: unchanged now, so an options-only save sends no price …
    expect(shownPrice(after as PriceBasis, true)).toBe("1300");
    // … and a later edit compares with 13.00, not the 12.00 read when the editor opened.
    expect(expectedFor(after as PriceBasis, "ThisStore")).toBe("1300");
    expect(parseSavedPrice(null)).toBeNull();
    expect(parseSavedPrice({ brandPriceMinor: "1.00" })).toBeNull();
  });
});
