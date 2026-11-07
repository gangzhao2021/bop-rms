import { describe, expect, it } from "vitest";
import { sellableDisplayNames } from "../contracts/product.js";

describe("WP-2423 sellable display names", () => {
  it("shows a size SKU after its Product name", () => {
    expect(
      sellableDisplayNames(
        { "en-CA": "Flat White", "fr-CA": "Flat white" },
        { "en-CA": "Small (8 oz)" },
        "en-CA",
      ),
    ).toEqual({ "en-CA": "Flat White — Small (8 oz)", "fr-CA": "Flat white" });
  });
  it("keeps a SKU name that already names the Product, and a Product without SKU names", () => {
    expect(sellableDisplayNames({ "en-CA": "Latte" }, { "en-CA": "latte 12 oz" }, "en-CA")).toEqual(
      {
        "en-CA": "latte 12 oz",
      },
    );
    expect(sellableDisplayNames({ "en-CA": "Latte" }, {}, "en-CA")).toEqual({ "en-CA": "Latte" });
  });
  it("keeps the SKU name alone when the pair is too long", () => {
    const product = "P".repeat(100);
    expect(
      sellableDisplayNames({ "en-CA": product }, { "en-CA": "S".repeat(30) }, "en-CA"),
    ).toEqual({ "en-CA": "S".repeat(30) });
  });
});
