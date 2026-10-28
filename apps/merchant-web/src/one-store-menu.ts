import type { AvailabilityItem } from "./store-availability-page.js";
import type { MenuBuilderView, MenuSectionInput, MenuSellable } from "./store-menu-pages.js";

/**
 * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU (Owner 2026-10-28 decisions 7–8): the single store's
 * menu on one page — sections and dishes in the order guests see them, each dish with both names,
 * its price and whether it is sold out today or hidden here. Search by either name; filter by
 * sold out, no price, hidden, or a missing name. Pure functions over the menu builder's view and
 * the Store's item availability.
 */
export type MenuFilter = "SoldOut" | "NoPrice" | "Hidden" | "MissingName";
export const menuFilters: readonly MenuFilter[] = ["SoldOut", "NoPrice", "Hidden", "MissingName"];

export interface MenuDish {
  readonly skuReference: string;
  readonly name: string;
  readonly nameZh: string;
  /** The size's own name when it differs from the dish's (e.g. "Large"). */
  readonly sizeName: string | null;
  readonly priceMinor: string | null;
  readonly soldOut: boolean;
  readonly hidden: boolean;
  readonly featured: boolean;
}
export interface MenuSectionRow {
  readonly sectionReference: string;
  readonly code: string;
  readonly name: string;
  readonly nameZh: string;
  readonly dishes: readonly MenuDish[];
}

/** One section per menu section, in order; each dish from the sellables and availability. */
export function menuRows(
  view: MenuBuilderView,
  availability: readonly AvailabilityItem[],
): readonly MenuSectionRow[] {
  const sellables = new Map(view.sellables.map((sku) => [sku.skuReference, sku]));
  const status = new Map(availability.map((item) => [item.skuReference, item.status]));
  return view.menu.sections.map((section) => ({
    sectionReference: section.sectionReference,
    code: section.code,
    name: section.name,
    nameZh: section.nameZh ?? "",
    dishes: section.items.flatMap((item) => {
      const sku = sellables.get(item.skuReference);
      return sku === undefined ? [] : [dishOf(sku, status.get(item.skuReference), item.featured)];
    }),
  }));
}

function dishOf(
  sku: MenuSellable,
  status: AvailabilityItem["status"] | undefined,
  featured: boolean,
): MenuDish {
  return {
    skuReference: sku.skuReference,
    name: sku.productName,
    nameZh: sku.productNameZh ?? "",
    sizeName: sku.sizeName === sku.productName || sku.sizeName === "" ? null : sku.sizeName,
    priceMinor: sku.priceMinor,
    soldOut: status === "SoldOut",
    // Not offered at this Store: guests here do not see it (it stays on the menu).
    hidden: sku.offeredHere === false || status === "NotOffered" || status === "Unavailable",
    featured,
  };
}

/** Dishes that are not on any section (to find them and put them on the menu). */
export function dishesNotOnMenu(
  view: MenuBuilderView,
  availability: readonly AvailabilityItem[],
): readonly MenuDish[] {
  const placed = new Set(view.menu.sections.flatMap((s) => s.items.map((i) => i.skuReference)));
  const status = new Map(availability.map((item) => [item.skuReference, item.status]));
  return view.sellables
    .filter((sku) => sku.active && !placed.has(sku.skuReference))
    .map((sku) => dishOf(sku, status.get(sku.skuReference), false));
}

const fold = (value: string) => value.normalize("NFKC").toLocaleLowerCase();

/** Whether a dish matches the search text (either name) and every chosen filter. */
export function dishMatches(
  dish: MenuDish,
  search: string,
  filters: ReadonlySet<MenuFilter>,
): boolean {
  const query = fold(search.trim());
  if (query !== "" && !fold(dish.name).includes(query) && !fold(dish.nameZh).includes(query))
    return false;
  if (filters.has("SoldOut") && !dish.soldOut) return false;
  if (filters.has("NoPrice") && dish.priceMinor !== null) return false;
  if (filters.has("Hidden") && !dish.hidden) return false;
  if (filters.has("MissingName") && dish.name.trim() !== "" && dish.nameZh.trim() !== "")
    return false;
  return true;
}

/** The sections with only matching dishes; sections left empty by a search are dropped. */
export function filterRows(
  rows: readonly MenuSectionRow[],
  search: string,
  filters: ReadonlySet<MenuFilter>,
): readonly MenuSectionRow[] {
  const narrowing = search.trim() !== "" || filters.size > 0;
  return rows
    .map((row) => ({ ...row, dishes: row.dishes.filter((d) => dishMatches(d, search, filters)) }))
    .filter((row) => !narrowing || row.dishes.length > 0);
}

/** The menu's sections as the draft command takes them, in the order shown. */
export function sectionInputs(rows: readonly MenuSectionRow[]): readonly MenuSectionInput[] {
  return rows.map((row) => ({
    sectionReference: row.sectionReference,
    code: row.code,
    name: row.name,
    nameZh: row.nameZh,
    items: row.dishes.map((dish) => ({ skuReference: dish.skuReference, featured: dish.featured })),
  }));
}

/** The order of sections and dishes, to tell whether it changed since it was read. */
export function orderKey(rows: readonly MenuSectionRow[]): string {
  return rows
    .map((row) => row.code + ":" + row.dishes.map((d) => d.skuReference).join(","))
    .join("|");
}
