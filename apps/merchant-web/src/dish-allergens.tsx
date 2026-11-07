import { allergenName, currentLanguage, listSeparator, t } from "./i18n/i18n.js";
import type { MenuDish } from "./one-store-menu.js";
import type {
  AllergenChoice,
  AllergenClassification,
  DishAllergenAnswers,
  DishAllergens,
} from "./store-menu-pages.js";

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
  const { contains, may } = declaredNames(dish.allergens.declared, choices);
  if (contains === "" && may === "") return t("No allergens");
  return [
    contains ? t("Contains {list}", { list: contains }) : "",
    may ? t("May contain {list}", { list: may }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function declaredNames(
  declared: readonly {
    readonly allergenReference: string;
    readonly classification: AllergenClassification;
  }[],
  choices: readonly AllergenChoice[],
) {
  // WP-2423 (M75): in the staff member's language, as on the Allergens page.
  const names = new Map(choices.map((c) => [c.allergenReference, choiceName(c)]));
  const of = (kind: AllergenClassification) =>
    declared
      .filter((a) => a.classification === kind)
      .map((a) => names.get(a.allergenReference) ?? "")
      .filter((name) => name !== "")
      .join(listSeparator());
  return { contains: of("Contains"), may: of("CrossContactPossible") };
}

/** An allergen's name in the chosen language (the registry's Chinese name, else the built-in one). */
export function choiceName(choice: AllergenChoice): string {
  if (currentLanguage() === "zh-Hans" && choice.nameZh !== "") return choice.nameZh;
  return allergenName(choice.code ?? "", choice.name);
}

/**
 * WP-2423 (M76, Owner default 2026-11-06): the answers a dish starts from. A dish staff declared
 * answered every allergen then, so each one it did not declare reads No; a new dish (or one not
 * declared yet) starts with every allergen unanswered, so a tick never declares "none" for rows
 * nobody looked at.
 */
export function startingAllergenAnswers(
  allergens: DishAllergens | undefined,
  choices: readonly AllergenChoice[],
): ReadonlyMap<string, AllergenAnswer> {
  if (allergens?.source !== "StaffDeclared" || allergens.noIngredients === true) return new Map();
  const answers = new Map<string, AllergenAnswer>(
    choices.map((choice) => [choice.allergenReference, "None"]),
  );
  for (const declared of allergens.declared)
    answers.set(declared.allergenReference, declared.classification);
  return answers;
}

/** How many allergens on the list have no answer yet. */
export function unansweredAllergens(
  values: ReadonlyMap<string, AllergenAnswer>,
  choices: readonly AllergenChoice[],
): number {
  return choices.filter((choice) => !values.has(choice.allergenReference)).length;
}

/** Every allergen's answer, as the server records it; null while any is unanswered. */
export function everyAllergenAnswer(
  values: ReadonlyMap<string, AllergenAnswer>,
  choices: readonly AllergenChoice[],
): DishAllergenAnswers | null {
  if (unansweredAllergens(values, choices) > 0) return null;
  return choices.map((choice) => ({
    allergenReference: choice.allergenReference,
    classification: values.get(choice.allergenReference) as AllergenAnswer,
  }));
}

/** WP-2423 item 3: the allergens as the form now says, one line above the tick that confirms them. */
export function allergenFormSummary(
  values: ReadonlyMap<string, AllergenAnswer>,
  choices: readonly AllergenChoice[],
): string {
  const unanswered = unansweredAllergens(values, choices);
  if (unanswered > 0)
    return unanswered === 1
      ? t("1 allergen is not answered yet. Answer Contains, May contain or No for each one.")
      : t(
          "{count} allergens are not answered yet. Answer Contains, May contain or No for each one.",
          {
            count: unanswered,
          },
        );
  const { contains, may } = declaredNames(
    [...values]
      .filter((entry): entry is [string, AllergenClassification] => entry[1] !== "None")
      .map(([allergenReference, classification]) => ({ allergenReference, classification })),
    choices,
  );
  if (contains === "" && may === "") return t("No allergens marked.");
  return [
    contains ? `${t("Contains {list}", { list: contains })}.` : "",
    may ? `${t("May contain {list}", { list: may })}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * One row per allergen on the Brand's list: no, contains, or may contain. A row with no answer
 * shows none chosen (WP-2423 M76); `unansweredAs` reads a missing answer as that one instead (a
 * choice's additions, where only what it adds is asked).
 */
export function AllergenFields({
  fieldKey,
  choices,
  values,
  onChange,
  unansweredAs,
}: {
  readonly fieldKey: string;
  readonly choices: readonly AllergenChoice[];
  readonly values: ReadonlyMap<string, AllergenAnswer>;
  readonly onChange: (allergenReference: string, value: AllergenAnswer) => void;
  readonly unansweredAs?: AllergenAnswer;
}) {
  return (
    <div className="dish-editor__allergens">
      {choices.map((choice) => {
        const value = values.get(choice.allergenReference) ?? unansweredAs;
        const set = (next: AllergenAnswer) => onChange(choice.allergenReference, next);
        // WP-2423 (M75): the name in the chosen language; in Chinese the English one under it,
        // so the owner can match the supplier's spec sheet.
        const name = choiceName(choice);
        const english = name === choice.name ? null : choice.name;
        return (
          <div
            key={choice.allergenReference}
            role="radiogroup"
            aria-label={name}
            data-unanswered={value === undefined ? "" : undefined}
          >
            <span className="dish-editor__allergen">
              {name}
              {english === null ? null : (
                <span className="dish-editor__allergen-other" lang="en">
                  {english}
                </span>
              )}
            </span>
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
