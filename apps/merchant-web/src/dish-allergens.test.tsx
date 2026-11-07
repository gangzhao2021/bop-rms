import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  AllergenFields,
  allergenFormSummary,
  everyAllergenAnswer,
  startingAllergenAnswers,
  unansweredAllergens,
} from "./dish-allergens.js";

/** WP-2423 (M76, Owner default 2026-11-06): a new dish starts with every allergen unanswered. */
const choices = [
  { allergenReference: "egg", code: "EGG", name: "Eggs", nameZh: "" },
  { allergenReference: "milk", code: "MILK", name: "Milk", nameZh: "" },
  { allergenReference: "soy", code: "SOY", name: "Soy", nameZh: "" },
];

it("WP-2423 (M76): a new dish shows no answer chosen, and its tick declares nothing until each is answered", () => {
  const fresh = startingAllergenAnswers(undefined, choices);
  expect(unansweredAllergens(fresh, choices)).toBe(3);
  expect(everyAllergenAnswer(fresh, choices)).toBeNull();
  expect(allergenFormSummary(fresh, choices)).toBe(
    "3 allergens are not answered yet. Answer Contains, May contain or No for each one.",
  );
  const html = renderToStaticMarkup(
    <AllergenFields fieldKey="new" choices={choices} values={fresh} onChange={() => undefined} />,
  );
  // No radio is pre-chosen: before, every row started on "No".
  expect(html).not.toContain("checked");
  expect(html.match(/data-unanswered/gu)).toHaveLength(3);
  const partly = new Map(fresh).set("egg", "Contains" as const).set("milk", "None" as const);
  expect(allergenFormSummary(partly, choices)).toBe(
    "1 allergen is not answered yet. Answer Contains, May contain or No for each one.",
  );
  expect(everyAllergenAnswer(partly, choices)).toBeNull();
  const all = new Map(partly).set("soy", "None" as const);
  expect(everyAllergenAnswer(all, choices)).toEqual([
    { allergenReference: "egg", classification: "Contains" },
    { allergenReference: "milk", classification: "None" },
    { allergenReference: "soy", classification: "None" },
  ]);
  expect(allergenFormSummary(all, choices)).toBe("Contains Eggs.");
});

it("WP-2423 (M76): a dish staff declared reads No for every allergen it did not declare", () => {
  const declared = startingAllergenAnswers(
    {
      source: "StaffDeclared",
      declared: [{ allergenReference: "milk", classification: "CrossContactPossible" }],
    },
    choices,
  );
  expect([...declared]).toEqual([
    ["egg", "None"],
    ["milk", "CrossContactPossible"],
    ["soy", "None"],
  ]);
  expect(unansweredAllergens(declared, choices)).toBe(0);
  // Not declared yet, a recipe, or a charge: nothing is answered for it.
  expect(startingAllergenAnswers({ source: "None", declared: [] }, choices).size).toBe(0);
  expect(startingAllergenAnswers({ source: "Recipe", declared: [] }, choices).size).toBe(0);
  // A choice's additions read a missing answer as No (only what it adds is asked).
  const html = renderToStaticMarkup(
    <AllergenFields
      fieldKey="apply"
      choices={choices}
      values={new Map()}
      unansweredAs="None"
      onChange={() => undefined}
    />,
  );
  expect(html.match(/checked/gu)).toHaveLength(3);
});
