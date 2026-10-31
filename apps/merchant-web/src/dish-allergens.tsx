import { t } from "./i18n/i18n.js";
import type { MenuDish } from "./one-store-menu.js";
import type { AllergenChoice, AllergenClassification } from "./store-menu-pages.js";

/**
 * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU: a dish's allergens declared by staff in the dish editor
 * (labelled so: not a costed recipe, never used for stock), or — item 8 ⑦ — the dish declared a
 * charge with no stock ingredients, such as the per-head tea.
 */
export type AllergenAnswer = "None" | AllergenClassification;

/** The dish's declared allergens in words, for its row ("" when none are declared). */
export function allergenSummary(dish: MenuDish, choices: readonly AllergenChoice[]): string {
  if (dish.allergens.source === "Recipe") return t("Allergens from its recipe");
  if (dish.allergens.source === "None") return t("Allergens not declared");
  if (dish.allergens.noIngredients === true) return t("A charge, no stock ingredients");
  const names = new Map(choices.map((c) => [c.allergenReference, c.name]));
  const of = (kind: AllergenClassification) =>
    dish.allergens.declared
      .filter((a) => a.classification === kind)
      .map((a) => names.get(a.allergenReference) ?? "")
      .filter((name) => name !== "")
      .join(", ");
  const contains = of("Contains"),
    may = of("CrossContactPossible");
  if (contains === "" && may === "") return t("No allergens");
  return [
    contains ? t("Contains {list}", { list: contains }) : "",
    may ? t("May contain {list}", { list: may }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** One row per allergen on the Brand's list: no, contains, or may contain. */
export function AllergenFields({
  fieldKey,
  choices,
  values,
  onChange,
}: {
  readonly fieldKey: string;
  readonly choices: readonly AllergenChoice[];
  readonly values: ReadonlyMap<string, AllergenAnswer>;
  readonly onChange: (allergenReference: string, value: AllergenAnswer) => void;
}) {
  return (
    <div className="dish-editor__allergens">
      {choices.map((choice) => {
        const value = values.get(choice.allergenReference) ?? "None";
        const set = (next: AllergenAnswer) => onChange(choice.allergenReference, next);
        const name = choice.nameZh ? `${choice.name} ${choice.nameZh}` : choice.name;
        return (
          <div key={choice.allergenReference} role="radiogroup" aria-label={name}>
            <span className="dish-editor__allergen">{name}</span>
            <span className="dish-editor__options">
              {(
                [
                  ["None", t("No")],
                  ["Contains", t("Contains")],
                  ["CrossContactPossible", t("May contain")],
                ] as const
              ).map(([kind, text]) => (
                <label key={kind}>
                  <input
                    type="radio"
                    name={`allergen-${fieldKey}-${choice.allergenReference}`}
                    checked={value === kind}
                    onChange={() => set(kind)}
                  />
                  {text}
                </label>
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}
