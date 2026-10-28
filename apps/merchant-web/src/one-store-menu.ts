import type { AvailabilityItem } from "./store-availability-page.js";
import type {
  DishAllergens,
  MenuBuilderView,
  MenuSectionInput,
  MenuSellable,
} from "./store-menu-pages.js";

/**
 * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU (Owner 2026-10-28 decisions 7–8): the single store's
 * menu on one page — sections and dishes in the order guests see them, each dish with both names,
 * its price and whether it is sold out today or hidden here. Search by either name; filter by
 * sold out, no price, hidden, or a missing name. Pure functions over the menu builder's view and
 * the Store's item availability.
 */
export type MenuFilter = "SoldOut" | "NoPrice" | "Hidden" | "MissingName" | "NoAllergens";
export const menuFilters: readonly MenuFilter[] = [
  "SoldOut",
  "NoPrice",
  "Hidden",
  "MissingName",
  "NoAllergens",
];

/** One size of a dish, with its own price and state at this store. */
export interface MenuSize {
  readonly skuReference: string;
  /** The size's own name ("Large"); null when it is the dish's name. */
  readonly sizeName: string | null;
  readonly priceMinor: string | null;
  readonly pendingPriceMinor: string | null;
  readonly soldOut: boolean;
  readonly hidden: boolean;
  readonly featured: boolean;
}
/**
 * One dish as guests see it (v15 2026-10-28 finding b): its sizes inside it, in menu order. The
 * dish's own fields are its first size's; sold out and hidden hold when every size is.
 */
export interface MenuDish {
  readonly skuReference: string;
  readonly name: string;
  readonly nameZh: string;
  /** The size's own name when it differs from the dish's (e.g. "Large"). */
  readonly sizeName: string | null;
  readonly priceMinor: string | null;
  /** A different price waiting to be listed (null: none). */
  readonly pendingPriceMinor: string | null;
  /** The dish (product) of the size; null in views without it. */
  readonly productReference: string | null;
  readonly soldOut: boolean;
  readonly hidden: boolean;
  readonly featured: boolean;
  /** Where its allergens come from: declared by staff here, a real recipe, or not yet. */
  readonly allergens: DishAllergens;
  readonly sizes: readonly MenuSize[];
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
    dishes: groupDishes(
      section.items.flatMap((item) => {
        const sku = sellables.get(item.skuReference);
        return sku === undefined ? [] : [dishOf(sku, status.get(item.skuReference), item.featured)];
      }),
    ),
  }));
}

/** Sizes of one product become one dish, at its first size's place (sizes keep their order). */
function groupDishes(sizes: readonly MenuDish[]): readonly MenuDish[] {
  const dishes: MenuDish[] = [];
  const at = new Map<string, number>();
  for (const size of sizes) {
    const key = size.productReference ?? size.skuReference;
    const index = at.get(key);
    if (index === undefined) {
      at.set(key, dishes.length);
      dishes.push(size);
      continue;
    }
    const dish = dishes[index] as MenuDish;
    const merged = [...dish.sizes, ...size.sizes];
    dishes[index] = {
      ...dish,
      sizes: merged,
      soldOut: merged.every((x) => x.soldOut),
      hidden: merged.every((x) => x.hidden),
    };
  }
  return dishes.map((dish) =>
    dish.sizes.length > 1
      ? {
          ...dish,
          sizeName: null,
          // Every size has its own name inside the dish.
          sizes: dish.sizes.map((x) => ({ ...x, sizeName: x.sizeName ?? dish.name })),
        }
      : dish,
  );
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
    pendingPriceMinor: sku.pendingPriceMinor ?? null,
    productReference: sku.productReference ?? null,
    soldOut: status === "SoldOut",
    // Not offered at this Store: guests here do not see it (it stays on the menu).
    hidden: sku.offeredHere === false || status === "NotOffered" || status === "Unavailable",
    featured,
    allergens: sku.allergens ?? { source: "None", declared: [] },
    sizes: [
      {
        skuReference: sku.skuReference,
        sizeName: sku.sizeName === sku.productName || sku.sizeName === "" ? null : sku.sizeName,
        priceMinor: sku.priceMinor,
        pendingPriceMinor: sku.pendingPriceMinor ?? null,
        soldOut: status === "SoldOut",
        hidden: sku.offeredHere === false || status === "NotOffered" || status === "Unavailable",
        featured,
      },
    ],
  };
}

/** Dishes that are not on any section (to find them and put them on the menu). */
export function dishesNotOnMenu(
  view: MenuBuilderView,
  availability: readonly AvailabilityItem[],
): readonly MenuDish[] {
  const placed = new Set(view.menu.sections.flatMap((s) => s.items.map((i) => i.skuReference)));
  const status = new Map(availability.map((item) => [item.skuReference, item.status]));
  return groupDishes(
    view.sellables
      .filter((sku) => sku.active && !placed.has(sku.skuReference))
      .map((sku) => dishOf(sku, status.get(sku.skuReference), false)),
  );
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
  // A dish shows under a filter when any of its sizes is sold out, unpriced or hidden.
  if (filters.has("SoldOut") && !dish.sizes.some((x) => x.soldOut)) return false;
  if (filters.has("NoPrice") && !dish.sizes.some((x) => x.priceMinor === null)) return false;
  if (filters.has("Hidden") && !dish.sizes.some((x) => x.hidden)) return false;
  if (filters.has("MissingName") && dish.name.trim() !== "" && dish.nameZh.trim() !== "")
    return false;
  if (filters.has("NoAllergens") && dish.allergens.source !== "None") return false;
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
    items: row.dishes.flatMap((dish) =>
      dish.sizes.map((size) => ({ skuReference: size.skuReference, featured: size.featured })),
    ),
  }));
}

/** The order of sections and dishes, to tell whether it changed since it was read. */
export function orderKey(rows: readonly MenuSectionRow[]): string {
  return rows
    .map(
      (row) =>
        row.code +
        ":" +
        row.dishes.map((d) => d.sizes.map((x) => x.skuReference).join("+")).join(","),
    )
    .join("|");
}

/** A section code for a new section from its English name (unique among the menu's codes). */
export function newSectionCode(name: string, taken: readonly string[]): string {
  const base =
    name
      .normalize("NFKD")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .replace(/^[^A-Z]+/u, "")
      .slice(0, 40) || "SECTION";
  let code = base,
    n = 2;
  while (taken.includes(code)) code = `${base}-${n++}`;
  return code;
}

/**
 * Whether the menu as saved is not what guests see (never listed, changed since, or a listing not
 * finished). The server's listing step decides; older views fall back to comparing versions.
 */
export function listingPending(
  view: Pick<MenuBuilderView, "listingStep" | "latestRelease" | "menu" | "publication">,
): boolean {
  if (view.listingStep !== undefined) return view.listingStep !== "Listed";
  const state = view.publication?.state ?? null;
  return (
    view.latestRelease === null ||
    view.latestRelease.menuVersionReference !== view.menu.versionReference ||
    (state !== null && state !== "Published")
  );
}
