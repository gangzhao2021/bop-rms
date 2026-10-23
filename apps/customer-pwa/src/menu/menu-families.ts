import { listSeparator, t } from "../i18n/i18n.js";
import { formatDecimalMoney } from "../journey/format.js";
import type { MenuAllergenItem, MenuOptionRule, MenuSellable, MenuView } from "./types.js";

/**
 * WP-2423: one card per Product on the customer menu.
 *
 * Each SKU of a multi-size Product is published as its own sellable, named by the server as
 * "<Product> — <Size>" ("Flat White — Small (8 oz)") and carrying its Product version. Sizes of one
 * Product are shown together as one item with a size choice, the way a guest expects to order
 * ("Flat White", then Small / Regular / Large). Sellables are grouped only when both facts agree —
 * the same Product version and the same "<Product> — " name prefix — so unrelated items are never
 * merged; anything else stays its own card.
 */
export interface MenuVariant {
  /** The size as the guest chooses it ("Small (8 oz)"); the full name for a single item. */
  readonly label: string;
  readonly sellable: MenuSellable;
}

export interface MenuFamily {
  /** Stable key within the menu: the first variant's sellable reference. */
  readonly key: string;
  /** "Flat White" for a sized Product; the sellable's own name otherwise. */
  readonly name: string;
  /** More than one entry only for a sized Product, in the Store's published order. */
  readonly variants: readonly MenuVariant[];
}

const sizeSeparator = " — ";

function splitName(name: string): readonly [string, string] | null {
  const index = name.indexOf(sizeSeparator);
  if (index < 1) return null;
  const product = name.slice(0, index).trim();
  const size = name.slice(index + sizeSeparator.length).trim();
  return product === "" || size === "" ? null : [product, size];
}

/** Groups one section's sellables into families, keeping the Store's published order. */
export function groupMenuFamilies(sellables: readonly MenuSellable[]): readonly MenuFamily[] {
  const byVersion = new Map<string, MenuSellable[]>();
  for (const sellable of sellables) {
    const key = sellable.productVersionReference;
    if (key === undefined) continue;
    const group = byVersion.get(key);
    if (group) group.push(sellable);
    else byVersion.set(key, [sellable]);
  }
  const families: MenuFamily[] = [];
  const placed = new Set<string>();
  for (const sellable of sellables) {
    if (placed.has(sellable.sellableReference)) continue;
    const group =
      sellable.productVersionReference === undefined
        ? undefined
        : byVersion.get(sellable.productVersionReference);
    const parts = group && group.length > 1 ? group.map((item) => splitName(item.name)) : null;
    const product = parts?.[0]?.[0];
    if (
      group &&
      parts &&
      product !== undefined &&
      parts.every((part) => part !== null && part[0] === product) &&
      new Set(parts.map((part) => part?.[1])).size === parts.length
    ) {
      group.forEach((item) => placed.add(item.sellableReference));
      families.push(
        Object.freeze({
          key: group[0]?.sellableReference ?? sellable.sellableReference,
          name: product,
          variants: Object.freeze(
            group.map((item, index) =>
              Object.freeze({ label: parts[index]?.[1] ?? item.name, sellable: item }),
            ),
          ),
        }),
      );
      continue;
    }
    placed.add(sellable.sellableReference);
    families.push(
      Object.freeze({
        key: sellable.sellableReference,
        name: sellable.name,
        variants: Object.freeze([Object.freeze({ label: sellable.name, sellable })]),
      }),
    );
  }
  return Object.freeze(families);
}

/** The family a sellable belongs to on this menu, or null when it is not published. */
export function findMenuFamily(menu: MenuView, sellableReference: string): MenuFamily | null {
  for (const section of menu.sections) {
    if (!section.sellables.some((item) => item.sellableReference === sellableReference)) continue;
    return (
      groupMenuFamilies(section.sellables).find((family) =>
        family.variants.some((variant) => variant.sellable.sellableReference === sellableReference),
      ) ?? null
    );
  }
  return null;
}

/** The variant a card opens: the first one that can be ordered now. */
export function primaryVariant(family: MenuFamily): MenuVariant {
  const first = family.variants[0];
  if (first === undefined) throw new TypeError("menu family without a variant");
  return family.variants.find((variant) => variant.sellable.availability !== "SoldOut") ?? first;
}

export const familySoldOut = (family: MenuFamily): boolean =>
  family.variants.every((variant) => variant.sellable.availability === "SoldOut");

export function familyDescription(family: MenuFamily): string | null {
  return (
    family.variants.find((variant) => variant.sellable.description !== null)?.sellable
      .description ?? null
  );
}

export function familyPhoto(family: MenuFamily): MenuSellable["photo"] {
  return family.variants.find((variant) => variant.sellable.photo !== null)?.sellable.photo ?? null;
}

/**
 * Every allergen any size declares, once each. "Contains" wins over "may contain" for the same
 * allergen, so the card never understates what the item holds.
 */
