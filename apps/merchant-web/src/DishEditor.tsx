import { t } from "./i18n/i18n.js";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { AllergenFields, type AllergenAnswer } from "./DishAllergenEditor.js";
import { DishKitchenMark } from "./DishKitchenMark.js";
import { NewChoiceGroupForm } from "./NewChoiceGroupForm.js";
import { newOperationReference } from "./operation-reference.js";
import type { MenuDish, MenuSectionRow } from "./one-store-menu.js";
import {
  taxClassText,
  type ProductOptionSetChoice,
  type ProductTaxClass,
} from "./product-pages.js";
import { dollarsToMinor, minorToDollars } from "./store-price-pages.js";
import { menuErrorText } from "./StoreMenuPages.js";
import {
  MenuPageError,
  type AllergenChoice,
  type AllergenClassification,
  type MenuClient,
  type SaveDishCommand,
} from "./store-menu-pages.js";

/** What the editor reads for one dish (or a new one). */
export interface DishEditorSource {
  readonly name: string;
  readonly nameZh: string;
  readonly description: string;
  readonly descriptionZh: string;
  readonly taxClassificationReference: string | null;
  readonly sizes: number;
  readonly taxClasses: readonly ProductTaxClass[];
  readonly groups: readonly ProductOptionSetChoice[];
  /** The dish's choice groups and, per option, its price (dollars) — published or waiting. */
  readonly chosen: ReadonlyMap<string, ReadonlyMap<string, string>>;
}
const object = (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
/** The product read (detail, or the list for a new dish) and the choice prices, for the editor. */
export function dishEditorSource(
  productReference: string | null,
  loaded: { readonly product: unknown; readonly optionPrices: unknown },
): DishEditorSource {
  const view = object(loaded.product);
  if (view === null || !Array.isArray(view.taxClasses)) throw new MenuPageError("Unavailable");
  const product = object(view.product);
  const groups = (Array.isArray(view.optionSetChoices) ? view.optionSetChoices : []).filter(
    (g: ProductOptionSetChoice) => !g.archived,
  ) as ProductOptionSetChoice[];
  const prices = new Map<string, string>();
  const optionView = object(loaded.optionPrices);
  for (const p of Array.isArray(optionView?.products) ? optionView.products : [])
    if (object(p)?.productReference === productReference)
      for (const set of (p as { optionSets: { options: Record<string, unknown>[] }[] }).optionSets)
        for (const o of set.options) {
          const pending = object(o.pending)?.priceMinor;
          const minor = typeof pending === "string" ? pending : o.priceMinor;
          if (typeof minor === "string")
            prices.set(String(o.optionReference), minorToDollars(minor));
        }
  const chosen = new Map<string, Map<string, string>>();
  if (product !== null)
    for (const set of (product.optionSets ?? []) as {
      optionSetReference: string;
      enabledOptionReferences: string[];
    }[])
      chosen.set(
        set.optionSetReference,
        new Map(set.enabledOptionReferences.map((o) => [o, prices.get(o) ?? "0.00"])),
      );
  const presentation = object(product?.presentation);
  return {
    name: typeof product?.name === "string" ? product.name : "",
    nameZh: typeof product?.nameZh === "string" ? product.nameZh : "",
    description: typeof presentation?.description === "string" ? presentation.description : "",
    descriptionZh:
      typeof presentation?.descriptionZh === "string" ? presentation.descriptionZh : "",
    taxClassificationReference:
      typeof product?.taxClassificationReference === "string"
        ? product.taxClassificationReference
        : null,
    sizes: Array.isArray(product?.sizes) ? product.sizes.length : 1,
    taxClasses: view.taxClasses as ProductTaxClass[],
    groups,
    chosen,
  };
}

/**
 * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU (Owner 2026-10-28 decisions 7–8): one dish edited on the
 * one-page menu — English and Chinese names and descriptions, price, tax class, section, choice
 * groups with each choice's price, and its allergens (declared by staff). Saving keeps everything
 * waiting; guests see it when the menu is listed. A new dish is the same form, empty.
 */
export function DishEditor({
  menuReference,
  dish,
  sections,
  sectionCode,
  allergenChoices,
  keepsStock,
  client,
  onSaved,
  onClose,
}: {
  readonly menuReference: string;
  /** null: a new dish. */
  readonly dish: MenuDish | null;
  readonly sections: readonly MenuSectionRow[];
  readonly sectionCode: string;
  readonly allergenChoices: readonly AllergenChoice[];
  /** The store keeps stock: declared allergens should become a real recipe. */
  readonly keepsStock: boolean;
  readonly client: MenuClient;
  readonly onSaved: (message: string) => void;
  readonly onClose: () => void;
}) {
  const productReference = dish?.productReference ?? null;
  const [source, setSource] = useState<DishEditorSource | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    nameZh: "",
    description: "",
    descriptionZh: "",
    price: dish?.priceMinor ? minorToDollars(dish.pendingPriceMinor ?? dish.priceMinor) : "",
    tax: "",
    section: sectionCode,
  });
  const [chosen, setChosen] = useState<ReadonlyMap<string, ReadonlyMap<string, string>>>(new Map());
  const [allergens, setAllergens] = useState<ReadonlyMap<string, AllergenAnswer>>(
    () =>
      new Map((dish?.allergens.declared ?? []).map((a) => [a.allergenReference, a.classification])),
  );
  // Allergens are declared only when staff confirm the list is complete (or change it).
  const [allergensChecked, setAllergensChecked] = useState(
    dish?.allergens.source === "StaffDeclared",
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [makingGroup, setMakingGroup] = useState(false);
  /** After a group is made here: read the groups again (what staff typed stays) and choose it. */
  const groupMade = async (optionSetReference: string | null) => {
    setMakingGroup(false);
    if (client.loadDish === undefined) return;
    try {
      const found = dishEditorSource(productReference, await client.loadDish(productReference));
      setSource((current) => (current === null ? found : { ...current, groups: found.groups }));
      const group = found.groups.find((g) => g.optionSetReference === optionSetReference);
      if (group !== undefined)
        setChosen((current) =>
          new Map(current).set(
            group.optionSetReference,
            new Map(group.options.filter((o) => o.offered).map((o) => [o.optionReference, "0.00"])),
          ),
        );
    } catch {
      setProblem(t("The dish could not be read. Check the connection and try again."));
    }
  };
  // One reference per intended save, kept until it is answered (a retry continues it).
  const [operation, setOperation] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (client.loadDish === undefined) return;
    void client
      .loadDish(productReference)
      .then((loaded) => {
        if (!active) return;
        const found = dishEditorSource(productReference, loaded);
        setSource(found);
        setChosen(found.chosen);
        setForm((current) => ({
          ...current,
          name: found.name,
          nameZh: found.nameZh,
          description: found.description,
          descriptionZh: found.descriptionZh,
          tax:
            found.taxClassificationReference ??
            found.taxClasses[0]?.taxClassificationReference ??
            "",
        }));
      })
      .catch(() => {
        if (active) setFailed(t("The dish could not be read. Check the connection and try again."));
      });
    return () => {
      active = false;
    };
  }, [client, productReference]);
  const label =
    dish === null ? t("New dish") : dish.nameZh ? `${dish.name} ${dish.nameZh}` : dish.name;
  const recipeAllergens = dish?.allergens.source === "Recipe";
  const priceMinor = dollarsToMinor(form.price);
  const choicePrices = useMemo(
    () =>
      [...chosen].map(([optionSetReference, options]) => ({
        optionSetReference,
        options: [...options].map(([optionReference, dollars]) => ({
          optionReference,
          amountMinor: dollarsToMinor(dollars),
        })),
      })),
    [chosen],
  );
  const invalid =
    form.name.trim() === "" ||
    priceMinor === null ||
    form.tax === "" ||
    choicePrices.some(
      (g) => g.options.length === 0 || g.options.some((o) => o.amountMinor === null),
    );
  if (failed !== null)
    return (
      <div className="dish-editor" role="group" aria-label={label}>
        <p role="alert">{failed}</p>
        <button type="button" onClick={onClose}>
          {t("Close")}
        </button>
      </div>
    );
  if (source === null)
    return (
      <p className="dish-editor" role="status">
        {t("Reading the dish…")}
      </p>
    );
  if (source.sizes !== 1)
    return (
      <div className="dish-editor" role="group" aria-label={label}>
        <p>{menuErrorText.ManySizes}</p>
        <button type="button" onClick={onClose}>
          {t("Close")}
        </button>
      </div>
    );
  const save = async () => {
    if (client.oneStore === undefined || busy || invalid || priceMinor === null) return;
    setBusy(true);
    setProblem(null);
    const reference = operation ?? newOperationReference();
    setOperation(reference);
    const command: SaveDishCommand = {
      action: "SaveDish",
      operationReference: reference,
      menuReference,
      productReference,
      sectionCode: form.section,
      name: form.name.trim(),
      nameZh: form.nameZh.trim(),
      description: form.description.trim(),
      descriptionZh: form.descriptionZh.trim(),
      taxClassificationReference: form.tax,
      priceMinor,
      choiceGroups: choicePrices.map((g) => ({
        optionSetReference: g.optionSetReference,
        options: g.options.map((o) => ({
          optionReference: o.optionReference,
          amountMinor: o.amountMinor ?? "0",
        })),
      })),
      allergens:
        recipeAllergens || !allergensChecked
          ? null
          : [...allergens]
              .filter((entry): entry is [string, AllergenClassification] => entry[1] !== "None")
              .map(([allergenReference, classification]) => ({
                allergenReference,
                classification,
              })),
    };
    try {
      await client.oneStore(command);
      setOperation(null);
      onSaved(t("{item} saved. Guests see it when the menu is listed.", { item: command.name }));
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
  const field = (key: keyof typeof form, text: string, extra: Record<string, unknown> = {}) => (
    <label className="dish-editor__field">
      <span>{text}</span>
      <input
        value={form[key]}
        onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
        {...extra}
      />
    </label>
  );
  return (
    <form
      className="dish-editor"
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="dish-editor__grid">
        {field("name", t("English name"), { required: true, maxLength: 80 })}
        {field("nameZh", t("Chinese name"), { maxLength: 80, lang: "zh-Hans" })}
        {field("description", t("English description"), { maxLength: 240 })}
        {field("descriptionZh", t("Chinese description"), { maxLength: 240, lang: "zh-Hans" })}
        {field("price", t("Price ($)"), {
          inputMode: "decimal",
          required: true,
          placeholder: "12.88",
        })}
        <label className="dish-editor__field">
          <span>{t("Tax class")}</span>
          <select
            value={form.tax}
            required
            onChange={(event) => setForm((current) => ({ ...current, tax: event.target.value }))}
          >
            {source.taxClasses.map((choice, index) => (
              <option
                key={choice.taxClassificationReference}
                value={choice.taxClassificationReference}
              >
                {t("Tax class {value} — {choice}", {
                  value: index + 1,
                  choice: taxClassText(choice),
                })}
              </option>
            ))}
          </select>
        </label>
        <label className="dish-editor__field">
          <span>{t("Section")}</span>
          <select
            value={form.section}
            onChange={(event) =>
              setForm((current) => ({ ...current, section: event.target.value }))
            }
          >
            {sections.map((section) => (
              <option key={section.code} value={section.code}>
                {section.nameZh ? `${section.name} ${section.nameZh}` : section.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {priceMinor === null && form.price.trim() !== "" ? (
        <p className="dish-editor__problem">{t("Enter the price like 12.88.")}</p>
      ) : null}
      <fieldset>
        <legend>{t("Choice groups")}</legend>
        {source.groups.length === 0 ? (
          <p className="dish-editor__note">{t("No choice groups yet.")}</p>
        ) : null}
        {source.groups.map((group) => {
          const options = chosen.get(group.optionSetReference);
          return (
            <div key={group.optionSetReference} className="dish-editor__group">
              <label>
                <input
                  type="checkbox"
                  checked={options !== undefined}
                  onChange={(event) =>
                    setChosen((current) => {
                      const next = new Map(current);
                      if (event.target.checked)
                        next.set(
                          group.optionSetReference,
                          new Map(
                            group.options
                              .filter((o) => o.offered)
                              .map((o) => [o.optionReference, "0.00"]),
                          ),
                        );
                      else next.delete(group.optionSetReference);
                      return next;
                    })
                  }
                />
                {group.name}
              </label>
              {options !== undefined ? (
                <ul className="dish-editor__choices">
                  {group.options
                    .filter((o) => o.offered)
                    .map((option) => (
                      <li key={option.optionReference}>
                        <label>
                          <input
                            type="checkbox"
                            checked={options.has(option.optionReference)}
                            onChange={(event) =>
                              setChosen((current) => {
                                const next = new Map(current);
                                const set = new Map(next.get(group.optionSetReference) ?? []);
                                if (event.target.checked) set.set(option.optionReference, "0.00");
                                else set.delete(option.optionReference);
                                next.set(group.optionSetReference, set);
                                return next;
                              })
                            }
                          />
                          {option.name}
                        </label>
                        {options.has(option.optionReference) ? (
                          <label className="dish-editor__choice-price">
                            <span>{t("Extra ($) for {choice}", { choice: option.name })}</span>
                            <input
                              inputMode="decimal"
                              value={options.get(option.optionReference) ?? ""}
                              onChange={(event) =>
                                setChosen((current) => {
                                  const next = new Map(current);
                                  const set = new Map(next.get(group.optionSetReference) ?? []);
                                  set.set(option.optionReference, event.target.value);
                                  next.set(group.optionSetReference, set);
                                  return next;
                                })
                              }
                            />
                          </label>
                        ) : null}
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>
          );
        })}
        {client.createChoiceGroup === undefined ? (
          <p className="dish-editor__note">
            <Link to="/app/commerce/option-sets">{t("Add choice groups")}</Link>
          </p>
        ) : makingGroup ? (
          <NewChoiceGroupForm
            client={client}
            onCreated={(reference) => void groupMade(reference)}
            onClose={() => setMakingGroup(false)}
          />
        ) : (
          <div className="dish-editor__actions">
            <button type="button" onClick={() => setMakingGroup(true)}>
              {t("New choice group")}
            </button>
          </div>
        )}
      </fieldset>
      <fieldset>
        <legend>{t("Allergens declared by staff")}</legend>
        {recipeAllergens ? (
          <p className="dish-editor__note">
            {t("This dish has a recipe, so its allergens come from the recipe's ingredients.")}{" "}
            <Link to="/app/commerce/recipes">{t("Open recipes")}</Link>
          </p>
        ) : allergenChoices.length === 0 ? (
          <p className="dish-editor__note">{menuErrorText.RegistryMissing}</p>
        ) : (
          <>
            <p className="dish-editor__note">
              {t(
                "Not a costed recipe and not used for stock. Mark each allergen the dish contains or may contain.",
              )}
            </p>
            {keepsStock && dish?.allergens.source === "StaffDeclared" ? (
              <p className="dish-editor__note" role="note">
                {t(
                  "This store keeps stock and recipes. Replace these declared allergens with a real recipe for this dish.",
                )}{" "}
                <Link to="/app/commerce/recipes">{t("Open recipes")}</Link>
              </p>
            ) : null}
            <AllergenFields
              fieldKey={dish?.skuReference ?? "new"}
              choices={allergenChoices}
              values={allergens}
              onChange={(allergen, next) => {
                setAllergens((current) => new Map(current).set(allergen, next));
                setAllergensChecked(true);
              }}
            />
            <label className="dish-editor__confirm">
              <input
                type="checkbox"
                checked={allergensChecked}
                onChange={(event) => setAllergensChecked(event.target.checked)}
              />
              {t("I checked every allergen of this dish.")}
            </label>
          </>
        )}
      </fieldset>
      {/* WP-2423 item 8 ⑦: a dish the kitchen does not prepare (saved on its own). */}
      <DishKitchenMark productReference={productReference} client={client} />
      {problem ? (
        <p className="dish-editor__problem" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="dish-editor__actions">
        <button type="submit" className="one-menu__primary" disabled={busy || invalid}>
          {busy ? t("Saving…") : t("Save dish")}
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          {t("Close")}
        </button>
      </div>
    </form>
  );
}
