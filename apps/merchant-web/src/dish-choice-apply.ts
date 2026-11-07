import { optionRowDollars, type DishEditorSource } from "./dish-editor-source.js";
import type { MenuDish, MenuSectionRow } from "./one-store-menu.js";
import type { ProductOptionSetChoice } from "./product-pages.js";
import type { AllergenClassification, DishAllergens, SaveDishCommand } from "./store-menu-pages.js";
import { dollarsToMinor } from "./store-price-pages.js";

/**
 * WP-2423 item 3 F: a choice group's choices reach other dishes ("Use on other dishes"), one dish at
 * a time. Pure rules: which dishes can take it, what each one is missing, and the one command that
 * adds it. A dish keeps every choice and extra it has unless the owner says otherwise, and its price
 * and section are never sent.
 */
export interface ApplySection {
  readonly code: string;
  readonly name: string;
  readonly nameZh: string;
  readonly dishes: readonly MenuDish[];
}

/** One size, on the menu with a price; a combo or a fee takes no toppings. */
export const dishTakesChoices = (dish: MenuDish): boolean =>
  dish.productReference !== null &&
  dish.sizes.length === 1 &&
  (dish.priceMinor !== null || dish.pendingPriceMinor !== null) &&
  dish.allergens.noIngredients !== true;

export function applySections(
  rows: readonly MenuSectionRow[],
  isCombo: (skuReference: string) => boolean,
  thisDish: string | null,
): readonly ApplySection[] {
  return rows
    .map((row) => ({
      code: row.code,
      name: row.name,
      nameZh: row.nameZh,
      dishes: row.dishes.filter(
        (dish) =>
          dishTakesChoices(dish) && !isCombo(dish.skuReference) && dish.skuReference !== thisDish,
      ),
    }))
    .filter((row) => row.dishes.length > 0);
}

/** Per dish, what it has of this group (option to dollars), from the whole choice price list. */
export function dishGroupExtras(
  optionPrices: unknown,
  optionSetReference: string,
): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const found = new Map<string, Map<string, string>>();
  const products = (optionPrices as { products?: unknown } | null)?.products;
  for (const product of Array.isArray(products)
    ? (products as {
        productReference: string;
        optionSets: {
          optionSetReference?: string;
          options: (Record<string, unknown> & { optionReference: string })[];
        }[];
      }[])
    : [])
    for (const set of product.optionSets)
      if (set.optionSetReference === optionSetReference)
        found.set(
          product.productReference,
          new Map(set.options.map((o) => [o.optionReference, optionRowDollars(o) ?? "0.00"])),
        );
  return found;
}

/** The first dish, in menu order, that already offers this group. */
export function firstDishUsing(
  rows: readonly MenuSectionRow[],
  optionPrices: unknown,
  optionSetReference: string,
  isCombo: (skuReference: string) => boolean,
): MenuDish | null {
  const using = dishGroupExtras(optionPrices, optionSetReference);
  for (const row of rows)
    for (const dish of row.dishes)
      if (
        dish.productReference !== null &&
        dish.sizes.length === 1 &&
        !isCombo(dish.skuReference) &&
        using.has(dish.productReference)
      )
        return dish;
  return null;
}

export interface ChoiceAdd {
  readonly optionReference: string;
  readonly name: string;
  readonly dollars: string;
}
export interface ChoiceChange {
  readonly optionReference: string;
  readonly name: string;
  readonly from: string;
  readonly to: string;
}
export interface DishApplyPlan {
  readonly adds: readonly ChoiceAdd[];
  readonly changes: readonly ChoiceChange[];
}
export const planChangesNothing = (plan: DishApplyPlan): boolean =>
  plan.adds.length === 0 && plan.changes.length === 0;

/** Every choice ticked here is on that dish. */
export const hasEveryChoice = (
  extras: ReadonlyMap<string, string>,
  has: ReadonlyMap<string, string> | undefined,
): boolean => has !== undefined && [...extras.keys()].every((option) => has.has(option));

