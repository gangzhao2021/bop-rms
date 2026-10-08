import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { ProductListPage } from "./ProductPages.js";
import {
  createProductClient,
  parseProductListView,
  productCodeValid,
  suggestProductCode,
  taxClassText,
} from "./product-pages.js";

describe("WP-2423 product page helpers", () => {
  it("suggests and checks product codes", () => {
    expect(suggestProductCode("Caffè Latte")).toBe("CAFFE-LATTE");
    expect(suggestProductCode("12 oz drip")).toBe("OZ-DRIP");
    expect(productCodeValid("latte-s")).toBe(true);
    expect(productCodeValid("12OZ")).toBe(false);
  });
  it("shows each order type's rate exactly", () => {
    expect(
      taxClassText({
        taxClassificationReference: "x",
        rules: [
          {
            orderType: "DineIn",
            taxComponentCode: "T",
            treatment: "Taxable",
            rate: "0.13",
            priceInclusion: "Exclusive",
          },
          {
            orderType: "Pickup",
            taxComponentCode: "T",
            treatment: "Taxable",
            rate: "0.05",
            priceInclusion: "Exclusive",
          },
          {
            orderType: "Delivery",
            taxComponentCode: "T",
            treatment: "ZeroRated",
            rate: "0",
            priceInclusion: "Exclusive",
          },
          {
            orderType: "Catering",
            taxComponentCode: "T",
            treatment: "Taxable",
            rate: "0.14975",
            priceInclusion: "Exclusive",
          },
        ],
      }),
    ).toBe("DineIn 13% · Pickup 5% · Delivery ZeroRated · Catering 14.975%");
  });
  it("maps server refusals and offline failures", async () => {
    const reply = (status: number, body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    await expect(
      createProductClient("csrf", () => reply(409, { error: "SizeInUse" })).load(null),
    ).rejects.toMatchObject({ code: "SizeInUse" });
    await expect(
      createProductClient("csrf", () => reply(403, { error: "other" })).load(null),
    ).rejects.toMatchObject({ code: "PermissionDenied" });
    await expect(
      createProductClient("csrf", () => Promise.reject(new TypeError("offline"))).load(null),
    ).rejects.toMatchObject({ code: "Offline" });
  });
  it("renders the empty list with a create link only for creators", () => {
    const view = parseProductListView({
      screenId: "CAT-PRODUCT-LIST",
      sourceAsOf: "2026-10-07T12:00:00.000Z",
      locale: "en-CA",
      permissions: {
        mayRead: true,
        mayCreate: false,
        mayEdit: false,
        mayAddSize: false,
        mayStartSelling: false,
      },
      productTypes: ["PreparedFood"],
      sellingUnits: ["EACH"],
      taxClasses: [],
      products: [],
    });
    expect(view.products).toEqual([]);
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ProductListPage />
      </MemoryRouter>,
    );
    expect(html).toContain("Loading products");
  });
});
