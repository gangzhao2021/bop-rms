import { clauseSeparator, listSeparator, t } from "../i18n/i18n.js";
import { allergensForChoice, isCombo } from "./menu-families.js";
import type { MenuView } from "./types.js";

/**
 * WP-2423 item 8 ⑥ part 4 (Owner 2026-10-28 combo decision 2): what a combo line contains with
 * the dishes the guest chose, from the published menu — for the cart and the table's order. null
 * for anything that is not a combo, or when the menu cannot say.
 */
export function comboLineAllergenText(
  menu: MenuView | null,
  sellableReference: string,
  optionReferences: readonly string[],
): string | null {
  const sellable = menu?.sections
    .flatMap((section) => section.sellables)
    .find((candidate) => candidate.sellableReference === sellableReference);
  if (sellable === undefined || !isCombo(sellable)) return null;
  const allergens = allergensForChoice(sellable, optionReferences);
  if (allergens === null) return t("Ask staff about allergens in your choices.");
  if (allergens.length === 0) return t("Your choices: no listed allergens declared.");
  const contains = allergens.filter((item) => item.classification === "Contains");
  const may = allergens.filter((item) => item.classification !== "Contains");
  return t("Your choices: {allergens}.", {
    allergens: [
      contains.length === 0
        ? null
        : t("contains {value1}", {
            value1: contains.map((item) => item.name).join(listSeparator()),
          }),
      may.length === 0
        ? null
        : t("may contain {value1}", { value1: may.map((item) => item.name).join(listSeparator()) }),
    ]
      .filter(Boolean)
      .join(clauseSeparator()),
  });
}

/** The dishes chosen for a combo line, by name ("Hot and sour soup, Fried rice"); null otherwise. */
export function comboLineChoices(
  menu: MenuView | null,
  sellableReference: string,
  optionReferences: readonly string[],
): string | null {
  const sellable = menu?.sections
    .flatMap((section) => section.sellables)
    .find((candidate) => candidate.sellableReference === sellableReference);
  if (sellable === undefined || !isCombo(sellable)) return null;
  const names = sellable.optionRules
    .flatMap((rule) => rule.options)
    .filter((option) => optionReferences.includes(option.optionReference))
    .map((option) => option.name);
  return names.length === 0 ? null : names.join(listSeparator());
}
