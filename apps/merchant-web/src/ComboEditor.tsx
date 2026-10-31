import { t } from "./i18n/i18n.js";
import { useEffect, useState } from "react";
import { dishEditorSource, type DishEditorSource } from "./DishEditor.js";
import { newOperationReference } from "./operation-reference.js";
import type { MenuSectionRow } from "./one-store-menu.js";
import { taxClassText } from "./product-pages.js";
import { dollarsToMinor, minorToDollars } from "./store-price-pages.js";
import { menuErrorText } from "./StoreMenuPages.js";
import {
  MenuPageError,
  type MenuClient,
  type MenuCombo,
  type SaveComboCommand,
} from "./store-menu-pages.js";

/** A dish (size) a combo slot can offer. */
export interface ComboDishChoice {
  readonly skuReference: string;
  readonly name: string;
  readonly nameZh: string;
}
interface Slot {
  readonly code: string | null;
  readonly name: string;
  readonly nameZh: string;
  /** How many dishes guests choose. */
  readonly choose: string;
  /** Guests may skip the slot. */
  readonly optional: boolean;
  /** The dishes offered, each with its extra price in dollars. */
  readonly dishes: ReadonlyMap<string, string>;
}
const emptySlot = (): Slot => ({
  code: null,
  name: "",
  nameZh: "",
  choose: "1",
  optional: false,
  dishes: new Map(),
});

/** The dishes a combo can offer: every size on the menu that is not itself a combo. */
export function comboDishChoices(
  rows: readonly MenuSectionRow[],
  combos: readonly MenuCombo[],
): readonly ComboDishChoice[] {
  const comboSkus = new Set(combos.map((c) => c.skuReference));
  return rows.flatMap((row) =>
    row.dishes.flatMap((dish) =>
      dish.sizes
        .filter((size) => !comboSkus.has(size.skuReference))
        .map((size) => ({
          skuReference: size.skuReference,
          name: size.sizeName ? `${dish.name} — ${size.sizeName}` : dish.name,
          nameZh: dish.nameZh,
        })),
    ),
  );
}

/** The command for the form, or null while something is missing. */
export function saveComboCommand(input: {
  readonly operationReference: string;
  readonly menuReference: string;
  readonly combo: MenuCombo | null;
  readonly name: string;
  readonly nameZh: string;
  readonly description: string;
  readonly descriptionZh: string;
  readonly price: string;
  readonly tax: string;
  readonly section: string;
  readonly slots: readonly Slot[];
}): SaveComboCommand | null {
  const priceMinor = dollarsToMinor(input.price);
  if (
    input.name.trim() === "" ||
    priceMinor === null ||
    input.tax === "" ||
    input.slots.length === 0
  )
    return null;
  const slots = input.slots.map((slot) => {
    const choose = Number(slot.choose);
    const dishes = [...slot.dishes].map(([skuReference, dollars]) => ({
      skuReference,
      upgradeMinor: dollarsToMinor(dollars),
    }));
    if (
      slot.name.trim() === "" ||
      !Number.isSafeInteger(choose) ||
      choose < 1 ||
      choose > dishes.length ||
      dishes.some((d) => d.upgradeMinor === null)
    )
      return null;
    return {
      code: slot.code,
      name: slot.name.trim(),
      nameZh: slot.nameZh.trim(),
      minimum: slot.optional ? 0 : choose,
      maximum: choose,
      dishes: dishes.map((d) => ({
        skuReference: d.skuReference,
        upgradeMinor: d.upgradeMinor ?? "0",
      })),
    };
  });
  if (slots.some((slot) => slot === null)) return null;
  return {
    action: "SaveCombo",
    operationReference: input.operationReference,
    menuReference: input.menuReference,
    bundleReference: input.combo?.bundleReference ?? null,
    expectedAggregateVersion: input.combo?.aggregateVersion ?? null,
    sectionCode: input.section,
    name: input.name.trim(),
    nameZh: input.nameZh.trim(),
    description: input.description.trim(),
    descriptionZh: input.descriptionZh.trim(),
    taxClassificationReference: input.tax,
    priceMinor,
    slots: slots.filter((slot) => slot !== null),
  };
}

