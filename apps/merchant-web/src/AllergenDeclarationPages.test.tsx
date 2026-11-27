import { describe, expect, it } from "vitest";
import { declarationSummary, oneYearAfter } from "./allergen-declaration-pages.js";
import { allergenText } from "./recipe-pages.js";

const registry = {
  registryVersionReference: "r",
  jurisdictionCode: "CA",
  reviewedAt: "2026-10-08T00:00:00.000Z",
  reviewerReference: "a",
  entries: [
    { allergenReference: "m", code: "MILK", localizedNames: { "en-CA": "Milk" } },
    { allergenReference: "s", code: "SESAME", localizedNames: { "en-CA": "Sesame seeds" } },
  ],
};
const declaration = (
  allergens: { allergenReference: string; classification: "Contains" | "CrossContactPossible" }[],
) => ({
  evidenceReference: "e",
  itemReference: "i",
  itemVersionReference: "v",
  registryVersionReference: "r",
  allergens,
  sourceKind: "ProductLabel",
  documentReference: "label",
  note: null,
  declaredBy: "a",
  reviewedAt: "2026-10-08T00:00:00.000Z",
  validUntil: "2027-10-08T04:00:00.000Z",
});
describe("WP-2423 allergen page helpers", () => {
  it("summarizes declarations without claiming an allergen-free product", () => {
    expect(declarationSummary(registry, declaration([]), "en-CA")).toBe("No priority allergens");
    expect(
      declarationSummary(
        registry,
        declaration([
          { allergenReference: "m", classification: "Contains" },
          { allergenReference: "s", classification: "CrossContactPossible" },
        ]),
        "en-CA",
      ),
    ).toBe("Contains Milk · May contain Sesame seeds");
    expect(allergenText({ contains: ["Milk"], mayContain: [] })).toBe("Contains Milk");
  });
  it("defaults validity to one year", () => {
    expect(oneYearAfter("2026-10-08T01:00:00.000Z")).toBe("2027-10-08");
    expect(oneYearAfter("2028-02-29")).toBe("2029-02-28");
  });
});
