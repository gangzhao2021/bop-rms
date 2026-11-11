import { allergenName, listSeparator, t } from "./i18n/i18n.js";
import { MenuSectionSelect } from "./MenuSectionSelect.js";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { ChoiceGroupApply } from "./ChoiceGroupApply.js";
import {
  AllergenFields,
  allergenFormSummary,
  everyAllergenAnswer,
  startingAllergenAnswers,
  unansweredAllergens,
  type AllergenAnswer,
} from "./dish-allergens.js";
import { applySections } from "./dish-choice-apply.js";
import {
  copiedChoices,
  dishEditorSource,
  groupStart,
  typedExtras,
  type DishEditorSource,
  type TypedChoice,
} from "./dish-editor-source.js";
import { applyDishMarks, noDishMarks, readDishMarks, type DishMarks } from "./dish-marks.js";
import { DishAlcoholMark } from "./DishAlcoholMark.js";
import { DishKitchenMark } from "./DishKitchenMark.js";
import { composingEnter } from "./form-enter.js";
import { NewChoiceGroupForm } from "./NewChoiceGroupForm.js";
import { newOperationReference } from "./operation-reference.js";
import type { MenuDish, MenuSectionRow } from "./one-store-menu.js";
import { taxClassText, type ProductOptionSetChoice } from "./product-pages.js";
import { dollarsToMinor, minorToDollars } from "./store-price-pages.js";
import { menuErrorText } from "./StoreMenuPages.js";
import {
  DishPriceScope,
  expectedFor,
  parseSavedPrice,
  priceBasisOf,
  priceScopeChoices,
  shownPrice,
  singleStorePrice,
  type DishPriceScopes,
  type PriceBasis,
} from "./dish-price-scope.js";
import {
  MenuPageError,
  type AllergenChoice,
  type AllergenClassification,
  type MenuClient,
  type SaveDishCommand,
} from "./store-menu-pages.js";
import {
  formChangedAfterStopText,
  oneStoreSaveFailureText,
  oneStoreSaveMayContinue,
} from "./one-store-save-words.js";

/** A save asked to go on under an operation that stopped, with different content. */
class FormChangedAfterStop extends Error {
  constructor() {
    super("FORM_CHANGED_AFTER_STOP");
    this.name = "FormChangedAfterStop";
  }
}
const dishLabel = (dish: Pick<MenuDish, "name" | "nameZh">) =>
  dish.nameZh ? `${dish.name} ${dish.nameZh}` : dish.name;

/** A group's ticked choices on one line, every extra shown (+0.00 too: a free topping is seen). */
const carriedLine = (group: ProductOptionSetChoice, options: ReadonlyMap<string, string>) =>
  group.options
    .filter((o) => options.has(o.optionReference))
    .map((o) => `${o.name} +${options.get(o.optionReference) ?? ""}`)
    .join(t(", "));

/**
 * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU (Owner 2026-10-28 decisions 7–8): one dish edited on the
 * one-page menu — English and Chinese names and descriptions, price, tax class, section, choice
 * groups with each choice's price, and its allergens (declared by staff). Saving keeps everything
 * waiting; guests see it when the menu is listed. A new dish is the same form, empty, or (item 3)
 * copied from another dish, or carried on from the one just saved: after the first drink, each next
 * one is its names, its price and one allergen tick.
 */