export function familyAllergens(family: MenuFamily): readonly MenuAllergenItem[] {
  const byName = new Map<string, MenuAllergenItem>();
  for (const variant of family.variants)
    for (const item of variant.sellable.allergens) {
      const known = byName.get(item.name);
      if (
        known === undefined ||
        (known.classification !== "Contains" && item.classification === "Contains")
      )
        byName.set(item.name, item);
    }
  return Object.freeze([...byName.values()]);
}

/**
 * The one short allergen line on a card: "Contains Milk, Soy · May contain Tree nuts". Null when the
 * Store published none (the menu's allergy notice and the item page still say no item is promised
 * allergen-free).
 */
export function compactAllergenLine(allergens: readonly MenuAllergenItem[]): string | null {
  const contains = allergens.filter((item) => item.classification === "Contains");
  const may = allergens.filter((item) => item.classification !== "Contains");
  const parts = [
    contains.length === 0
      ? null
      : t("Contains {value1}", { value1: contains.map((item) => item.name).join(listSeparator()) }),
    may.length === 0
      ? null
      : t("May contain {value1}", { value1: may.map((item) => item.name).join(listSeparator()) }),
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * WP-2423 ⑪: what the item contains with exactly these chosen options (quantities do not
 * matter), as reviewed for the published menu; null when the menu has no per-choice disclosure or
 * this set was not reviewed.
 */
export function allergensForChoice(
  sellable: MenuSellable,
  optionReferences: readonly string[],
): readonly MenuAllergenItem[] | null {
  const choices = sellable.allergensByChoice;
  if (choices === undefined) return null;
  const indexes: number[] = [];
  for (const reference of new Set(optionReferences)) {
    const index = choices.options.indexOf(reference);
    if (index < 0) return null;
    indexes.push(index);
  }
  const key = indexes.sort((a, b) => a - b).join(",");
  const entry = choices.sets.find((set) => set.slice(1).join(",") === key);
  return entry === undefined ? null : (choices.outcomes[entry[0] as number] ?? null);
}

/* ---------- Exact decimal arithmetic for menu prices (never binary floating point) ---------- */

const decimalPattern = /^(0|[1-9][0-9]{0,20})(?:\.([0-9]{1,6}))?$/u;
const scale = 1_000_000n;

/** "4.25" → 4250000n (millionths); null for malformed text. */
export function decimalToMicros(amount: string): bigint | null {
  const match = decimalPattern.exec(amount);
  if (!match) return null;
  return BigInt(match[1] ?? "0") * scale + BigInt((match[2] ?? "").padEnd(6, "0"));
}

/** 4250000n → "4.25" (trailing zeros past the cents dropped, as the server writes them). */
export function microsToDecimal(micros: bigint): string {
  const whole = micros / scale;
  let fraction = (micros % scale).toString().padStart(6, "0");
  while (fraction.length > 2 && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return `${whole}.${fraction}`;
}

type Price = NonNullable<MenuSellable["price"]>;

/** The card's price: "$4.95", "From $4.25" when sizes differ, or null when none is priced. */
export function familyPriceText(family: MenuFamily): string | null {
  const priced = family.variants
    .map((variant) => variant.sellable.price)
    .filter((price): price is Price => price !== null);
  if (priced.length === 0) return null;
  const currency = priced[0]?.currency;
  if (priced.some((price) => price.currency !== currency) || currency === undefined) return null;
  const micros = priced.map((price) => decimalToMicros(price.amount));
  if (micros.some((value) => value === null)) return null;
  const values = micros as bigint[];
  const lowest = values.reduce((min, value) => (value < min ? value : min));
  const varies = values.some((value) => value !== lowest) || priced.length < family.variants.length;
  const text = formatDecimalMoney(microsToDecimal(lowest), currency);
  if (text === null) return null;
  return varies ? t("From {text}", { text }) : text;
}

/**
 * What one configured item costs before tax: the size's base price plus each chosen option's price
 * times its quantity, times the item quantity. Null when any part is not priced yet (the final quote
 * still prices it), so the page never shows a partial amount as the total.
 */
export function configuredItemTotal(
  sellable: MenuSellable,
  rules: readonly MenuOptionRule[],
  selected: ReadonlyMap<string, number>,
  quantity: number,
): string | null {
  if (sellable.price === null || !Number.isSafeInteger(quantity) || quantity < 1) return null;
  const base = decimalToMicros(sellable.price.amount);
  if (base === null) return null;
  let unit = base;
  for (const rule of rules)
    for (const option of rule.options) {
      const count = selected.get(option.optionReference) ?? 0;
      if (count <= 0) continue;
      if (option.price === null || option.price.currency !== sellable.price.currency) return null;
      const each = decimalToMicros(option.price.amount);
      if (each === null || !Number.isSafeInteger(count)) return null;
      unit += each * BigInt(count);
    }
  return formatDecimalMoney(microsToDecimal(unit * BigInt(quantity)), sellable.price.currency);
}