/**
 * WP-2423 item 8 ⑥ part 4 DEC-SINGLE-STORE-COMBO (Owner 2026-10-28 decision 10): a combo edited on
 * the one-page menu — one price for guests, and slots (汤 choose 1, 主食 choose 1) each offering
 * dishes on the menu, some with an extra price. The kitchen makes each chosen dish on its own;
 * payment and reports count the combo once at its price. Saving keeps it waiting; guests see it
 * when the menu is listed.
 */
export function ComboEditor({
  menuReference,
  combo,
  dishes,
  sections,
  sectionCode,
  client,
  onSaved,
  onClose,
}: {
  readonly menuReference: string;
  /** null: a new combo. */
  readonly combo: MenuCombo | null;
  readonly dishes: readonly ComboDishChoice[];
  readonly sections: readonly MenuSectionRow[];
  readonly sectionCode: string;
  readonly client: MenuClient;
  readonly onSaved: (message: string) => void;
  readonly onClose: () => void;
}) {
  const productReference = combo?.productReference ?? null;
  const [source, setSource] = useState<DishEditorSource | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: combo?.name ?? "",
    nameZh: combo?.nameZh ?? "",
    description: combo?.description ?? "",
    descriptionZh: combo?.descriptionZh ?? "",
    price: combo === null ? "" : minorToDollars(combo.priceMinor),
    tax: "",
    section: sectionCode,
  });
  const [slots, setSlots] = useState<readonly Slot[]>(() =>
    combo === null
      ? [emptySlot()]
      : combo.slots.map((slot) => ({
          code: slot.code,
          name: slot.name,
          nameZh: slot.nameZh,
          choose: String(slot.maximum),
          optional: slot.minimum === 0,
          dishes: new Map(slot.dishes.map((d) => [d.skuReference, minorToDollars(d.upgradeMinor)])),
        })),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
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
        setForm((current) => ({
          ...current,
          tax:
            found.taxClassificationReference ??
            found.taxClasses[0]?.taxClassificationReference ??
            "",
        }));
      })
      .catch(() => {
        if (active)
          setFailed(t("The combo could not be read. Check the connection and try again."));
      });
    return () => {
      active = false;
    };
  }, [client, productReference]);
  const label =
    combo === null ? t("New combo") : combo.nameZh ? `${combo.name} ${combo.nameZh}` : combo.name;
  const command = saveComboCommand({
    operationReference: operation ?? "",
    menuReference,
    combo,
    ...form,
    slots,
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
        {t("Reading the combo…")}
      </p>
    );
  const save = async () => {
    if (client.oneStore === undefined || busy || command === null) return;
    setBusy(true);
    setProblem(null);
    const reference = operation ?? newOperationReference();
    setOperation(reference);
    try {
      await client.oneStore({ ...command, operationReference: reference });
      setOperation(null);
      onSaved(t("{item} saved. Guests see it when the menu is listed.", { item: command.name }));
    } catch (error) {
      if (!(error instanceof MenuPageError) || error.code !== "Offline") setOperation(null);
      // v15 2026-10-29: a new combo that stopped after it was made is on the menu now; it is
      // finished with Edit (saving this form again would make a second combo).
      if (combo === null && error instanceof MenuPageError && error.code === "StoppedPartWay") {
        onSaved(
          t("{item} was saved only in part. Open it with Edit and save it again to finish it.", {
            item: command.name,
          }),
        );
        return;
      }
      setProblem(
        error instanceof MenuPageError
          ? menuErrorText[error.code]
          : t("That didn't go through. Read the menu again and retry."),
      );
    } finally {
      setBusy(false);
    }
  };
  const update = (index: number, change: (slot: Slot) => Slot) =>
    setSlots((current) => current.map((slot, i) => (i === index ? change(slot) : slot)));
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
  const priceMinor = dollarsToMinor(form.price);
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
        {field("description", t("English description"), { maxLength: 120 })}
        {field("descriptionZh", t("Chinese description"), { maxLength: 120, lang: "zh-Hans" })}
        {field("price", t("Combo price ($)"), {
          inputMode: "decimal",
          required: true,
          placeholder: "28.80",
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
      <p className="dish-editor__note">
        {t(
          "Guests pay the combo price once and choose in each part. The kitchen makes each chosen dish on its own.",
        )}
      </p>
      {slots.map((slot, index) => {
        const slotLabel = slot.nameZh || slot.name || t("Part {number}", { number: index + 1 });
        return (
          <fieldset key={slot.code ?? "new-" + index}>
            <legend>{t("Part {number}", { number: index + 1 })}</legend>
            <div className="dish-editor__grid">
              <label className="dish-editor__field">
                <span>{t("English name")}</span>
                <input
                  required
                  maxLength={80}
                  placeholder={t("Soup")}
                  value={slot.name}
                  onChange={(event) => update(index, (s) => ({ ...s, name: event.target.value }))}
                />
              </label>
              <label className="dish-editor__field">
                <span>{t("Chinese name")}</span>
                <input
                  lang="zh-Hans"
                  maxLength={80}
                  placeholder="汤"
                  value={slot.nameZh}
                  onChange={(event) => update(index, (s) => ({ ...s, nameZh: event.target.value }))}
                />
              </label>
              <label className="dish-editor__field">
                <span>{t("Guests choose")}</span>
                <input
                  inputMode="numeric"
                  required
                  value={slot.choose}
                  onChange={(event) => update(index, (s) => ({ ...s, choose: event.target.value }))}
                />
              </label>
            </div>
            <label className="dish-editor__confirm">
              <input
                type="checkbox"
                checked={slot.optional}
                onChange={(event) =>
                  update(index, (s) => ({ ...s, optional: event.target.checked }))
                }
              />
              {t("Guests may skip this part")}
            </label>
            {dishes.length === 0 ? (
              <p className="dish-editor__note">{t("Add dishes to the menu first.")}</p>
            ) : (
              <ul
                className="dish-editor__choices"
                aria-label={t("Dishes in {part}", { part: slotLabel })}
              >
                {dishes.map((dish) => {
                  const dishLabel = dish.nameZh ? `${dish.name} ${dish.nameZh}` : dish.name;
                  const extra = slot.dishes.get(dish.skuReference);
                  return (
                    <li key={dish.skuReference}>
                      <label>
                        <input
                          type="checkbox"
                          checked={extra !== undefined}
                          onChange={(event) =>
                            update(index, (s) => {
                              const next = new Map(s.dishes);
                              if (event.target.checked) next.set(dish.skuReference, "0.00");
                              else next.delete(dish.skuReference);
                              return { ...s, dishes: next };
                            })
                          }
                        />
                        {dishLabel}
                      </label>
                      {extra !== undefined ? (
                        <label className="dish-editor__choice-price">
                          <span>{t("Extra ($) for {choice}", { choice: dishLabel })}</span>
                          <input
                            inputMode="decimal"
                            value={extra}
                            onChange={(event) =>
                              update(index, (s) => ({
                                ...s,
                                dishes: new Map(s.dishes).set(
                                  dish.skuReference,
                                  event.target.value,
                                ),
                              }))
                            }
                          />
                        </label>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {slots.length > 1 ? (
              <div className="dish-editor__actions">
                <button
                  type="button"
                  disabled={busy}
                  aria-label={t("Remove {part}", { part: slotLabel })}
                  onClick={() => setSlots((current) => current.filter((_, i) => i !== index))}
                >
                  {t("Remove part")}
                </button>
              </div>
            ) : null}
          </fieldset>
        );
      })}
      <div className="dish-editor__actions">
        <button
          type="button"
          disabled={busy || slots.length >= 8}
          onClick={() => setSlots((current) => [...current, emptySlot()])}
        >
          {t("Add part")}
        </button>
      </div>
      {command === null && slots.some((slot) => slot.dishes.size > 0) ? (
        <p className="dish-editor__note">
          {t("Each part needs a name and at least as many dishes as guests choose.")}
        </p>
      ) : null}
      {problem ? (
        <p className="dish-editor__problem" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="dish-editor__actions">
        <button type="submit" className="one-menu__primary" disabled={busy || command === null}>
          {busy ? t("Saving…") : t("Save combo")}
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          {t("Close")}
        </button>
      </div>
    </form>
  );
}
