import { describe, expect, it } from "vitest";
import { derivedReference, parseProductCommandBody } from "./merchant-products.js";

const id = (n: number) => "01909a1b-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const size = (code: string, name: string, skuReference: string | null = null) => ({
  skuReference,
  skuCode: code,
  name,
});
describe("WP-2423 product command body", () => {
  it("accepts and normalizes each product action", () => {
    expect(
      parseProductCommandBody({
        action: "Create",
        operationReference: id(1),
        internalCode: " latte ",
        productType: "NonAlcoholicBeverage",
        name: "  Caffè   Latte ",
        taxClassificationReference: id(2),
        sizes: [size("latte-s", "Small"), size("LATTE-L", "Large")],
      }),
    ).toMatchObject({
      internalCode: "LATTE",
      name: "Caffè Latte",
      sizes: [{ skuCode: "LATTE-S" }, { skuCode: "LATTE-L" }],
    });
    expect(
      parseProductCommandBody({
        action: "SaveDraft",
        operationReference: id(1),
        productReference: id(3),
        expectedAggregateVersion: 2,
        name: "Latte",
        taxClassificationReference: id(2),
        sizes: [size("LATTE-S", "Small", id(4))],
      }).action,
    ).toBe("SaveDraft");
    expect(
      parseProductCommandBody({
        action: "StartSelling",
        operationReference: id(1),
        productReference: id(3),
        expectedAggregateVersion: 5,
      }).action,
    ).toBe("StartSelling");
  });
  it.each([
    ["no sizes", { sizes: [] }],
    ["duplicate size codes", { sizes: [size("A", "Small"), size("A", "Large")] }],
    ["duplicate size names", { sizes: [size("A", "Small"), size("B", "small")] }],
    ["an existing size on create", { sizes: [size("A", "Small", id(9))] }],
    ["a code starting with a digit", { internalCode: "12OZ" }],
    ["an unknown product type", { productType: "Alcohol" }],
    ["an extra field", { price: 500 }],
  ])("refuses %s", (_label, change) => {
    expect(() =>
      parseProductCommandBody({
        action: "Create",
        operationReference: id(1),
        internalCode: "LATTE",
        productType: "PreparedFood",
        name: "Latte",
        taxClassificationReference: id(2),
        sizes: [size("LATTE-S", "Small")],
        ...change,
      }),
    ).toThrow(expect.objectContaining({ code: "Invalid" }));
  });
  it("derives stable UUIDv7-shaped step references that keep the operation time", () => {
    const first = derivedReference(id(1), "start:product");
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(first.slice(0, 13)).toBe(id(1).slice(0, 13));
    expect(derivedReference(id(1), "start:product")).toBe(first);
    expect(derivedReference(id(1), "start:" + id(4))).not.toBe(first);
  });
});