const sameMoney = (a: string, b: string) => dollarsToMinor(a) === dollarsToMinor(b);

/** Which ticked choices the owner gave a new extra on this dish (a price rise touches only those). */
export function choicesChangedHere(
  extras: ReadonlyMap<string, string>,
  read: ReadonlyMap<string, string> | undefined,
): ReadonlySet<string> {
  return new Set(
    [...extras]
      .filter(([option, dollars]) => {
        const before = read?.get(option);
        return before !== undefined && !sameMoney(before, dollars);
      })
      .map(([option]) => option),
  );
}

/**
 * What applying this dish's choices does to another dish. It adds only what that dish is missing, at
 * this dish's extra. Existing extras change only when the owner asks, and if they changed an extra
 * here, only that choice: a premium drink's Large is not this drink's Large.
 */
export function planDishApply(input: {
  readonly group: Pick<ProductOptionSetChoice, "options">;
  readonly extras: ReadonlyMap<string, string>;
  readonly has: ReadonlyMap<string, string> | undefined;
  readonly changeExisting: boolean;
  readonly changedHere: ReadonlySet<string>;
}): DishApplyPlan {
  const names = new Map(input.group.options.map((o) => [o.optionReference, o.name]));
  const adds: ChoiceAdd[] = [];
  const changes: ChoiceChange[] = [];
  for (const [optionReference, dollars] of input.extras) {
    const name = names.get(optionReference) ?? "";
    const before = input.has?.get(optionReference);
    if (before === undefined) adds.push({ optionReference, name, dollars });
    else if (
      input.changeExisting &&
      !sameMoney(before, dollars) &&
      (input.changedHere.size === 0 || input.changedHere.has(optionReference))
    )
      changes.push({ optionReference, name, from: before, to: dollars });
  }
  return { adds, changes };
}

export interface PriceChangeLine {
  readonly choice: string;
  readonly from: string;
  readonly to: string;
  readonly dishes: number;
}
/** The price changes of a run, one line per choice and amounts, for the confirmation. */
export function summarisePriceChanges(plans: readonly DishApplyPlan[]): readonly PriceChangeLine[] {
  const lines = new Map<string, PriceChangeLine>();
  for (const plan of plans)
    for (const change of plan.changes) {
      const key = `${change.optionReference}:${change.from}:${change.to}`;
      const line = lines.get(key);
      lines.set(key, {
        choice: change.name,
        from: change.from,
        to: change.to,
        dishes: (line?.dishes ?? 0) + 1,
      });
    }
  return [...lines.values()];
}

/** What applying a choice adds to a declaration: the stronger answer stays. */
export function mergedDeclaration(
  allergens: DishAllergens,
  additions: ReadonlyMap<string, AllergenClassification>,
): SaveDishCommand["allergens"] {
  // Only a dish staff declared is added to; a recipe dish is named, an undeclared one still waits.
  if (allergens.source !== "StaffDeclared" || allergens.noIngredients === true) return null;
  const merged = new Map(allergens.declared.map((a) => [a.allergenReference, a.classification]));
  let changed = false;
  for (const [allergen, classification] of additions) {
    const current = merged.get(allergen);
    if (current === classification || current === "Contains") continue;
    merged.set(allergen, classification);
    changed = true;
  }
  if (!changed) return null;
  return [...merged].map(([allergenReference, classification]) => ({
    allergenReference,
    classification,
  }));
}

/** The allergens a dish gains from the choices it is getting (the stronger answer stays). */
export function additionsFor(
  plan: DishApplyPlan,
  answers: ReadonlyMap<string, ReadonlyMap<string, AllergenClassification>>,
): ReadonlyMap<string, AllergenClassification> {
  const additions = new Map<string, AllergenClassification>();
  for (const add of plan.adds)
    for (const [allergen, classification] of answers.get(add.optionReference) ?? [])
      if (additions.get(allergen) !== "Contains") additions.set(allergen, classification);
  return additions;
}

