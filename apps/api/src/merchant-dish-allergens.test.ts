import { describe, expect, it } from "vitest";
import {
  allergenKey,
  MerchantDishAllergenError,
  parseDishAllergenCommandBody,
  sizeRecipeSource,
} from "./merchant-dish-allergens.js";

const id = (n: number) => "01a4d700-0000-7000-8000-" + n.toString(16).padStart(12, "0");

describe("WP-2423 item 8 ⑥ dish allergens declared by staff", () => {
  it("accepts one decision per allergen and nothing else", () => {
    const body = {
      action: "DeclareDish",
      operationReference: id(1),
      skuReference: id(2),
      allergens: [
        { allergenReference: id(3), classification: "Contains" },
        { allergenReference: id(4), classification: "CrossContactPossible" },
      ],
    };
    const allergensOf = (value: unknown) => {
      const parsed = parseDishAllergenCommandBody(value);
      return parsed.action === "DeclareDish" ? parsed.allergens : null;
    };
    expect(allergensOf(body)).toHaveLength(2);
    expect(allergensOf({ ...body, allergens: [] })).toEqual([]);
    for (const bad of [
      { ...body, extra: true },
      { ...body, action: "Declare" },
      { ...body, allergens: [{ allergenReference: id(3), classification: "Absent" }] },
      { ...body, allergens: [body.allergens[0], body.allergens[0]] },
      { ...body, skuReference: "not-a-reference" },
    ])
      expect(() => parseDishAllergenCommandBody(bad)).toThrow(MerchantDishAllergenError);
  });

  it("WP-2423 item 8 ⑦: declares a size uses no stock ingredients, with nothing else", () => {
    const body = { action: "DeclareNoIngredients", operationReference: id(1), skuReference: id(2) };
    expect(parseDishAllergenCommandBody(body)).toEqual(body);
    for (const bad of [
      { ...body, allergens: [] },
      { ...body, skuReference: "not-a-reference" },
      { action: "DeclareNoIngredients", operationReference: id(1) },
    ])
      expect(() => parseDishAllergenCommandBody(bad)).toThrow(MerchantDishAllergenError);
  });

  it("compares allergen sets regardless of order", () => {
    expect(
      allergenKey([
        { allergenReference: id(4), classification: "CrossContactPossible" },
        { allergenReference: id(3), classification: "Contains" },
      ]),
    ).toBe(
      allergenKey([
        { allergenReference: id(3), classification: "Contains" },
        { allergenReference: id(4), classification: "CrossContactPossible" },
      ]),
    );
  });

  it("never mixes: a real recipe bound to the size wins over the declared allergens", () => {
    const generated = { subject: "Dish", skuReference: id(10), recipeReference: id(20) };
    const bound = (family: number, sku: number, store: string | null = null) => ({
      familyReference: id(family),
      bindings: [{ skuReference: id(sku), storeReference: store }],
    });
    expect(sizeRecipeSource([bound(20, 10)], [generated], id(10))).toBe("StaffDeclared");
    expect(sizeRecipeSource([bound(21, 10)], [generated], id(10))).toBe("Recipe");
    // A store-only recipe does not decide the Brand-wide source.
    expect(sizeRecipeSource([bound(21, 10, id(99))], [generated], id(10))).toBe("StaffDeclared");
    expect(sizeRecipeSource([], [], id(10))).toBe("None");
    expect(sizeRecipeSource([bound(21, 11)], [], id(11))).toBe("Recipe");
  });
});
