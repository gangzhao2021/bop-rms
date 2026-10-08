import { describe, expect, it } from "vitest";
import { canadaPriorityAllergensTest, parseAllergenCommandBody } from "./merchant-allergens.js";

const id = (n: number) => "01909a1e-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const declare = (change: Record<string, unknown> = {}) => ({
  action: "Declare",
  operationReference: id(1),
  itemReference: id(2),
  expectedItemVersion: id(3),
  allergens: [{ allergenReference: id(4), classification: "Contains" }],
  sourceKind: "SupplierSpecification",
  documentReference: " Dairy spec 2026-09 ",
  note: "",
  validUntilDate: "2027-10-08",
  ...change,
});
describe("WP-2423 allergen command body", () => {
  it("accepts approving the TEST list and a declaration", () => {
    expect(
      parseAllergenCommandBody({
        action: "ApproveRegistry",
        operationReference: id(1),
        template: "CA_PRIORITY_TEST",
      }).action,
    ).toBe("ApproveRegistry");
    expect(parseAllergenCommandBody(declare())).toMatchObject({
      documentReference: "Dairy spec 2026-09",
      note: null,
    });
    expect(parseAllergenCommandBody(declare({ allergens: [] })).action).toBe("Declare");
  });
  it.each([
    [
      "an unknown classification",
      { allergens: [{ allergenReference: id(4), classification: "Unverified" }] },
    ],
    [
      "an allergen twice",
      {
        allergens: [
          { allergenReference: id(4), classification: "Contains" },
          { allergenReference: id(4), classification: "CrossContactPossible" },
        ],
      },
    ],
    ["no document", { documentReference: " " }],
    ["an unknown source", { sourceKind: "Hearsay" }],
    ["an impossible date", { validUntilDate: "2027-02-30" }],
  ])("refuses %s", (_label, change) => {
    expect(() => parseAllergenCommandBody(declare(change))).toThrow(
      expect.objectContaining({ code: "Invalid" }),
    );
  });
  it("lists the Canadian priority allergens and gluten sources as a labelled test list", () => {
    expect(canadaPriorityAllergensTest.entries.map(([code]) => code)).toEqual([
      "PEANUT",
      "TREE_NUT",
      "SESAME",
      "MILK",
      "EGG",
      "FISH",
      "CRUSTACEAN_MOLLUSC",
      "SOY",
      "WHEAT_TRITICALE",
      "GLUTEN",
      "MUSTARD",
      "SULPHITES",
    ]);
    expect(canadaPriorityAllergensTest.policyDocument).toMatch(/^TEST-ONLY/u);
  });
});