/**
 * The save of one other dish as just read: its own names, tax and other groups as they are, with no
 * price and no section (either could be stale, and writing a Store's price opens a price draft for
 * the whole Brand). null: it already matches, and saving it would only make a change to list.
 */
export function appliedDishCommand(input: {
  readonly menuReference: string;
  readonly productReference: string;
  readonly operationReference: string;
  readonly source: DishEditorSource;
  readonly optionSetReference: string;
  readonly plan: DishApplyPlan;
  readonly allergens: SaveDishCommand["allergens"];
}): SaveDishCommand | null {
  if (planChangesNothing(input.plan) && input.allergens === null) return null;
  const current = input.source.chosen.get(input.optionSetReference);
  const group = new Map(current ?? []);
  for (const add of input.plan.adds)
    if (!group.has(add.optionReference)) group.set(add.optionReference, add.dollars);
  for (const change of input.plan.changes) group.set(change.optionReference, change.to);
  const groups = new Map(input.source.chosen);
  groups.set(input.optionSetReference, group);
  return {
    action: "SaveDish",
    operationReference: input.operationReference,
    menuReference: input.menuReference,
    productReference: input.productReference,
    sectionCode: null,
    name: input.source.name,
    nameZh: input.source.nameZh,
    description: input.source.description,
    descriptionZh: input.source.descriptionZh,
    taxClassificationReference: input.source.taxClassificationReference ?? "",
    priceMinor: null,
    choiceGroups: [...groups].map(([optionSetReference, options]) => ({
      optionSetReference,
      options: [...options].map(([optionReference, dollars]) => ({
        optionReference,
        amountMinor: dollarsToMinor(dollars) ?? "0",
      })),
    })),
    allergens: input.allergens,
  };
}

export interface ApplyRunResult {
  readonly applied: readonly MenuDish[];
  /** Saved, but its choices wait for its allergens (never counted as done). */
  readonly waiting: readonly MenuDish[];
  /** It stopped here; what came before stays, and trying again carries on from this dish. */
  readonly failed: { readonly dish: MenuDish; readonly error: unknown } | null;
}

/**
 * One dish at a time, reading each just before it is saved. A dish that stopped keeps its command
 * and so its operation (`memory`): trying again carries on where the server stopped, rather than
 * starting a second save. A dish that already matches is skipped and not counted.
 */
export async function runDishApply(input: {
  readonly dishes: readonly MenuDish[];
  readonly memory: Map<string, SaveDishCommand>;
  readonly load: (productReference: string) => Promise<DishEditorSource>;
  readonly commandFor: (dish: MenuDish, source: DishEditorSource) => SaveDishCommand | null;
  readonly save: (command: SaveDishCommand) => Promise<unknown>;
  readonly onProgress: (done: number, total: number) => void;
  /** Already saved in this run (the dish on screen). */
  readonly counted: number;
  readonly stillOpen: () => boolean;
}): Promise<ApplyRunResult> {
  const applied: MenuDish[] = [];
  const waiting: MenuDish[] = [];
  let total = input.counted + input.dishes.length;
  let done = input.counted;
  input.onProgress(done, total);
  for (const dish of input.dishes) {
    if (!input.stillOpen()) break;
    const productReference = dish.productReference as string;
    try {
      let command = input.memory.get(productReference) ?? null;
      if (command === null) {
        const source = await input.load(productReference);
        // Read again: it may have been changed, or given sizes, since the list was read.
        command = source.sizes === 1 ? input.commandFor(dish, source) : null;
        if (command === null) {
          total -= 1;
          input.onProgress(done, total);
          continue;
        }
        input.memory.set(productReference, command);
      }
      const result = (await input.save(command)) as { choicesWaiting?: unknown } | null;
      input.memory.delete(productReference);
      if (result?.choicesWaiting === true) waiting.push(dish);
      else applied.push(dish);
      done += 1;
      input.onProgress(done, total);
    } catch (error) {
      return { applied, waiting, failed: { dish, error } };
    }
  }
  return { applied, waiting, failed: null };
}