export function DishEditor({
  menuReference,
  dish,
  sections,
  sectionCode,
  allergenChoices,
  keepsStock,
  client,
  isCombo = () => false,
  lastSaved = null,
  openApply = null,
  priceScopes = singleStorePrice,
  onSaved,
  onSavedKeepOpen,
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
  readonly isCombo?: (skuReference: string) => boolean;
  /** The dish saved last on this page: it heads the "Same as" list. */
  readonly lastSaved?: string | null;
  /** Arrived from a group's new choice: tick it here and open "Use on other dishes". */
  readonly openApply?: {
    readonly optionSetReference: string;
    readonly optionReferences: readonly string[];
  } | null;
  /** WP-2423 M70: where this person may change a dish's price (one Store: the one price). */
  readonly priceScopes?: DishPriceScopes;
  readonly onSaved: (message: string, productReference?: string | null) => void;
  /** "Save and add another": the menu reads again, and this form stays. */
  readonly onSavedKeepOpen?: (productReference: string | null) => void;
  readonly onClose: () => void;
}) {
  const readReference = dish?.productReference ?? null;
  // A new dish whose save stopped after the dish was made: it goes on as an edit of that dish.
  const [adopted, setAdopted] = useState<string | null>(null);
  const productReference = readReference ?? adopted;
  const [source, setSource] = useState<DishEditorSource | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // WP-2423 M70: the prices the dish has now — the Brand's (or one waiting to be listed) and this
  // Store's own — kept up to date by each save, so a later save compares with what is there.
  const [basis, setBasis] = useState<PriceBasis>(() => priceBasisOf(dish));
  const several = priceScopes.severalStores;
  const [readPrice] = useState(() => {
    const shown = shownPrice(priceBasisOf(dish), several);
    return shown === null ? "" : minorToDollars(shown);
  });
  const [scope, setScope] = useState<"AllStores" | "ThisStore" | null>(null);
  const [form, setForm] = useState({
    name: "",
    nameZh: "",
    description: "",
    descriptionZh: "",
    price: readPrice,
    tax: "",
    section: sectionCode,
  });
  const [chosen, setChosen] = useState<ReadonlyMap<string, ReadonlyMap<string, string>>>(new Map());
  // WP-2423 (M166): what each choice adds of its own (Contains), as staff answered it here. Only
  // choices answered in this editor are sent; the others keep what they add.
  const [choiceAdds, setChoiceAdds] = useState<ReadonlyMap<string, ReadonlySet<string>>>(
    () =>
      new Map(
        (dish?.allergens.choiceAllergens ?? []).map((answer) => [
          answer.optionKey,
          new Set(answer.declared.map((a) => a.allergenReference)),
        ]),
      ),
  );
  const [choiceAnswered, setChoiceAnswered] = useState<ReadonlySet<string>>(new Set());
  // WP-2423 (M76): a new dish starts with every allergen unanswered; a declared one, as declared.
  const [allergens, setAllergens] = useState<ReadonlyMap<string, AllergenAnswer>>(() =>
    startingAllergenAnswers(dish?.allergens, allergenChoices),
  );
  // Allergens are declared only when staff confirm the list is complete (or change it).
  const [allergensChecked, setAllergensChecked] = useState(
    dish?.allergens.source === "StaffDeclared",
  );
  // WP-2423 item 8 ⑦ (v15 2026-10-29): a food with its allergens, or a charge with no stock
  // ingredients such as the per-head tea. A dish declared one way stays that way (recorded).
  const declaredCharge = dish?.allergens.noIngredients === true;
  const declaredFood = dish?.allergens.source === "StaffDeclared" && !declaredCharge;
  const [charge, setCharge] = useState(declaredCharge);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [makingGroup, setMakingGroup] = useState(false);
  // Item 3 E: a new dish's kitchen section and marks, set right after its first save.
  const [marks, setMarks] = useState<DishMarks>(noDishMarks);
  const changeMarks = (change: Partial<DishMarks>) =>
    setMarks((current) => ({ ...current, ...change }));
  // Item 3 B and C: the form came from another dish, so the lists fold and only the tick confirms.
  const [carried, setCarried] = useState(false);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  const [allergensOpen, setAllergensOpen] = useState(false);
  const [marksOpen, setMarksOpen] = useState(false);
  const [descriptionsOpen, setDescriptionsOpen] = useState(false);
  const [copiedFrom, setCopiedFrom] = useState("");
  const [copying, setCopying] = useState(false);
  // What the last save did, shown above the English name, where the owner goes on typing.
  const [note, setNote] = useState<string | null>(null);
  const [added, setAdded] = useState({ dishes: 0, needAllergens: 0 });
  // Item 3 F: the group whose "Use on other dishes" is open, and whether its run is going.
  const [applying, setApplying] = useState<string | null>(null);
  const [applyRunning, setApplyRunning] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const allergenRows = useRef<HTMLDivElement>(null);
  // Where focus returns once the fields unlock after a save.
  const focusAfter = useRef<HTMLElement | null>(null);
  const focusName = useRef(false);
  // A new run of the name and price fields: an emptied required field is not a mistake yet.
  const [fresh, setFresh] = useState(0);
  useEffect(() => {
    if (busy) return;
    if (focusName.current) nameInput.current?.focus();
    else focusAfter.current?.focus();
    focusName.current = false;
    focusAfter.current = null;
  }, [busy]);
  const startBusy = () => {
    focusAfter.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setBusy(true);
    setProblem(null);
  };
  /** After a group is made here: read the groups again (what staff typed stays) and choose it. */
  const groupMade = async (optionSetReference: string | null, typed: readonly TypedChoice[]) => {
    setMakingGroup(false);
    if (client.loadDish === undefined) return;
    try {
      const found = dishEditorSource(readReference, await client.loadDish(readReference));
      setSource((current) =>
        current === null ? found : { ...current, groups: found.groups, usual: found.usual },
      );
      const group = found.groups.find((g) => g.optionSetReference === optionSetReference);
      if (group !== undefined)
        setChosen((current) =>
          new Map(current).set(
            group.optionSetReference,
            groupStart(group, found.usual, typedExtras(group, typed)),
          ),
        );
    } catch {
      setProblem(t("The dish could not be read. Check the connection and try again."));
    }
  };
  // One reference per intended save, kept until it is answered (a retry continues it).
  const [operation, setOperation] = useState<string | null>(null);
  // WP-2423 M70: a price sent by a save that got no answer may already be the dish's: until a save
  // answers, the price is sent again, compared with that one (a price put back is not lost).
  const [unansweredPrice, setUnansweredPrice] = useState<string | null>(null);
  const sent = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    if (client.loadDish === undefined) return;
    void client
      .loadDish(readReference)
      .then((loaded) => {
        if (!active) return;
        const found = dishEditorSource(readReference, loaded);
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
  }, [client, readReference]);
  // Arrived from a group's new choice (item 3 F): tick it, once, and open the panel.
  const openedApply = useRef(false);
  // The new choice whose extra takes focus once it is on the form.
  const focusExtra = useRef<string | null>(null);
  const formElement = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (source === null || openApply === null || openedApply.current) return;
    openedApply.current = true;
    const group = source.groups.find((g) => g.optionSetReference === openApply.optionSetReference);
    if (group === undefined) return;
    setChosen((current) => {
      const options = new Map(current.get(group.optionSetReference) ?? []);
      for (const option of group.options)
        if (
          option.offered &&
          openApply.optionReferences.includes(option.optionReference) &&
          !options.has(option.optionReference)
        )
          options.set(option.optionReference, source.usual.get(option.optionReference) ?? "0.00");
      return new Map(current).set(group.optionSetReference, options);
    });
    setApplying(group.optionSetReference);
    // The new choice's extra is what to look at first, with "Use on other dishes" under it.
    focusExtra.current =
      group.options.find(
        (option) => option.offered && openApply.optionReferences.includes(option.optionReference),
      )?.optionReference ?? null;
  }, [source, openApply]);
  useEffect(() => {
    if (focusExtra.current === null) return;
    const extra = formElement.current?.querySelector<HTMLInputElement>(
      `input[data-extra="${focusExtra.current}"]`,
    );
    if (extra === null || extra === undefined) return;
    focusExtra.current = null;
    extra.scrollIntoView({ block: "center" });
    extra.focus({ preventScroll: true });
  });
  const label =
    dish === null ? t("New dish") : dish.nameZh ? `${dish.name} ${dish.nameZh}` : dish.name;
  const recipeAllergens = dish?.allergens.source === "Recipe";
  const priceMinor = dollarsToMinor(form.price);
  // WP-2423 M70: a price is sent only when it differs from what the dish has now, with where it
  // changes. A new dish's first price is for every Store; at one Store there is one price.
  const priceEdited =
    dish === null || unansweredPrice !== null || priceMinor !== shownPrice(basis, several);
  const scopes = priceScopeChoices(priceScopes, basis, dish === null && adopted === null);
  const chosenScope: "AllStores" | "ThisStore" | null = !priceEdited
    ? null
    : scopes.length === 1
      ? (scopes[0] ?? null)
      : scope !== null && scopes.includes(scope)
        ? scope
        : null;
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
  // WP-2423 (M76, Owner decision 16): a food dish starts with every allergen unanswered and saves
  // only once each one is answered (Contains, May contain or No) and confirmed, so no row is ever
  // taken as No unread and no dish is saved with its allergens left for later.
  const unanswered = unansweredAllergens(allergens, allergenChoices);
  const allergensOutstanding =
    !recipeAllergens &&
    !charge &&
    allergenChoices.length > 0 &&
    (unanswered > 0 || !allergensChecked);
  const invalid =
    allergensOutstanding ||
    form.name.trim() === "" ||
    form.section === "" ||
    priceMinor === null ||
    form.tax === "" ||
    (priceEdited && chosenScope === null) ||
    choicePrices.some(
      (g) => g.options.length === 0 || g.options.some((o) => o.amountMinor === null),
    );
  // What "Save dish" records (all but its operation reference), with these allergen values.
  const dishContent = (
    allergenValues: ReadonlyMap<string, AllergenAnswer> = allergens,
  ): Omit<SaveDishCommand, "operationReference"> => ({
    action: "SaveDish",
    menuReference,
    productReference,
    sectionCode: form.section,
    name: form.name.trim(),
    nameZh: form.nameZh.trim(),
    description: form.description.trim(),
    descriptionZh: form.descriptionZh.trim(),
    taxClassificationReference: form.tax,
    // Only when it was edited, with where it changes and the price seen for that scope: sending
    // the shown price back would undo a newer one, or write this Store's price for every Store.
    priceMinor: priceEdited ? (priceMinor ?? "0") : null,
    priceScope: priceEdited ? (chosenScope ?? "AllStores") : null,
    expectedPriceMinor:
      priceEdited && dish !== null
        ? (unansweredPrice ?? expectedFor(basis, chosenScope ?? "AllStores"))
        : null,
    choiceGroups: choicePrices.map((g) => ({
      optionSetReference: g.optionSetReference,
      options: g.options.map((o) => ({
        optionReference: o.optionReference,
        amountMinor: o.amountMinor ?? "0",
      })),
    })),
    // WP-2423 (M166): the choices answered here, among those the dish keeps.
    ...((answers) => (answers.length === 0 ? {} : { choiceAllergens: answers }))(
      choicePrices.flatMap((g) =>
        g.options
          .filter((o) => choiceAnswered.has(o.optionReference))
          .map((o) => ({
            optionReference: o.optionReference,
            name:
              (source?.groups ?? [])
                .flatMap((group) => group.options)
                .find((option) => option.optionReference === o.optionReference)?.name ??
              o.optionReference,
            declared: [...(choiceAdds.get(o.optionReference.slice(-12)) ?? [])].map(
              (allergenReference) => ({
                allergenReference,
                classification: "Contains" as const,
              }),
            ),
          })),
      ),
    ),
    allergens: recipeAllergens
      ? null
      : charge
        ? declaredCharge
          ? null
          : "NoIngredients"
        : !allergensChecked
          ? null
          : everyAllergenAnswer(allergenValues, allergenChoices),
  });
  // v15 2026-10-30: the dish as it was read. Saving it unchanged records nothing, so the menu has
  // no change to list (the kitchen marks and section below save on their own; guests never see
  // them).
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (source !== null && loaded.current === null && dish !== null)
      loaded.current = JSON.stringify(dishContent());
  });
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
  const sendDish = async (
    allergenValues?: ReadonlyMap<string, AllergenAnswer>,
  ): Promise<
    | "Unchanged"
    | {
        readonly productReference: string | null;
        readonly choicesWaiting: boolean;
        readonly name: string;
        /** Saved with no allergens declared (it cannot be listed until they are). */
        readonly undeclared: boolean;
      }
  > => {
    const content = dishContent(allergenValues);
    if (client.oneStore === undefined) throw new MenuPageError("Unavailable");
    if (loaded.current !== null && JSON.stringify(content) === loaded.current) return "Unchanged";
    // WP-2423 item 10: a save that stopped goes again as the same operation, so it finishes rather
    // than making a second product. Different content must not go under it.
    const fingerprint = JSON.stringify(content);
    if (operation !== null && sent.current !== fingerprint) throw new FormChangedAfterStop();
    sent.current = fingerprint;
    const reference = operation ?? newOperationReference();
    setOperation(reference);
    if (content.priceMinor !== null && dish !== null) setUnansweredPrice(content.priceMinor);
    const result = (await client.oneStore({ ...content, operationReference: reference })) as {
      productReference?: unknown;
      choicesWaiting?: unknown;
      price?: unknown;
    } | null;
    setOperation(null);
    // WP-2423 M70: what the dish's prices are now, as the save left them: the next save compares
    // with these, not with what the page read when it opened.
    const after = parseSavedPrice(result?.price);
    if (after !== null) setBasis(after);
    setUnansweredPrice(null);
    // Saved: what is on the form is now what the dish is.
    if (loaded.current !== null) loaded.current = JSON.stringify(content);
    return {
      productReference:
        typeof result?.productReference === "string" ? result.productReference : productReference,
      choicesWaiting: result?.choicesWaiting === true,
      name: content.name,
      undeclared:
        content.allergens === null &&
        !recipeAllergens &&
        dish?.allergens.source !== "StaffDeclared",
    };
  };
  const saveFailed = (error: unknown) => {
    if (error instanceof FormChangedAfterStop) {
      setProblem(formChangedAfterStopText);
      return;
    }
    const known = error instanceof MenuPageError ? error : null;
    const exists = known !== null && known.productReference !== null;
    // No answer, or a save that stopped (WP-2423 item 10): the same save is tried again as the same
    // operation. A dish the server says now exists goes on as an edit with a fresh operation (a
    // reused one would replay its steps and quietly ignore a corrected price), and nothing makes a
    // second copy of it.
    if (exists || !oneStoreSaveMayContinue(error)) setOperation(null);
    if (exists) setAdopted(known.productReference);
    setProblem(oneStoreSaveFailureText(error, productReference !== null || exists));
  };
  // The result of a save in the owner's words, including a mark that could not be set.
  const savedText = (
    result: { name: string; choicesWaiting: boolean; undeclared: boolean },
    notSet: readonly string[],
  ) =>
    [
      result.choicesWaiting || result.undeclared
        ? t("{item} saved. Declare its allergens, then list it.", { item: result.name })
        : t("{item} saved. Guests see it when the menu is listed.", { item: result.name }),
      notSet.length > 0
        ? t("{marks} could not be set. Open the dish with Edit and set it.", {
            marks: notSet.join(t(", ")),
          })
        : "",
    ]
      .filter(Boolean)
      .join(" ");
  const marksOf = async (product: string | null) =>
    dish === null && product !== null ? applyDishMarks(client, product, marks) : [];
  const save = async () => {
    if (client.oneStore === undefined || busy || invalid || priceMinor === null) return;
    startBusy();
    try {
      const result = await sendDish();
      if (result === "Unchanged") {
        onSaved(
          t("Nothing in {item} changed; there is nothing new to list.", { item: form.name.trim() }),
        );
        return;
      }
      onSaved(savedText(result, await marksOf(result.productReference)), result.productReference);
    } catch (error) {
      saveFailed(error);
    } finally {
      setBusy(false);
    }
  };
  // Item 3 C: the next drink goes on from this one. Only a dish whose allergens were looked at (or
  // a fee, or a Brand with no allergen list yet), or an undeclared run would surface only at List it.
  const nextAllowed =
    (allergensChecked && unanswered === 0) || charge || allergenChoices.length === 0;
  const saveAndAddAnother = async () => {
    if (client.oneStore === undefined || busy || invalid || priceMinor === null) return;
    if (dish !== null || !nextAllowed) return;
    startBusy();
    try {
      const result = await sendDish();
      if (result === "Unchanged") return;
      const notSet = await marksOf(result.productReference);
      const count = {
        dishes: added.dishes + 1,
        needAllergens: added.needAllergens + (result.undeclared || result.choicesWaiting ? 1 : 0),
      };
      setAdded(count);
      setNote(
        [
          savedText(result, notSet),
          t("Added {count}.", { count: count.dishes }),
          count.needAllergens === 0
            ? ""
            : count.needAllergens === 1
              ? t("1 needs allergens.")
              : t("{count} need allergens.", { count: count.needAllergens }),
        ]
          .filter(Boolean)
          .join(" "),
      );
      // Everything stays but the names, descriptions, price and tick. A fee is never carried on: it
      // cannot be undone, and the next item must be asked for its allergens.
      setForm((current) => ({
        ...current,
        name: "",
        nameZh: "",
        description: "",
        descriptionZh: "",
        price: "",
      }));
      setAllergensChecked(false);
      setCharge(false);
      setAdopted(null);
      // The next dish is new: no price of its own yet.
      setBasis(priceBasisOf(null));
      setScope(null);
      setCarried(true);
      setOpenGroups(new Set());
      setAllergensOpen(false);
      setMarksOpen(false);
      setDescriptionsOpen(false);
      setCopiedFrom("");
      focusName.current = true;
      setFresh((current) => current + 1);
      onSavedKeepOpen?.(result.productReference);
      // New usual extras: what this dish set is what the next group starts from.
      if (client.loadDish !== undefined)
        void client
          .loadDish(null)
          .then((read) => {
            const found = dishEditorSource(null, read);
            setSource((current) =>
              current === null ? found : { ...current, groups: found.groups, usual: found.usual },
            );
          })
          .catch(() => undefined);
    } catch (error) {
      saveFailed(error);
    } finally {
      setBusy(false);
    }
  };
  // Item 3 B: a new dish starts from another. Its allergens are copied but not confirmed.
  const copyFrom = async (product: string) => {
    setCopiedFrom(product);
    if (product === "") {
      // Start empty: what a copy brought goes; what was typed (names, price) stays.
      setChosen(new Map());
      setAllergens(new Map());
      setAllergensChecked(false);
      setCharge(false);
      setMarks(noDishMarks);
      setCarried(false);
      setOpenGroups(new Set());
      setAllergensOpen(false);
      setMarksOpen(false);
      setNote(null);
      setForm((current) => ({
        ...current,
        tax: source?.taxClasses[0]?.taxClassificationReference ?? current.tax,
        section: sectionCode,
      }));
      return;
    }
    if (client.loadDish === undefined) return;
    const target = sections
      .flatMap((row) => row.dishes)
      .find((row) => row.productReference === product);
    if (target === undefined) return;
    setCopying(true);
    setProblem(null);
    setNote(null);
    try {
      const found = dishEditorSource(product, await client.loadDish(product));
      setSource((current) =>
        current === null ? found : { ...current, groups: found.groups, usual: found.usual },
      );
      setChosen(copiedChoices(found));
      const placed = sections.find((row) =>
        row.dishes.some((other) => other.skuReference === target.skuReference),
      );
      setForm((current) => ({
        ...current,
        tax: found.taxClassificationReference ?? current.tax,
        section: placed?.code ?? current.section,
      }));
      setAllergens(startingAllergenAnswers(target.allergens, allergenChoices));
      setAllergensChecked(false);
      setCharge(false);
      setCarried(true);
      setOpenGroups(new Set());
      setAllergensOpen(false);
      setMarksOpen(false);
      setDescriptionsOpen(false);
      setNote(
        t(
          "Copied from {item}: its choices, extras, allergens and kitchen marks. Enter the names and price, then check the allergens.",
          { item: target.name },
        ),
      );
      setMarks(await readDishMarks(client, product));
    } catch {
      setProblem(t("The dish could not be read. Check the connection and try again."));
    } finally {
      setCopying(false);
    }
  };
  // Item 3 F: the run saves the dish on screen first, with the allergens the owner gave for the
  // choices it adds (as every other dish that declares its own). The panel shows any failure.
  const saveThisDish = async (
    additions: ReadonlyMap<string, AllergenClassification>,
  ): Promise<"Unchanged" | "Saved" | "Waiting"> => {
    let values: ReadonlyMap<string, AllergenAnswer> | undefined;
    if (additions.size > 0 && allergensChecked && !charge && !recipeAllergens) {
      const merged = new Map(allergens);
      for (const [allergen, classification] of additions)
        if (merged.get(allergen) !== "Contains") merged.set(allergen, classification);
      values = merged;
      setAllergens(merged);
    }
    try {
      const result = await sendDish(values);
      if (result === "Unchanged") return "Unchanged";
      return result.undeclared || result.choicesWaiting ? "Waiting" : "Saved";
    } catch (error) {
      if (!(error instanceof FormChangedAfterStop) && !oneStoreSaveMayContinue(error))
        setOperation(null);
      throw error;
    }
  };
  /**
   * Enter saves only from the names and price. In an extra it moves to the next extra, so an owner
   * typing "Pudding 1.20, Enter" does not save seven toppings at their starting price; anywhere
   * else on the form it does nothing. Enter committing pinyin belongs to the input method.
   */
  const onEnter = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Enter" || composingEnter(event)) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    event.preventDefault();
    if (target.dataset.saves !== undefined) {
      if (carried && dish === null) void saveAndAddAnother();
      else void save();
      return;
    }
    if (target.dataset.extra !== undefined) {
      const extras = [
        ...event.currentTarget.querySelectorAll<HTMLInputElement>("input[data-extra]"),
      ];
      extras[extras.indexOf(target) + 1]?.focus();
    }
  };
  const field = (key: keyof typeof form, text: string, extra: Record<string, unknown> = {}) => (
    <label key={`${key}-${fresh}`} className="dish-editor__field">
      <span>{text}</span>
      <input
        value={form[key]}
        onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
        {...extra}
      />
    </label>
  );
  const addingMore = carried && dish === null;
  const mayApply =
    dish !== null &&
    !keepsStock &&
    client.oneStore !== undefined &&
    client.loadChoicePrices !== undefined;
  // Item 3 B: last saved first, then by section, with both names. A fee is never copied, nor a dish
  // with sizes (this form can't hold them); a combo is not a dish.
  const copySources = applySections(sections, isCombo, null);
  const lastDish =
    lastSaved === null
      ? undefined
      : copySources.flatMap((row) => row.dishes).find((row) => row.productReference === lastSaved);
  const declaresHere = !recipeAllergens && allergenChoices.length > 0 && !charge;
  // A carried form asks for names, price and one tick; the rest folds to a line that can be opened.
  const showDescriptions =
    !carried || descriptionsOpen || form.description !== "" || form.descriptionZh !== "";
  const foldMarks = carried && dish === null && !marksOpen;
  return (
    <form
      ref={formElement}
      className="dish-editor"
      aria-label={label}
      onKeyDown={onEnter}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {/* Locked while saving, so what a fast typer starts next isn't cleared with the saved dish. */}
      <fieldset className="dish-editor__lock" disabled={busy || applyRunning}>
        {note !== null ? (
          <p className="dish-editor__result" role="status">
            {note}
          </p>
        ) : null}
        <div className="dish-editor__grid">
          {dish === null && copySources.length > 0 ? (
            <label className="dish-editor__field">
              <span>{t("Same as")}</span>
              <select
                value={copiedFrom}
                disabled={copying}
                onChange={(event) => void copyFrom(event.target.value)}
              >
                <option value="">{t("Start empty")}</option>
                {lastDish !== undefined ? (
                  <optgroup label={t("Last saved")}>
                    <option value={lastDish.productReference ?? ""}>{dishLabel(lastDish)}</option>
                  </optgroup>
                ) : null}
                {copySources.map((row) => (
                  <optgroup
                    key={row.code}
                    label={row.nameZh ? `${row.name} ${row.nameZh}` : row.name}
                  >
                    {row.dishes
                      .filter((other) => other.productReference !== lastDish?.productReference)
                      .map((other) => (
                        <option key={other.skuReference} value={other.productReference ?? ""}>
                          {dishLabel(other)}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </label>
          ) : null}
          {field("name", t("English name"), {
            required: true,
            maxLength: 80,
            ref: nameInput,
            "data-saves": true,
          })}
          {field("nameZh", t("Chinese name"), {
            maxLength: 80,
            lang: "zh-Hans",
            "data-saves": true,
          })}
          {field("price", several ? t("Price here ($)") : t("Price ($)"), {
            inputMode: "decimal",
            required: true,
            placeholder: "12.88",
            "data-saves": true,
          })}
          {several ? (
            <DishPriceScope
              basis={basis}
              choices={scopes}
              edited={priceEdited && priceMinor !== null}
              chosen={chosenScope}
              onChoose={setScope}
            />
          ) : null}
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
          <MenuSectionSelect
            value={form.section}
            sections={sections}
            onChange={(section) => setForm((current) => ({ ...current, section }))}
          />
          {showDescriptions ? (
            <>
              {field("description", t("English description"), { maxLength: 240 })}
              {field("descriptionZh", t("Chinese description"), {
                maxLength: 240,
                lang: "zh-Hans",
              })}
            </>
          ) : null}
        </div>
        {showDescriptions ? null : (
          <p className="dish-editor__carried dish-editor__carried--mark">
            <button type="button" onClick={() => setDescriptionsOpen(true)}>
              {t("Add descriptions")}
            </button>
          </p>
        )}
        {priceMinor === null && form.price.trim() !== "" ? (
          <p className="dish-editor__problem">{t("Enter the price like 12.88.")}</p>
        ) : null}
        {choicePrices.some((g) => g.options.some((o) => o.amountMinor === null)) ? (
          <p className="dish-editor__problem">
            {t("Type the extra for each ticked choice (0.00 if it is free).")}
          </p>
        ) : null}
        <fieldset>
          <legend>{t("Choice groups")}</legend>
          {source.groups.length === 0 ? (
            <p className="dish-editor__note">{t("No choice groups yet.")}</p>
          ) : null}
          {source.groups.map((group) => {
            const options = chosen.get(group.optionSetReference);
            // A carried form folds to one line per group, with every extra showing.
            if (options !== undefined && carried && !openGroups.has(group.optionSetReference))
              return (
                <div key={group.optionSetReference} className="dish-editor__group">
                  <p className="dish-editor__carried">
                    <span>
                      <strong>{group.name}</strong>: {carriedLine(group, options)}
                    </span>{" "}
                    <button
                      type="button"
                      aria-label={t("Change {group}", { group: group.name })}
                      onClick={() =>
                        setOpenGroups((current) => new Set(current).add(group.optionSetReference))
                      }
                    >
                      {t("Change")}
                    </button>
                  </p>
                </div>
              );
            const noUsualYet =
              options !== undefined &&
              [...options].some(
                ([option, dollars]) => !source.usual.has(option) && dollarsToMinor(dollars) === "0",
              );
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
                            // WP-2423 M25: the dish's own last extras first.
                            groupStart(group, new Map([...source.usual, ...source.last])),
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
                                  // WP-2423 M25: what this dish charged for it, else the
                                  // usual extra; nothing known stays empty to be typed (never
                                  // silently free).
                                  if (event.target.checked)
                                    set.set(
                                      option.optionReference,
                                      source.last.get(option.optionReference) ??
                                        source.usual.get(option.optionReference) ??
                                        "",
                                    );
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
                                data-extra={option.optionReference}
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
                          {options.has(option.optionReference) &&
                          !recipeAllergens &&
                          !charge &&
                          allergenChoices.length > 0 ? (
                            <ChoiceAdds
                              choice={option.name}
                              allergenChoices={allergenChoices}
                              picked={choiceAdds.get(option.optionReference.slice(-12))}
                              onChange={(picked) => {
                                setChoiceAdds((current) =>
                                  new Map(current).set(option.optionReference.slice(-12), picked),
                                );
                                setChoiceAnswered((current) =>
                                  new Set(current).add(option.optionReference),
                                );
                              }}
                            />
                          ) : null}
                        </li>
                      ))}
                  </ul>
                ) : null}
                {noUsualYet ? (
                  <p className="dish-editor__note">
                    {t("No usual price yet: enter it, or leave 0.00 if it is included.")}
                  </p>
                ) : null}
                {options !== undefined && options.size > 0 && mayApply ? (
                  applying === group.optionSetReference ? (
                    <ChoiceGroupApply
                      menuReference={menuReference}
                      group={group}
                      extras={options}
                      read={source.chosen.get(group.optionSetReference)}
                      sections={applySections(sections, isCombo, dish?.skuReference ?? null)}
                      allergenChoices={allergenChoices}
                      client={client}
                      thisDishName={form.name.trim()}
                      thisDishReady={!invalid}
                      saveThisDish={saveThisDish}
                      onRunning={setApplyRunning}
                      onFinished={(message) => onSaved(message)}
                      onClose={() => setApplying(null)}
                    />
                  ) : (
                    <div className="dish-editor__actions">
                      <button
                        type="button"
                        aria-label={t("Use {group} on other dishes", { group: group.name })}
                        onClick={() => setApplying(group.optionSetReference)}
                      >
                        {t("Use on other dishes")}
                      </button>
                    </div>
                  )
                ) : null}
              </div>
            );
          })}
          {dish !== null && keepsStock && chosen.size > 0 ? (
            <p className="dish-editor__note">
              {t(
                "This store keeps stock, so a choice reaches other dishes through its recipe change.",
              )}{" "}
              <Link to="/app/commerce/option-recipes">{t("Open option recipes")}</Link>
            </p>
          ) : null}
          {client.createChoiceGroup === undefined ? (
            <p className="dish-editor__note">
              <Link to="/app/commerce/option-sets">{t("Add choice groups")}</Link>
            </p>
          ) : makingGroup ? (
            <NewChoiceGroupForm
              client={client}
              onCreated={(reference, extras, notice) => {
                if (notice !== undefined) setNote(notice);
                void groupMade(reference, extras);
              }}
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
              {declaredCharge || declaredFood ? null : (
                <div className="dish-editor__kind" role="radiogroup" aria-label={t("What it is")}>
                  <label>
                    <input
                      type="radio"
                      name="dish-kind"
                      checked={!charge}
                      onChange={() => setCharge(false)}
                    />
                    {t("A dish: declare its allergens")}
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="dish-kind"
                      checked={charge}
                      onChange={() => setCharge(true)}
                    />
                    {t(
                      "A fee, not food (tea, corkage, sauce bar): no allergens, never goes to the kitchen",
                    )}
                  </label>
                </div>
              )}
            </>
          )}
          {recipeAllergens || allergenChoices.length === 0 ? null : charge ? (
            <p className="dish-editor__note">
              {t(
                "Declared a charge that uses no stock ingredients (such as tea): it never counts or deducts stock, and guests see no allergens for it.",
              )}
            </p>
          ) : (
            <>
              {!carried || allergensOpen ? (
                <p className="dish-editor__note">
                  {t(
                    "Not a costed recipe and not used for stock. Mark each allergen the dish contains or may contain.",
                  )}
                </p>
              ) : null}
              {keepsStock && dish?.allergens.source === "StaffDeclared" ? (
                <p className="dish-editor__note" role="note">
                  {t(
                    "This store keeps stock and recipes. Replace these declared allergens with a real recipe for this dish.",
                  )}{" "}
                  <Link to="/app/commerce/recipes">{t("Open recipes")}</Link>
                </p>
              ) : null}
              {!carried || allergensOpen ? (
                <div ref={allergenRows}>
                  <AllergenFields
                    fieldKey={dish?.skuReference ?? "new"}
                    choices={allergenChoices}
                    values={allergens}
                    onChange={(allergen, next) => {
                      const answers = new Map(allergens).set(allergen, next);
                      setAllergens(answers);
                      // Copied values are confirmed only by the tick: changing one of them says
                      // nothing about the rest. The last row answered is the list checked.
                      if (!carried && unansweredAllergens(answers, allergenChoices) === 0)
                        setAllergensChecked(true);
                    }}
                  />
                </div>
              ) : null}
            </>
          )}
        </fieldset>
        {/* WP-2423 item 8 ⑦: a dish the kitchen does not prepare. A dish that exists saves it on its
          own; a new one with its first save (item 3 E). */}
        <DishKitchenMark
          productReference={readReference}
          client={client}
          chargeChosen={charge}
          declaredCharge={declaredCharge}
          form={marks}
          onForm={changeMarks}
          {...(foldMarks ? { onUnfold: () => setMarksOpen(true) } : {})}
        />
        {/* WP-2423 DEC-ALCOHOL: a dish that contains alcohol, likewise. */}
        <DishAlcoholMark
          productReference={readReference}
          client={client}
          form={marks}
          onForm={changeMarks}
          {...(foldMarks ? { onUnfold: () => setMarksOpen(true) } : {})}
        />
        {declaresHere ? (
          <div className="dish-editor__check">
            <p className="dish-editor__summary">
              {allergenFormSummary(allergens, allergenChoices)}
              {carried && !allergensOpen ? (
                <>
                  {" "}
                  <button
                    type="button"
                    aria-label={t("Change allergens")}
                    onClick={() => {
                      setAllergensOpen(true);
                      window.requestAnimationFrame(() =>
                        allergenRows.current?.querySelector("input")?.focus(),
                      );
                    }}
                  >
                    {t("Change")}
                  </button>
                </>
              ) : null}
            </p>
            <label className="dish-editor__confirm">
              <input
                type="checkbox"
                checked={allergensChecked && unanswered === 0}
                disabled={unanswered > 0}
                onChange={(event) => setAllergensChecked(event.target.checked)}
              />
              {t("I checked every allergen of this dish.")}
            </label>
            {allergensOutstanding ? (
              <p className="dish-editor__note" role="note">
                {unanswered > 0
                  ? `${t("Answer every allergen to save: {count} left.", { count: unanswered })} ${t("A row left blank is never taken as No.")}`
                  : t("Tick the allergen check to save.")}
              </p>
            ) : null}
          </div>
        ) : null}
        {problem ? (
          <p className="dish-editor__problem" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="dish-editor__actions">
          <button
            type={addingMore ? "button" : "submit"}
            className={addingMore ? undefined : "one-menu__primary"}
            disabled={busy || invalid}
            onClick={addingMore ? () => void save() : undefined}
          >
            {busy ? t("Saving…") : t("Save dish")}
          </button>
          {dish === null && onSavedKeepOpen !== undefined ? (
            <button
              type="button"
              className={addingMore ? "one-menu__primary" : undefined}
              disabled={busy || invalid || !nextAllowed}
              onClick={() => void saveAndAddAnother()}
            >
              {t("Save and add another")}
            </button>
          ) : null}
          <button type="button" disabled={busy || applyRunning} onClick={onClose}>
            {t("Close")}
          </button>
        </div>
        {dish === null && onSavedKeepOpen !== undefined && !nextAllowed ? (
          <p className="dish-editor__note">{t("Check the allergens to add the next one")}</p>
        ) : null}
      </fieldset>
    </form>
  );
}

/**
 * WP-2423 (M166): what one choice adds to the dish's allergens (egg in egg fried rice), ticked
 * from the Brand's list. Folded to one line ("Adds: none" / "Adds: Egg") until opened.
 */
export function ChoiceAdds({
  choice,
  allergenChoices,
  picked,
  onChange,
}: {
  readonly choice: string;
  readonly allergenChoices: readonly AllergenChoice[];
  readonly picked: ReadonlySet<string> | undefined;
  readonly onChange: (picked: ReadonlySet<string>) => void;
}) {
  const named = allergenChoices
    .filter((entry) => picked?.has(entry.allergenReference) === true)
    .map((entry) => allergenName(entry.code ?? "", entry.name));
  return (
    <details className="dish-editor__choice-adds">
      <summary aria-label={t("Allergens {choice} adds", { choice })}>
        {picked === undefined
          ? t("Adds allergens? Not answered")
          : named.length === 0
            ? t("Adds no allergens")
            : t("Adds: {allergens}", { allergens: named.join(listSeparator()) })}
      </summary>
      <div
        className="table-allergies__choices"
        role="group"
        aria-label={t("Allergens {choice} adds", { choice })}
      >
        {allergenChoices.map((entry) => (
          <label key={entry.allergenReference} className="table-allergies__choice">
            <input
              type="checkbox"
              checked={picked?.has(entry.allergenReference) === true}
              onChange={(event) => {
                const next = new Set(picked ?? []);
                if (event.currentTarget.checked) next.add(entry.allergenReference);
                else next.delete(entry.allergenReference);
                onChange(next);
              }}
            />
            <span>{allergenName(entry.code ?? "", entry.name)}</span>
          </label>
        ))}
        <button type="button" onClick={() => onChange(new Set())}>
          {t("Adds none")}
        </button>
      </div>
    </details>
  );
}
