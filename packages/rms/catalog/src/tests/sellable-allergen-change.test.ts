import { describe, expect, it } from "vitest";
import { changedAllergenDisclosure } from "../application/customer-menu-query-service.js";
import {
  withSellableAllergenChange,
  type SellableAllergenNow,
} from "../domain/sellable-allergen-change.js";

/** WP-2423 (M77, M167): synthetic, TEST-only allergens. */
const ref = (n: number) => "01909b00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Allergen = SellableAllergenNow;
const egg: Allergen = {
  allergenReference: ref(1),
  code: "EGG",
  localizedNames: { "en-CA": "Eggs", "zh-Hans": "蛋" },
  classification: "Contains" as const,
};
const milk: Allergen = {
  ...egg,
  allergenReference: ref(2),
  code: "MILK",
  localizedNames: { "en-CA": "Milk" },
};
const change = (allergens: Allergen[] | null) => ({
  skuReference: ref(9),
  storeReference: null,
  cause: "RecipeBound" as const,
  allergens,
  recordedAt: "2026-11-06T16:00:00.000Z",
});
const listed = (code: string, classification: "Contains" | "CrossContactPossible") => ({
  code,
  classification,
});
const entry = (a: Allergen) => ({ code: a.code, classification: a.classification });

describe("WP-2423 (M77, M167): a recipe change read with the listed allergens", () => {
  it("adds what the recipe brings, keeps Contains over May contain, and says it changed", () => {
    expect(withSellableAllergenChange([listed("MILK", "Contains")], undefined, entry)).toEqual({
      items: [listed("MILK", "Contains")],
      changed: false,
    });
    expect(
      withSellableAllergenChange([listed("MILK", "Contains")], change([egg, milk]), entry),
    ).toEqual({ items: [listed("MILK", "Contains"), listed("EGG", "Contains")], changed: true });
    expect(
      withSellableAllergenChange([listed("EGG", "CrossContactPossible")], change([egg]), entry),
    ).toEqual({ items: [listed("EGG", "Contains")], changed: true });
    // A recipe that leaves an allergen out never removes it before the menu is listed again.
    expect(withSellableAllergenChange([listed("MILK", "Contains")], change([]), entry)).toEqual({
      items: [listed("MILK", "Contains")],
      changed: false,
    });
    // Not resolved: the listed list stays, and guests are told to ask.
    expect(withSellableAllergenChange([], change(null), entry)).toEqual({
      items: [],
      changed: true,
    });
  });

  it("guests read the egg in the dish and in every set of choices, said just updated", () => {
    const disclosure = {
      registryVersionReference: ref(50),
      items: [
        {
          allergenReference: ref(2),
          code: "MILK",
          name: "Milk",
          classification: "Contains" as const,
        },
      ],
      allergenFreeClaim: false as const,
      assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED" as const,
      byChoice: {
        options: [ref(30)],
        outcomes: [[], [listed("MILK", "Contains")]],
        sets: [[0], [1, 0]],
      },
    } as never;
    const seen = changedAllergenDisclosure(
      disclosure,
      change([egg]),
      (names) => names["zh-Hans"] ?? "",
    );
    expect(seen.justUpdated).toBe(true);
    expect(seen.items.map((item) => [item.code, item.name, item.classification])).toEqual([
      ["MILK", "Milk", "Contains"],
      ["EGG", "蛋", "Contains"],
    ]);
    expect(seen.byChoice?.outcomes).toEqual([
      [listed("EGG", "Contains")],
      [listed("MILK", "Contains"), listed("EGG", "Contains")],
    ]);
    // Nothing new: the listed disclosure as it was, not said updated.
    expect(changedAllergenDisclosure(disclosure, change([milk]), () => "")).toBe(disclosure);
    expect(changedAllergenDisclosure(disclosure, undefined, () => "")).toBe(disclosure);
  });
});
