import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { ChoiceAdds } from "./DishEditor.js";

const choices = [
  { allergenReference: "a", code: "EGG", name: "Eggs", nameZh: "" },
  { allergenReference: "b", code: "MILK", name: "Milk", nameZh: "" },
];
const line = (picked: ReadonlySet<string> | undefined) =>
  renderToStaticMarkup(
    <ChoiceAdds
      choice="Egg fried rice"
      allergenChoices={choices}
      picked={picked}
      onChange={() => undefined}
    />,
  );

describe("WP-2423 (M166): what a choice adds, on its row", () => {
  it("says not answered, adds none, or what it adds, in the staff member's language", () => {
    expect(line(undefined)).toContain("Adds allergens? Not answered");
    expect(line(new Set())).toContain("Adds no allergens");
    expect(line(new Set(["a"]))).toContain("Adds: Eggs");
    setLanguageForTest("zh-Hans");
    try {
      expect(line(new Set(["a"]))).toContain("加：蛋");
    } finally {
      setLanguageForTest("en");
    }
  });
});
