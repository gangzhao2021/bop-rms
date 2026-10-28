import { t } from "./i18n/i18n.js";
import { useState } from "react";
import { Link } from "react-router";
import { newOperationReference } from "./operation-reference.js";
import type { MenuDish } from "./one-store-menu.js";
import { menuErrorText } from "./StoreMenuPages.js";
import {
  MenuPageError,
  type AllergenChoice,
  type AllergenClassification,
  type MenuClient,
} from "./store-menu-pages.js";

export type AllergenAnswer = "None" | AllergenClassification;

/** The dish's declared allergens in words, for its row ("" when none are declared). */
export function allergenSummary(dish: MenuDish, choices: readonly AllergenChoice[]): string {
  if (dish.allergens.source === "Recipe") return t("Allergens from its recipe");
  if (dish.allergens.source === "None") return t("Allergens not declared");
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

/**
 * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU (coordinator 2026-10-28): staff declare a dish's
 * allergens here — for each allergen on the Brand's list: no, contains, or may contain. It is
 * labelled "Allergens declared by staff" (not a costed recipe, never used for stock). A dish with
 * a real recipe takes its allergens from that recipe; once the store keeps stock, staff are asked
 * to replace the declared allergens with a real recipe. Guests see the change when the menu is
 * listed.
 */
export function DishAllergenEditor({
  dish,
  choices,
  keepsStock,
  client,
  onSaved,
  onClose,
}: {
  readonly dish: MenuDish;
  readonly choices: readonly AllergenChoice[];
  readonly keepsStock: boolean;
  readonly client: MenuClient;
  readonly onSaved: (message: string) => void;
  readonly onClose: () => void;
}) {
  const label = dish.nameZh ? `${dish.name} ${dish.nameZh}` : dish.name;
  const [values, setValues] = useState<ReadonlyMap<string, AllergenAnswer>>(
    () =>
      new Map(dish.allergens.declared.map((a) => [a.allergenReference, a.classification] as const)),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // One reference per intended save, kept until it is answered (a retry sends the same one).
  const [operation, setOperation] = useState<string | null>(null);
  if (dish.allergens.source === "Recipe")
    return (
      <div
        className="dish-editor"
        role="group"
        aria-label={t("Allergens of {item}", { item: label })}
      >
        <p>
          {t("This dish has a recipe, so its allergens come from the recipe's ingredients.")}{" "}
          <Link to="/app/commerce/recipes">{t("Open recipes")}</Link>
        </p>
        <button type="button" onClick={onClose}>
          {t("Close")}
        </button>
      </div>
    );
  if (choices.length === 0)
    return (
      <div
        className="dish-editor"
        role="group"
        aria-label={t("Allergens of {item}", { item: label })}
      >
        <p>{menuErrorText.RegistryMissing}</p>
        <button type="button" onClick={onClose}>
          {t("Close")}
        </button>
      </div>
    );
  const save = async () => {
    if (client.declareAllergens === undefined || busy) return;
    setBusy(true);
    setProblem(null);
    const reference = operation ?? newOperationReference();
    setOperation(reference);
    try {
      await client.declareAllergens({
        action: "DeclareDish",
        operationReference: reference,
        skuReference: dish.skuReference,
        allergens: [...values]
          .filter((entry): entry is [string, AllergenClassification] => entry[1] !== "None")
          .map(([allergenReference, classification]) => ({ allergenReference, classification })),
      });
      setOperation(null);
      onSaved(
        t("Allergens of {item} saved. Guests see them when the menu is listed.", { item: label }),
      );
    } catch (error) {
      if (!(error instanceof MenuPageError) || error.code !== "Offline") setOperation(null);
      setProblem(
        error instanceof MenuPageError
          ? menuErrorText[error.code]
          : t("That didn't go through. Read the menu again and retry."),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="dish-editor"
      aria-label={t("Allergens of {item}", { item: label })}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset>
        <legend>{t("Allergens declared by staff")}</legend>
        <p className="dish-editor__note">
          {t(
            "Not a costed recipe and not used for stock. Mark each allergen the dish contains or may contain.",
          )}
        </p>
        {keepsStock && dish.allergens.source === "StaffDeclared" ? (
          <p className="dish-editor__note" role="note">
            {t(
              "This store keeps stock and recipes. Replace these declared allergens with a real recipe for this dish.",
            )}{" "}
            <Link to="/app/commerce/recipes">{t("Open recipes")}</Link>
          </p>
        ) : null}
        <AllergenFields
          fieldKey={dish.skuReference}
          choices={choices}
          values={values}
          onChange={(allergen, next) =>
            setValues((current) => new Map(current).set(allergen, next))
          }
        />
      </fieldset>
      {problem ? (
        <p className="dish-editor__problem" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="dish-editor__actions">
        <button type="submit" className="one-menu__primary" disabled={busy}>
          {busy ? t("Saving…") : t("Save allergens")}
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          {t("Close")}
        </button>
      </div>
    </form>
  );
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
