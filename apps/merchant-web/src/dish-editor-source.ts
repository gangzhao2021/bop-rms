import type { ProductOptionSetChoice, ProductTaxClass } from "./product-pages.js";
import { MenuPageError } from "./store-menu-pages.js";
import { minorToDollars } from "./store-price-pages.js";

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
  /** WP-2423 item 3: what each option usually costs on this Brand's dishes (dollars). */
  readonly usual: ReadonlyMap<string, string>;
}
const object = (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
/** An option's price on a dish: what is waiting to be listed, else what is published. */
export const optionRowDollars = (option: Record<string, unknown>): string | null => {
  const pending = object(option.pending)?.priceMinor;
  const minor = typeof pending === "string" ? pending : option.priceMinor;
  return typeof minor === "string" ? minorToDollars(minor) : null;
};
/** The product read (detail, or the list for a new dish) and the choice prices, for the editor. */
export function dishEditorSource(
  productReference: string | null,
  loaded: { readonly product: unknown; readonly optionPrices: unknown },
): DishEditorSource {
  const view = object(loaded.product);
  if (view === null || !Array.isArray(view.taxClasses)) throw new MenuPageError("Unavailable");
  const product = object(view.product);
  // A combo's parts are not choices a dish offers.
  const groups = (Array.isArray(view.optionSetChoices) ? view.optionSetChoices : []).filter(
    (g: ProductOptionSetChoice) => !g.archived && g.comboPart !== true,
  ) as ProductOptionSetChoice[];
  const prices = new Map<string, string>();
  const optionView = object(loaded.optionPrices);
  for (const p of Array.isArray(optionView?.products) ? optionView.products : [])
    if (object(p)?.productReference === productReference)
      for (const set of (p as { optionSets: { options: Record<string, unknown>[] }[] }).optionSets)
        for (const o of set.options) {
          const dollars = optionRowDollars(o);
          if (dollars !== null) prices.set(String(o.optionReference), dollars);
        }
  const usual = new Map<string, string>();
  for (const [option, minor] of Object.entries(object(optionView?.usual) ?? {}))
    if (typeof minor === "string") usual.set(option, minorToDollars(minor));
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
    usual,
  };
}

/**
 * A group's choices as a dish starts with them: each offered one at the extra typed for it, else at
 * its usual extra. `typed` is keyed by option reference.
 */
export function groupStart(
  group: ProductOptionSetChoice,
  usual: ReadonlyMap<string, string>,
  typed: ReadonlyMap<string, string> = new Map(),
): ReadonlyMap<string, string> {
  return new Map(
    group.options
      .filter((o) => o.offered)
      .map((o) => [
        o.optionReference,
        typed.get(o.optionReference) ?? usual.get(o.optionReference) ?? "0.00",
      ]),
  );
}

/** A choice as typed in "New choice group": its English and Chinese names and its extra. */
export interface TypedChoice {
  readonly name: string;
  readonly nameZh: string;
  readonly extra: string;
}

/**
 * The extras typed in "New choice group", by the option each became. The group keeps the order the
 * choices were typed in, so they are matched by position; the name staff see (English or Chinese,
 * whichever the staff language shows) must be one of the two typed, or that choice starts from its
 * usual extra instead.
 */
export function typedExtras(
  group: ProductOptionSetChoice,
  typed: readonly TypedChoice[],
): ReadonlyMap<string, string> {
  const extras = new Map<string, string>();
  if (group.options.length !== typed.length) return extras;
  group.options.forEach((option, index) => {
    const row = typed[index];
    if (row === undefined) return;
    const shown = option.name.trim();
    if (shown === row.name.trim() || (row.nameZh.trim() !== "" && shown === row.nameZh.trim()))
      extras.set(option.optionReference, row.extra);
  });
  return extras;
}

/**
 * What a new dish copies of another's choices: the groups staff can see, in the source's order, and
 * only the choices still offered. An archived group could not be bound to a new dish, and staff
 * could not see it to fix it.
 */
export function copiedChoices(
  source: Pick<DishEditorSource, "groups" | "chosen">,
): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const copied = new Map<string, ReadonlyMap<string, string>>();
  for (const [optionSetReference, options] of source.chosen) {
    const group = source.groups.find((g) => g.optionSetReference === optionSetReference);
    if (group === undefined) continue;
    const offered = new Set(group.options.filter((o) => o.offered).map((o) => o.optionReference));
    const kept = [...options].filter(([option]) => offered.has(option));
    if (kept.length > 0) copied.set(optionSetReference, new Map(kept));
  }
  return copied;
}
