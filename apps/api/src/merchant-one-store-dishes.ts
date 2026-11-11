import { derivedReference } from "./merchant-products.js";
import { MerchantOptionRecipeError } from "./merchant-option-recipes.js";
import type { createMerchantAvailability } from "./merchant-availability.js";
import type { ComboSlot, ComboView, createMerchantCombos } from "./merchant-combos.js";
import type { createMerchantDishAllergens } from "./merchant-dish-allergens.js";
import type { createMerchantMenus } from "./merchant-menus.js";
import type { createMerchantOptionPrices } from "./merchant-option-prices.js";
import type { createMerchantOptionRecipes } from "./merchant-option-recipes.js";
import type { createMerchantOptionSets } from "./merchant-option-sets.js";
import type { createMerchantPrices } from "./merchant-prices.js";
import type { createMerchantProducts } from "./merchant-products.js";
import type { createMerchantStorePrices } from "./merchant-store-prices.js";

/**
 * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU (Owner 2026-10-28 decisions 7–8): one dish edited on
 * the one-page menu of a single store, and "List it" for everything edited there. A save does,
 * in order, what staff would otherwise do on six pages, each through that page's own command
 * (its permissions, versions and records unchanged): the product (both names and descriptions,
 * tax class, choice groups), its price in the store's open price book draft, its choice prices
 * (waiting to be published), its place in a menu section, its allergens declared by staff, and
 * a "no change" option recipe for each choice that has none. Each step is skipped when it
 * already holds, so retrying the same save continues where it stopped. Guests see nothing until
 * "List it" publishes the price book (and makes it the store's), the waiting choice prices and the
 * menu — each alone at the Brand's one store, recorded as single-store listings.
 */
export class MerchantOneStoreDishError extends Error {
  constructor(
    readonly code:
      | "Invalid"
      | "NotFound"
      /** The dish has more than one size; sizes are edited on the product page. */
      | "ManySizes"
      /** The menu has no section with that code. */
      | "NoSection"
      /** Someone else's price changes are waiting; they list them (or discard them) first. */
      | "OthersPending"
      /** A combo offers a dish that is not on the menu (or a combo itself). */
      | "NotADish"
      /** A dish in a combo has no allergens declared yet (guests see them per chosen dish). */
      | "DishAllergensMissing"
      /**
       * A dish in a combo has a real recipe: until the combo's choices carry recipes (and stock),
       * combos offer dishes whose allergens staff declared.
       */
      | "DishHasRecipe"
      /**
       * A step could not finish: a round of choice recipes covered nothing, or a lock or a store
       * would not answer. What was saved stays, and saving again goes on from there (409 with its
       * part, which the page shows as "Saving stopped part-way").
       */
      | "StoppedPartWay"
      /**
       * WP-2423 (v15 2026-11-05): "List it" stopped while carrying the "no change" option recipes of
       * a choice group turned into "a quantity of each" to the new quantities, before anything was
       * listed: what was written stays, guests see nothing new, and listing again finishes it.
       */
      | "ChoiceRecipesStopped"
      /**
       * WP-2423 M70: the price for this scope is not the one the person saw (someone changed it
       * since): read the dish again, then change it.
       */
      | "PriceChanged"
      /**
       * WP-2423 M70: at a Brand with several Stores, only someone with Brand Owner authority
       * changes a dish's price for every Store; anyone else changes it at this Store only.
       */
      | "NeedsBrandOwner"
      /**
       * WP-2423 M70: a dish with no price yet takes its first price for every Store (the owner
       * lists it); a Store's own price comes after.
       */
      | "NoBrandPriceYet"
      /**
       * WP-2423 M71: what "List it" was confirmed for is not what is waiting now (someone saved a
       * price since the review was shown): look again, then list.
       */
      | "PricesChangedSinceShown"
      /**
       * WP-2423 (M76, Owner decision 16): a new food dish at a Brand with an allergen list is saved
       * only with every allergen answered; nothing is recorded.
       */
      | "AllergensUnanswered",
  ) {
    super(code);
    this.name = "MerchantOneStoreDishError";
  }
}
const fail = (code: MerchantOneStoreDishError["code"]): never => {
  throw new MerchantOneStoreDishError(code);
};
/**
 * A failure of a save that was not a refusal by one of the six pages' commands: a lock that outlived
 * its retries, a store that would not answer. Never an answer of "no permission". The original
 * error stays as the cause.
 */
const refusedByAPage = (error: unknown) =>
  error instanceof Error && /^Merchant[A-Za-z]+Error$/u.test(error.name);
const stoppedPartWay = (error: unknown): Error =>
  refusedByAPage(error)
    ? (error as Error)
    : Object.assign(new MerchantOneStoreDishError("StoppedPartWay"), { cause: error });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");
const amount = (value: unknown): string =>
  typeof value === "string" && /^(0|[1-9][0-9]{0,6})$/u.test(value) ? value : fail("Invalid");
const text = (value: unknown, max: number, required: boolean): string => {
  if (typeof value !== "string") return fail("Invalid");
  const trimmed = value.trim();
  if ((required && trimmed === "") || trimmed.length > max || /[\p{Cc}\p{Cf}]/u.test(trimmed))
    return fail("Invalid");
  return trimmed;
};

export interface SaveDishBody {
  readonly action: "SaveDish";
  readonly operationReference: string;
  readonly menuReference: string;
  /** null: a new dish (one size). */
  readonly productReference: string | null;
  /** null (an existing dish only): its place on the menu stays as it is. */
  readonly sectionCode: string | null;
  readonly name: string;
  readonly nameZh: string;
  readonly description: string;
  readonly descriptionZh: string;
  readonly taxClassificationReference: string;
  /**
   * null (an existing dish only): its price stays as it is. What the page read may be another
   * Store's price, or minutes old; a save that does not change the price must not write one.
   */
  readonly priceMinor: string | null;
  /**
   * WP-2423 M70: where the price changes — every Store, with "List it" (the Brand price), or this
   * Store only, at once (its own price, at a Brand with several Stores). null with no price.
   */
  readonly priceScope: "AllStores" | "ThisStore" | null;
  /** The price the person saw for that scope (null: there was none); a different one is refused. */
  readonly expectedPriceMinor: string | null;
  readonly choiceGroups: readonly {
    readonly optionSetReference: string;
    readonly options: readonly { readonly optionReference: string; readonly amountMinor: string }[];
  }[];
  /**
   * null: allergens not declared in this save. "NoIngredients" (WP-2423 item 8 ⑦, v15
   * 2026-10-29): declared a charge with no stock ingredients, such as the per-head tea. A list
   * (WP-2423 M76): one answer for every allergen on the Brand's list, "None" for No. "ComboParts"
   * is the combo save's own (never parsed from a request): no allergens of its own, its choices
   * add their dishes'.
   */
  readonly allergens:
    | readonly {
        readonly allergenReference: string;
        readonly classification: "Contains" | "CrossContactPossible" | "None";
      }[]
    | "NoIngredients"
    | "ComboParts"
    | null;
  /**
   * WP-2423 (M166): what each choice answered in this save adds to the dish, declared by staff
   * ("adds none": an empty list). Choices not listed keep what they add. Only the dish's own
   * choices; absent from an older client.
   */
  readonly choiceAllergens?: readonly {
    readonly optionReference: string;
    readonly name: string;
    readonly declared: readonly {
      readonly allergenReference: string;
      readonly classification: "Contains" | "CrossContactPossible";
    }[];
  }[];
}
export interface ListAllBody {
  readonly action: "ListAll";
  readonly operationReference: string;
  readonly menuReference: string;
  /**
   * WP-2423 M71: the menu's own price draft as the review showed it (null: none was waiting).
   * Anything saved into it since is refused, so nothing goes live unseen.
   */
  readonly confirmedPriceBook: {
    readonly priceBookReference: string;
    readonly aggregateVersion: number;
  } | null;
}
/**
 * WP-2423 item 8 ⑥ part 4: a combo saved from the one-page menu — its names, price, tax class,
 * section and slots (each: names, how many guests choose, the dishes offered with any extra price).
 */
export interface SaveComboBody {
  readonly action: "SaveCombo";
  readonly operationReference: string;
  readonly menuReference: string;
  /** null: a new combo. */
  readonly bundleReference: string | null;
  readonly expectedAggregateVersion: number | null;
  readonly sectionCode: string;
  readonly name: string;
  readonly nameZh: string;
  readonly description: string;
  readonly descriptionZh: string;
  readonly taxClassificationReference: string;
  readonly priceMinor: string;
  readonly slots: readonly {
    /** null: a new slot. */
    readonly code: string | null;
    readonly name: string;
    readonly nameZh: string;
    readonly minimum: number;
    readonly maximum: number;
    readonly dishes: readonly { readonly skuReference: string; readonly upgradeMinor: string }[];
  }[];
}
const slotCode = /^SLOT-[1-9][0-9]?$/u;
function parseSaveCombo(r: Record<string, unknown>): SaveComboBody {
  if (
    Object.keys(r).sort().join(",") !==
      "action,bundleReference,description,descriptionZh,expectedAggregateVersion,menuReference,name,nameZh,operationReference,priceMinor,sectionCode,slots,taxClassificationReference" ||
    !Array.isArray(r.slots) ||
    r.slots.length < 1 ||
    r.slots.length > 8 ||
    (r.bundleReference === null) !== (r.expectedAggregateVersion === null) ||
    (r.expectedAggregateVersion !== null &&
      (!Number.isSafeInteger(r.expectedAggregateVersion) ||
        (r.expectedAggregateVersion as number) < 1))
  )
    return fail("Invalid");
  const slots = r.slots.map((candidate: unknown) => {
    const g = candidate as Record<string, unknown> | null;
    if (
      g === null ||
      typeof g !== "object" ||
      Object.keys(g).sort().join(",") !== "code,dishes,maximum,minimum,name,nameZh" ||
      (g.code !== null && (typeof g.code !== "string" || !slotCode.test(g.code))) ||
      !Array.isArray(g.dishes) ||
      g.dishes.length < 1 ||
      g.dishes.length > 20 ||
      !Number.isSafeInteger(g.minimum) ||
      !Number.isSafeInteger(g.maximum)
    )
      return fail("Invalid");
    const dishes = g.dishes.map((candidateDish: unknown) => {
      const d = candidateDish as Record<string, unknown> | null;
      if (
        d === null ||
        typeof d !== "object" ||
        Object.keys(d).sort().join(",") !== "skuReference,upgradeMinor"
      )
        return fail("Invalid");
      return { skuReference: ref(d.skuReference), upgradeMinor: amount(d.upgradeMinor) };
    });
    const minimum = g.minimum as number;
    const maximum = g.maximum as number;
    if (
      minimum < 0 ||
      maximum < 1 ||
      minimum > maximum ||
      maximum > dishes.length ||
      new Set(dishes.map((d) => d.skuReference)).size !== dishes.length
    )
      return fail("Invalid");
    return {
      code: g.code as string | null,
      name: text(g.name, 80, true),
      nameZh: text(g.nameZh, 80, false),
      minimum,
      maximum,
      dishes,
    };
  });
  const codes = slots.flatMap((slot) => (slot.code === null ? [] : [slot.code]));
  if (new Set(codes).size !== codes.length) return fail("Invalid");
  const sectionCode = typeof r.sectionCode === "string" ? r.sectionCode : "";
  if (!/^[A-Z][A-Z0-9_-]{0,63}$/u.test(sectionCode)) return fail("Invalid");
  return {
    action: "SaveCombo",
    operationReference: ref(r.operationReference),
    menuReference: ref(r.menuReference),
    bundleReference: r.bundleReference === null ? null : ref(r.bundleReference),
    expectedAggregateVersion: r.expectedAggregateVersion as number | null,
    sectionCode,
    name: text(r.name, 80, true),
    nameZh: text(r.nameZh, 80, false),
    // A Bundle description is at most 120 characters.
    description: text(r.description, 120, false),
    descriptionZh: text(r.descriptionZh, 120, false),
    taxClassificationReference: ref(r.taxClassificationReference),
    priceMinor: amount(r.priceMinor),
    slots,
  };
}

/** The most rules one choice-price publish takes (`parseOptionPriceCommandBody`). */
const OPTION_PRICE_PUBLISH_LIMIT = 100;

export function parseOneStoreDishBody(value: unknown): SaveDishBody | ListAllBody | SaveComboBody {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  if (r.action === "SaveCombo") return parseSaveCombo(r);
  const keys = Object.keys(r).sort().join(",");
  if (
    r.action === "ListAll" &&
    keys === "action,confirmedPriceBook,menuReference,operationReference"
  ) {
    const c = r.confirmedPriceBook as Record<string, unknown> | null;
    if (
      c !== null &&
      (typeof c !== "object" ||
        Array.isArray(c) ||
        Object.keys(c).sort().join(",") !== "aggregateVersion,priceBookReference" ||
        !Number.isSafeInteger(c.aggregateVersion) ||
        (c.aggregateVersion as number) < 1)
    )
      return fail("Invalid");
    return {
      action: "ListAll",
      operationReference: ref(r.operationReference),
      menuReference: ref(r.menuReference),
      confirmedPriceBook:
        c === null
          ? null
          : {
              priceBookReference: ref(c.priceBookReference),
              aggregateVersion: c.aggregateVersion as number,
            },
    };
  }
  const withChoiceAllergens = Object.hasOwn(r, "choiceAllergens");
  if (
    r.action !== "SaveDish" ||
    keys !==
      (withChoiceAllergens
        ? "action,allergens,choiceAllergens,choiceGroups,description,descriptionZh,expectedPriceMinor,menuReference,name,nameZh,operationReference,priceMinor,priceScope,productReference,sectionCode,taxClassificationReference"
        : "action,allergens,choiceGroups,description,descriptionZh,expectedPriceMinor,menuReference,name,nameZh,operationReference,priceMinor,priceScope,productReference,sectionCode,taxClassificationReference") ||
    !Array.isArray(r.choiceGroups) ||
    r.choiceGroups.length > 12 ||
    (r.allergens !== null &&
      r.allergens !== "NoIngredients" &&
      (!Array.isArray(r.allergens) || r.allergens.length > 64))
  )
    return fail("Invalid");
  const choiceGroups = r.choiceGroups.map((candidate: unknown) => {
    const g = candidate as Record<string, unknown> | null;
    if (
      g === null ||
      typeof g !== "object" ||
      Object.keys(g).sort().join(",") !== "optionSetReference,options" ||
      !Array.isArray(g.options) ||
      g.options.length < 1 ||
      g.options.length > 50
    )
      return fail("Invalid");
    return {
      optionSetReference: ref(g.optionSetReference),
      options: g.options.map((candidateOption: unknown) => {
        const o = candidateOption as Record<string, unknown> | null;
        if (
          o === null ||
          typeof o !== "object" ||
          Object.keys(o).sort().join(",") !== "amountMinor,optionReference"
        )
          return fail("Invalid");
        return { optionReference: ref(o.optionReference), amountMinor: amount(o.amountMinor) };
      }),
    };
  });
  if (
    new Set(choiceGroups.map((g) => g.optionSetReference)).size !== choiceGroups.length ||
    new Set(choiceGroups.flatMap((g) => g.options.map((o) => o.optionReference))).size !==
      choiceGroups.reduce((n, g) => n + g.options.length, 0)
  )
    return fail("Invalid");
  const allergens =
    r.allergens === null || r.allergens === "NoIngredients"
      ? r.allergens
      : (r.allergens as unknown[]).map((candidate) => {
          const a = candidate as Record<string, unknown> | null;
          if (
            a === null ||
            typeof a !== "object" ||
            Object.keys(a).sort().join(",") !== "allergenReference,classification" ||
            (a.classification !== "Contains" &&
              a.classification !== "CrossContactPossible" &&
              a.classification !== "None")
          )
            return fail("Invalid");
          return {
            allergenReference: ref(a.allergenReference),
            classification: a.classification as "Contains" | "CrossContactPossible" | "None",
          };
        });
  // WP-2423 (M166): each answered choice once, one of this dish's own, at most 100.
  const ownOptions = new Set(choiceGroups.flatMap((g) => g.options.map((o) => o.optionReference)));
  const choiceAllergens = !withChoiceAllergens
    ? undefined
    : Array.isArray(r.choiceAllergens) && r.choiceAllergens.length <= 100
      ? r.choiceAllergens.map((candidate: unknown) => {
          const c = candidate as Record<string, unknown> | null;
          if (
            c === null ||
            typeof c !== "object" ||
            Object.keys(c).sort().join(",") !== "declared,name,optionReference" ||
            !Array.isArray(c.declared) ||
            c.declared.length > 64
          )
            return fail("Invalid");
          const optionReference = ref(c.optionReference);
          if (!ownOptions.has(optionReference)) return fail("Invalid");
          const declared = c.declared.map((entry: unknown) => {
            const a = entry as Record<string, unknown> | null;
            if (
              a === null ||
              typeof a !== "object" ||
              Object.keys(a).sort().join(",") !== "allergenReference,classification" ||
              (a.classification !== "Contains" && a.classification !== "CrossContactPossible")
            )
              return fail("Invalid");
            return {
              allergenReference: ref(a.allergenReference),
              classification: a.classification as "Contains" | "CrossContactPossible",
            };
          });
          if (new Set(declared.map((a) => a.allergenReference)).size !== declared.length)
            return fail("Invalid");
          return { optionReference, name: text(c.name, 80, true), declared };
        })
      : fail("Invalid");
  if (
    choiceAllergens !== undefined &&
    new Set(choiceAllergens.map((c) => c.optionReference)).size !== choiceAllergens.length
  )
    return fail("Invalid");
  // Only an existing dish can keep its place and price: a new one has neither yet.
  if (r.productReference === null && (r.sectionCode === null || r.priceMinor === null))
    return fail("Invalid");
  // WP-2423 M70: a price says where it changes and what it was; no price, no scope. A new dish's
  // first price is for every Store.
  const priceScope =
    r.priceScope === "AllStores" || r.priceScope === "ThisStore" ? r.priceScope : null;
  if (
    (r.priceMinor === null) !== (priceScope === null) ||
    (r.priceScope !== null && priceScope === null) ||
    (r.priceMinor === null && r.expectedPriceMinor !== null) ||
    (r.productReference === null && priceScope !== "AllStores")
  )
    return fail("Invalid");
  const sectionCode =
    r.sectionCode === null ? null : typeof r.sectionCode === "string" ? r.sectionCode : "";
  if (sectionCode !== null && !/^[A-Z][A-Z0-9_-]{0,63}$/u.test(sectionCode)) return fail("Invalid");
  return {
    action: "SaveDish",
    operationReference: ref(r.operationReference),
    menuReference: ref(r.menuReference),
    productReference: r.productReference === null ? null : ref(r.productReference),
    sectionCode,
    name: text(r.name, 80, true),
    nameZh: text(r.nameZh, 80, false),
    description: text(r.description, 240, false),
    descriptionZh: text(r.descriptionZh, 240, false),
    taxClassificationReference: ref(r.taxClassificationReference),
    priceMinor: r.priceMinor === null ? null : amount(r.priceMinor),
    priceScope,
    expectedPriceMinor: r.expectedPriceMinor === null ? null : amount(r.expectedPriceMinor),
    choiceGroups,
    allergens,
    ...(choiceAllergens === undefined ? {} : { choiceAllergens }),
  };
}

/** A product code for a new dish, from its save (stable across retries). */
export function newDishCode(operationReference: string): string {
  return "DISH-" + operationReference.replaceAll("-", "").slice(-10).toUpperCase();
}

interface Session {
  readonly sessionCookie: unknown;
  readonly csrf: unknown;
}
interface ProductDetail {
  readonly productReference: string;
  readonly lifecycle: string;
  readonly aggregateVersion: number;
  readonly name: string;
  readonly nameZh: string;
  readonly taxClassificationReference: string;
  readonly sizes: readonly {
    readonly skuReference: string;
    readonly skuCode: string;
    readonly name: string;
    readonly nameZh: string;
    readonly lifecycle: string;
  }[];
  readonly optionSets: readonly {
    readonly optionSetReference: string;
    readonly enabledOptionReferences: readonly string[];
  }[];
  readonly presentation: {
    readonly description: string;
    readonly descriptionZh: string;
    readonly photo: { readonly imageReference: string; readonly altText: string } | null;
  };
}
interface MenuSection {
  readonly sectionReference: string;
  readonly code: string;
  readonly name: string;
  readonly nameZh?: string;
  readonly items: readonly { readonly skuReference: string; readonly featured: boolean }[];
}
interface MenuBuilder {
  readonly menu: {
    readonly aggregateVersion: number;
    readonly versionReference: string;
    readonly name: string;
    readonly sections: readonly MenuSection[];
    /** The Stores the menu serves (absent in older reads). */
    readonly storeReferences?: readonly string[];
  };
  /** The version's review and publication; null while it is being edited. */
  readonly publication: { readonly state: string } | null;
  /** The Brand's allergen list (absent or empty: the Brand has none yet). */
  readonly allergenChoices?: readonly unknown[];
  /**
   * The sizes on this version that the version guests saw before did not have (absent in older
   * reads: none, so the listing offers nothing at other Stores).
   */
  readonly addedToMenu?: readonly string[];
}
/** The menu read's sizes with where their allergens come from (as the menu page reads them). */
interface MenuAllergenView {
  readonly sellables?: readonly {
    readonly skuReference: string;
    readonly allergens?: {
      readonly source?: string;
      readonly declared?: readonly { allergenReference: string; classification: string }[];
      readonly noIngredients?: boolean;
      readonly unanswered?: readonly string[];
    };
  }[];
}

/**
 * Whether the allergens a save sends are what the dish already declares (by staff, every allergen
 * on the list answered): sending them again changes nothing guests read.
 */
export function sameAllergens(
  menu: MenuAllergenView,
  sku: string,
  sent: NonNullable<SaveDishBody["allergens"]>,
): boolean {
  const now = menu.sellables?.find((x) => x.skuReference === sku)?.allergens;
  if (now?.source !== "StaffDeclared" || (now.unanswered ?? []).length > 0) return false;
  if (sent === "ComboParts") return false;
  if (sent === "NoIngredients") return now.noIngredients === true;
  if (now.noIngredients === true) return false;
  const key = (answers: readonly { allergenReference: string; classification: string }[]) =>
    answers
      .filter((a) => a.classification !== "None")
      .map((a) => a.allergenReference + ":" + a.classification)
      .sort()
      .join(",");
  return key(sent) === key(now.declared ?? []);
}

export function createMerchantOneStoreDishes(options: {
  readonly products: Pick<ReturnType<typeof createMerchantProducts>, "query" | "command">;
  readonly prices: ReturnType<typeof createMerchantPrices>;
  readonly optionPrices: ReturnType<typeof createMerchantOptionPrices>;
  readonly menus: ReturnType<typeof createMerchantMenus>;
  readonly dishAllergens: ReturnType<typeof createMerchantDishAllergens>;
  readonly optionRecipes: ReturnType<typeof createMerchantOptionRecipes>;
  readonly availability: Pick<ReturnType<typeof createMerchantAvailability>, "query" | "command"> &
    Partial<Pick<ReturnType<typeof createMerchantAvailability>, "offerAtOtherStores">>;
  /** WP-2423 item 8 ⑥ part 4: combos (absent: combos cannot be saved; "List it" skips them). */
  readonly combos?: Pick<
    ReturnType<typeof createMerchantCombos>,
    "query" | "saveBundle" | "recordDish" | "listDrafts"
  >;
  readonly optionSets?: Pick<ReturnType<typeof createMerchantOptionSets>, "query" | "command">;
  /**
   * WP-2423 M70: this Store's own prices at a Brand with several Stores (absent: one price, the
   * Brand's).
   */
  readonly storePrices?: Pick<ReturnType<typeof createMerchantStorePrices>, "query" | "command">;
  readonly now: () => string;
}) {
  /**
   * v15 2026-10-28 finding d: guests at the store see a size only once it is offered there (an
   * availability rule); a size never decided at the store ("NotOffered", no rule) stays off the
   * guest menu whatever the menu says. A size staff hid keeps its stopped offer (decided here) and
   * is left alone.
   */
  const offerUndecided = async (
    session: Session,
    skuReferences: ReadonlySet<string>,
    step: (purpose: string) => string,
  ) => {
    const items = (
      (await options.availability.query(session)) as unknown as {
        items: readonly { skuReference: string; status: string; decidedHere?: boolean }[];
      }
    ).items;
    for (const item of items)
      if (
        skuReferences.has(item.skuReference) &&
        item.status === "NotOffered" &&
        item.decidedHere === false
      )
        await options.availability.command({
          ...session,
          body: {
            action: "Offer",
            operationReference: step("offer-" + item.skuReference.slice(-12)),
            skuReference: item.skuReference,
          },
        });
  };
  const loadMenu = async (session: Session, menuReference: string) =>
    (await options.menus.query({ ...session, menuReference })) as unknown as MenuBuilder;
  /** Opens the menu's draft when it was listed (the listed one stays for guests). */
  const editableMenu = async (session: Session, menuReference: string, step: string) => {
    let menu = await loadMenu(session, menuReference);
    if (menu.publication !== null) {
      await options.menus.command({
        ...session,
        body: {
          action: "Revise",
          operationReference: step,
          menuReference,
          expectedAggregateVersion: menu.menu.aggregateVersion,
        },
      });
      menu = await loadMenu(session, menuReference);
    }
    return menu;
  };

  /** WP-2423 M70: a dish's prices after a save: the Brand's, one waiting, and this Store's own. */
  interface SavedPrice {
    readonly brandPriceMinor: string | null;
    readonly pendingBrandPriceMinor: string | null;
    readonly storePriceMinor: string | null;
  }
  interface PriceList {
    readonly viewer: string;
    readonly allStores: { readonly multiStore: boolean; readonly mayList: boolean };
    readonly storeAssignment: { readonly priceBookReference: string } | null;
    readonly books: readonly {
      readonly priceBookReference: string;
      readonly lifecycle: string;
      readonly aggregateVersion: number;
      readonly purpose: "MenuListing" | "PriceChange" | null;
      readonly startedBy: string | null;
    }[];
  }
  interface PriceEditor {
    readonly book: {
      readonly aggregateVersion: number;
      readonly prices: readonly {
        readonly sellableReference: string;
        readonly amountMinor: string;
      }[];
    };
    readonly draftAuthor: string | null;
    readonly viewer: string;
  }
  const priceList = async (session: Session) =>
    (await options.prices.query({ ...session, priceBookReference: null })) as unknown as PriceList;
  const priceEditor = async (session: Session, priceBookReference: string) =>
    (await options.prices.query({ ...session, priceBookReference })) as unknown as PriceEditor;
  /** WP-2423 M71: the menu page's own open price draft (one per Brand), if any. */
  const menuDraftOf = (list: PriceList) =>
    list.books.find((book) => book.lifecycle === "Draft" && book.purpose === "MenuListing");

  /**
   * WP-2423 M70: a combo's Brand price now (waiting in the menu's draft, else in effect): the
   * combo editor has one price for every Store and no price of its own to compare.
   */
  const comboPriceNow = async (session: Session, sku: string | null) => {
    if (sku === null) return null;
    const list = await priceList(session);
    const draft = menuDraftOf(list);
    const read = async (book: string | undefined) =>
      book === undefined
        ? null
        : ((await priceEditor(session, book)).book.prices.find((p) => p.sellableReference === sku)
            ?.amountMinor ?? null);
    return (
      (await read(draft?.priceBookReference)) ??
      (await read(list.storeAssignment?.priceBookReference))
    );
  };

  /**
   * WP-2423 M70: a dish's price, where the person said. "This Store": the Store's own price,
   * live at once and recorded with who changed it. "All Stores": the Brand price, in the menu's own
   * price draft, live with "List it" (a Store with its own price keeps it). Either is compared with
   * the price the person saw for that scope; already the new price (a retried save) is done.
   */
  const savePrice = async (
    session: Session,
    body: SaveDishBody,
    sku: string,
    step: (purpose: string) => string,
  ): Promise<SavedPrice> => {
    const priceMinor = body.priceMinor ?? fail("Invalid");
    const list = await priceList(session);
    const multiStore = list.allStores.multiStore && options.storePrices !== undefined;
    const assigned =
      list.storeAssignment === null
        ? null
        : await priceEditor(session, list.storeAssignment.priceBookReference);
    const assignedBrand =
      assigned?.book.prices.find((p) => p.sellableReference === sku)?.amountMinor ?? null;
    // This Store's own price now (several Stores only).
    const ownNow = async () =>
      multiStore && options.storePrices !== undefined
        ? ((
            (await options.storePrices.query(session)) as unknown as {
              prices: readonly { sellableReference: string; storePriceMinor: string | null }[];
            }
          ).prices.find((p) => p.sellableReference === sku)?.storePriceMinor ?? null)
        : null;
    const waitingBrand = async () => {
      const open = menuDraftOf(await priceList(session));
      const price =
        open === undefined
          ? null
          : ((await priceEditor(session, open.priceBookReference)).book.prices.find(
              (p) => p.sellableReference === sku,
            )?.amountMinor ?? null);
      return price === assignedBrand ? null : price;
    };
    const answer = async (): Promise<SavedPrice> => ({
      brandPriceMinor: assignedBrand,
      pendingBrandPriceMinor: await waitingBrand(),
      storePriceMinor: await ownNow(),
    });
    if (body.priceScope === "ThisStore") {
      if (!multiStore || options.storePrices === undefined) return fail("Invalid");
      if (assignedBrand === null) return fail("NoBrandPriceYet");
      await options.storePrices.command({
        ...session,
        body: {
          action: "ChangeStorePrice",
          operationReference: step("store-price"),
          sellableReference: sku,
          expectedAmountMinor: body.expectedPriceMinor ?? fail("Invalid"),
          amountMinor: priceMinor,
        },
      });
      return answer();
    }
    let draft = menuDraftOf(list);
    const waiting =
      draft === undefined ? null : await priceEditor(session, draft.priceBookReference);
    const brandNow =
      waiting?.book.prices.find((p) => p.sellableReference === sku)?.amountMinor ?? assignedBrand;
    if (brandNow === priceMinor) return answer();
    if (brandNow !== body.expectedPriceMinor) return fail("PriceChanged");
    // Several Stores: an existing dish's price for all of them is the Brand Owner's to change.
    if (multiStore && assignedBrand !== null && !list.allStores.mayList)
      return fail("NeedsBrandOwner");
    if (waiting !== null && waiting.draftAuthor !== null && waiting.draftAuthor !== waiting.viewer)
      return fail("OthersPending");
    let editor = waiting;
    if (draft === undefined || editor === null) {
      const created = (await options.prices.command({
        ...session,
        body: {
          action: "CreateDraft",
          operationReference: step("price-book"),
          copyFrom: list.storeAssignment?.priceBookReference ?? null,
          purpose: "MenuListing",
        },
      })) as { priceBookReference: string };
      editor = await priceEditor(session, created.priceBookReference);
      draft = {
        priceBookReference: created.priceBookReference,
        lifecycle: "Draft",
        aggregateVersion: editor.book.aggregateVersion,
        purpose: "MenuListing",
        startedBy: editor.viewer,
      };
    }
    if (editor.book.prices.find((p) => p.sellableReference === sku)?.amountMinor !== priceMinor)
      await options.prices.command({
        ...session,
        body: {
          action: "SaveDraft",
          operationReference: step("price"),
          priceBookReference: draft.priceBookReference,
          expectedAggregateVersion: editor.book.aggregateVersion,
          prices: [
            ...editor.book.prices.filter((p) => p.sellableReference !== sku),
            { sellableReference: sku, amountMinor: priceMinor },
          ],
        },
      });
    return answer();
  };

  /**
   * `choiceItems` (combos): the item each choice adds to the dish's recipe — the chosen dish's
   * staff-declared allergen item — instead of "no change".
   */
  const saveDish = async (
    session: Session,
    body: SaveDishBody,
    choiceItems: ReadonlyMap<string, string> = new Map(),
    /** Told the dish (product and size) as soon as it exists (a combo records it at once). */
    onProduct?: (productReference: string, skuReference: string) => Promise<void>,
    /**
     * Save the product even when its fields and choices are unchanged: its choice group bindings
     * are recomputed from the groups as they are now (a combo re-saves its slots' groups first).
     */
    rebind = false,
  ) => {
    const step = (purpose: string) => derivedReference(body.operationReference, purpose);
    // WP-2423 (M76, Owner decision 16): a new food dish starts with every allergen unanswered and
    // is not saved until each one is answered, whichever client sends it. An existing dish not
    // declared yet still saves (its price, say); listing keeps refusing it until it is declared.
    if (
      body.productReference === null &&
      body.allergens === null &&
      ((await loadMenu(session, body.menuReference)).allergenChoices?.length ?? 0) > 0
    )
      return fail("AllergensUnanswered");
    const product = async (productReference: string) =>
      (
        (await options.products.query({ ...session, productReference })) as unknown as {
          product: ProductDetail;
        }
      ).product;
    // The dish as soon as it exists: any later failure says which one, so saving again continues
    // this dish instead of making a second one.
    let existing = body.productReference;
    try {
      return await saveDishSteps(
        session,
        body,
        choiceItems,
        onProduct,
        rebind,
        step,
        product,
        (r) => {
          existing = r;
        },
      );
    } catch (error) {
      const stopped = stoppedPartWay(error);
      if (existing !== null)
        Object.defineProperty(stopped, "productReference", { value: existing, enumerable: false });
      throw stopped;
    }
  };

  const saveDishSteps = async (
    session: Session,
    body: SaveDishBody,
    choiceItems: ReadonlyMap<string, string>,
    onProduct: ((productReference: string, skuReference: string) => Promise<void>) | undefined,
    rebind: boolean,
    step: (purpose: string) => string,
    product: (productReference: string) => Promise<ProductDetail>,
    known: (productReference: string) => void,
  ) => {
    // WP-2423 (v15 batch 5): a listed menu opens its draft just before the first write that
    // "List it" must put live, so a save stopped after that write still leaves it to be listed
    // (a retry finds the dish already changed and writes nothing more). A price at this Store
    // only is live at once: a save that changed nothing else opens no draft, and the page never
    // says "saved changes not listed yet" with nothing to list.
    const opened: { menu: MenuBuilder | null; listingNeeded: boolean } = {
      menu: null,
      listingNeeded: false,
    };
    const forListing = async () => {
      opened.listingNeeded = true;
      opened.menu ??= await editableMenu(session, body.menuReference, step("menu-revise"));
      return opened.menu;
    };
    // 1. The product: names, descriptions, tax class and choice groups (one size). A command that
    // applied answers the product as it now is; a replay answers what it recorded back then, so
    // the product is read again.
    let productReference = body.productReference;
    let detail: ProductDetail | null = null;
    let createdNow = false;
    if (productReference === null) {
      await forListing();
      const code = newDishCode(body.operationReference);
      const created = (await options.products.command({
        ...session,
        body: {
          action: "Create",
          operationReference: step("product"),
          internalCode: code,
          productType: "PreparedFood",
          name: body.name,
          ...(body.nameZh ? { nameZh: body.nameZh } : {}),
          taxClassificationReference: body.taxClassificationReference,
          sizes: [
            {
              skuReference: null,
              skuCode: code + "-1",
              name: body.name,
              ...(body.nameZh ? { nameZh: body.nameZh } : {}),
            },
          ],
        },
      })) as unknown as { status: string; product: ProductDetail };
      productReference = created.product.productReference;
      createdNow = created.status === "Applied";
      if (createdNow) detail = created.product;
    }
    known(productReference);
    detail ??= await product(productReference);
    if (detail.sizes.length !== 1) return fail("ManySizes");
    const size = detail.sizes[0] ?? fail("NotFound");
    await onProduct?.(productReference, size.skuReference);
    const groups = body.choiceGroups.map((g) => ({
      optionSetReference: g.optionSetReference,
      enabledOptionReferences: g.options.map((o) => o.optionReference),
    }));
    const same =
      detail.name === body.name &&
      detail.nameZh === body.nameZh &&
      size.name === body.name &&
      size.nameZh === body.nameZh &&
      detail.taxClassificationReference === body.taxClassificationReference &&
      detail.presentation.description === body.description &&
      detail.presentation.descriptionZh === body.descriptionZh &&
      JSON.stringify(detail.optionSets) === JSON.stringify(groups);
    if (!same || rebind) {
      await forListing();
      const saved = (await options.products.command({
        ...session,
        body: {
          action: "SaveDraft",
          operationReference: step("product-save"),
          productReference,
          expectedAggregateVersion: detail.aggregateVersion,
          name: body.name,
          nameZh: body.nameZh,
          taxClassificationReference: body.taxClassificationReference,
          sizes: [
            {
              skuReference: size.skuReference,
              skuCode: size.skuCode,
              name: body.name,
              nameZh: body.nameZh,
            },
          ],
          optionSets: groups,
          presentation: {
            description: body.description,
            descriptionZh: body.descriptionZh,
            photo:
              detail.presentation.photo === null
                ? null
                : {
                    imageReference: detail.presentation.photo.imageReference,
                    altText: detail.presentation.photo.altText,
                  },
          },
        },
      })) as unknown as { status: string; product: ProductDetail };
      detail = saved.status === "Applied" ? saved.product : await product(productReference);
    }
    if (detail.lifecycle !== "Active" || detail.sizes.some((s) => s.lifecycle !== "Active")) {
      await forListing();
      await options.products.command({
        ...session,
        body: {
          action: "StartSelling",
          operationReference: step("start"),
          productReference,
          expectedAggregateVersion: detail.aggregateVersion,
        },
      });
    }
    const sku = size.skuReference;
    // A new dish is offered at the store (one store: the store it was made for). One created just
    // now has no decision to read; on a replay, a dish staff hid since stays hidden.
    if (createdNow)
      await options.availability.command({
        ...session,
        body: {
          action: "Offer",
          operationReference: step("offer-" + sku.slice(-12)),
          skuReference: sku,
        },
      });
    else if (body.productReference === null) await offerUndecided(session, new Set([sku]), step);

    // 2. The price (M70): for every Store in the menu's own price draft (published by "List it"),
    // or at this Store only, at once. No price given: this save leaves it as it is.
    if (body.priceMinor !== null && body.priceScope !== "ThisStore") await forListing();
    const price = body.priceMinor === null ? null : await savePrice(session, body, sku, step);

    // 3. Choice prices (waiting until "List it").
    const wanted = new Map(
      body.choiceGroups.flatMap((g) => g.options.map((o) => [o.optionReference, o.amountMinor])),
    );
    if (wanted.size > 0) {
      const view = (await options.optionPrices.query({
        ...session,
        productReference,
      })) as unknown as {
        products: readonly {
          productReference: string;
          optionSets: readonly {
            bindingReference: string;
            options: readonly {
              optionReference: string;
              aggregateVersion: number | null;
              priceMinor: string | null;
              pending: { priceMinor: string; byViewer: boolean } | null;
            }[];
          }[];
        }[];
      };
      const rows = (
        view.products.find((p) => p.productReference === productReference)?.optionSets ?? []
      ).flatMap((set) =>
        set.options.map((option) => ({ ...option, bindingReference: set.bindingReference })),
      );
      const prices = rows.flatMap((row) => {
        const want = wanted.get(row.optionReference);
        if (want === undefined) return [];
        const current = row.pending?.priceMinor ?? row.priceMinor;
        if (current === want) return [];
        if (row.pending !== null && !row.pending.byViewer) return fail("OthersPending");
        return [
          {
            bindingReference: row.bindingReference,
            optionReference: row.optionReference,
            amountMinor: want,
            expectedAggregateVersion: row.aggregateVersion,
            replacesPending: row.pending !== null,
          },
        ];
      });
      if (prices.length > 0) await forListing();
      if (prices.length > 0)
        await options.optionPrices.command({
          ...session,
          productReference,
          body: { action: "SetPrices", operationReference: step("choice-prices"), prices },
        });
    }

    // 4. Its place on the menu (moved to the chosen section, last), in an open draft. No section
    // given: the place stays.
    const read = opened.menu ?? (await loadMenu(session, body.menuReference));
    if (body.sectionCode !== null) {
      const placedIn = (m: MenuBuilder) => {
        const target = m.menu.sections.find((s) => s.code === body.sectionCode);
        if (target === undefined) return fail("NoSection");
        return {
          placed: target.items.some((item) => item.skuReference === sku),
          elsewhere: m.menu.sections.some(
            (s) => s.code !== body.sectionCode && s.items.some((item) => item.skuReference === sku),
          ),
        };
      };
      const before = placedIn(read);
      if (!before.placed || before.elsewhere) {
        const menu = await forListing();
        const { placed } = placedIn(menu);
        await options.menus.command({
          ...session,
          body: {
            action: "SaveDraft",
            operationReference: step("menu"),
            menuReference: body.menuReference,
            expectedAggregateVersion: menu.menu.aggregateVersion,
            name: menu.menu.name,
            sections: menu.menu.sections.map((s) => ({
              sectionReference: s.sectionReference,
              code: s.code,
              name: s.name,
              nameZh: s.nameZh ?? "",
              items: [
                ...s.items.filter((item) => item.skuReference !== sku),
                ...(s.code === body.sectionCode && !placed
                  ? [{ skuReference: sku, featured: false }]
                  : []),
              ].map((item) => ({ skuReference: item.skuReference, featured: item.featured })),
            })),
          },
        });
      }
    }

    // 5. Its allergens, declared by staff (a generated recipe; a real recipe is kept). A first
    // declaration, or different answers, are reviewed when the menu is listed.
    if (body.allergens !== null && !sameAllergens(read as MenuAllergenView, sku, body.allergens))
      await forListing();
    if ((body.choiceAllergens ?? []).length > 0) await forListing();
    if (body.allergens !== null)
      await options.dishAllergens.command({
        ...session,
        body:
          body.allergens === "NoIngredients"
            ? {
                action: "DeclareNoIngredients",
                operationReference: step("allergens"),
                skuReference: sku,
              }
            : {
                action: "DeclareDish",
                operationReference: step("allergens"),
                skuReference: sku,
                allergens: body.allergens === "ComboParts" ? [] : body.allergens,
              },
        ...(body.allergens === "ComboParts" ? { comboWithoutOwnAllergens: true as const } : {}),
      });

    // 6. A "no change" option recipe for each of its choices that has none yet, a few choices per
    // transaction (WP-2423 item 3: one authorization each, not one command per step per choice).
    let choicesWaiting = false;
    // WP-2423 (M166): each choice answered in this save: what it adds becomes its own stand-in,
    // which its option recipe adds ("adds none": no change). Its answer replaces a published "no
    // change" or an earlier answer; a real recipe change set under Option recipes is kept.
    const restated = new Set<string>();
    const answeredItems = new Map<string, string>();
    // WP-2423 (M166 with M77): what the answers in this save add to the dish.
    const choiceAdds = new Map<
      string,
      {
        readonly allergenReference: string;
        readonly classification: "Contains" | "CrossContactPossible";
      }
    >();
    for (const choice of body.choiceAllergens ?? []) {
      restated.add(choice.optionReference);
      const declared = await options.dishAllergens.declareChoice({
        ...session,
        operationReference: step("choice-allergens-" + choice.optionReference.slice(-12)),
        skuReference: sku,
        optionReference: choice.optionReference,
        choiceName: choice.name,
        declared: choice.declared,
      });
      if (choice.declared.length > 0)
        answeredItems.set(choice.optionReference, declared.itemReference);
      for (const added of declared.adds)
        if (choiceAdds.get(added.allergenReference)?.classification !== "Contains")
          choiceAdds.set(added.allergenReference, added);
    }
    if (wanted.size > 0) {
      const choices = new Map(
        [...wanted.keys()].map((option) => [
          option,
          choiceItems.get(option) ?? answeredItems.get(option) ?? null,
        ]),
      );
      let left = Number.POSITIVE_INFINITY;
      for (;;) {
        const round = await options.optionRecipes.coverDishChoices({
          ...session,
          operationReference: body.operationReference,
          productReference,
          skuReference: sku,
          choices,
          restated,
        });
        if (round.waitingForAllergens) {
          // A dish whose allergens simply are not declared yet saves: declaring them later covers
          // its choices. A combo declares its own, and allergens sent in this save should have
          // given it a recipe: there, no recipe is a real failure and stays one.
          if (body.allergens !== null || choiceItems.size > 0)
            throw new MerchantOptionRecipeError("NoRecipe", sku);
          choicesWaiting = true;
          break;
        }
        if (round.remaining === 0) break;
        // A round that covered nothing would never finish.
        if (round.remaining >= left) return fail("StoppedPartWay");
        left = round.remaining;
      }
    }
    // Choices now in use that add an allergen reach guests and the kitchen on the listed menu.
    if (!choicesWaiting && choiceAdds.size > 0)
      await options.dishAllergens.recordChoiceAllergenChange({
        ...session,
        operationReference: body.operationReference,
        skuReference: sku,
        adds: [...choiceAdds.values()],
      });
    return {
      status: "Saved" as const,
      productReference,
      skuReference: sku,
      choicesWaiting,
      // WP-2423 M70: the dish's prices as this save left them (null: no price was sent).
      price,
      // WP-2423 (v15 batch 5): something waits for "List it" — what this save changed, or what an
      // earlier save (or this one's own lost first answer) left in the menu's open draft. False
      // only when the menu is listed as it is: a price at this Store only, live now.
      listingNeeded:
        opened.listingNeeded ||
        (await loadMenu(session, body.menuReference)).publication?.state !== "Published",
    };
  };

  /**
   * WP-2423 item 8 ⑥ part 4: a combo saved from the one-page menu. Each slot becomes a choice
   * group (its own, coded for the combo) whose choices stand for the slot's dishes; the combo is
   * saved as a Bundle draft with which dish each choice stands for; then it is saved as a dish at
   * the combo price with those choice groups (extra prices per choice), through the dish save
   * above. Every step is keyed by the operation, so retrying the same save continues.
   */
  const saveCombo = async (session: Session, body: SaveComboBody) => {
    if (options.combos === undefined || options.optionSets === undefined) return fail("NotFound");
    const { combos, optionSets } = options;
    const step = (purpose: string) => derivedReference(body.operationReference, purpose);
    const known = (await combos.query(session)).combos;
    const current: ComboView | null =
      body.bundleReference === null
        ? null
        : (known.find((c) => c.bundleReference === body.bundleReference) ?? fail("NotFound"));
    const bundleOperation = step("bundle-save");
    const bundleReference = body.bundleReference ?? derivedReference(bundleOperation, "bundle");
    const menu = (await loadMenu(session, body.menuReference)) as MenuBuilder & {
      sellables: readonly {
        skuReference: string;
        productName: string;
        productNameZh: string;
        sizeName: string;
        active: boolean;
        allergens?: { source: string; itemReference?: string | null };
      }[];
    };
    const comboSkus = new Set(
      known.flatMap((c) => (c.skuReference === null ? [] : [c.skuReference])),
    );
    const dishLabel = (sku: string) => {
      const found = menu.sellables.find((x) => x.skuReference === sku && x.active);
      if (found === undefined || comboSkus.has(sku)) return fail("NotADish");
      // Guests see each dish's allergens in the combo: from what staff declared for the dish.
      if (found.allergens?.source === "Recipe") return fail("DishHasRecipe");
      if (found.allergens?.source !== "StaffDeclared" || !found.allergens.itemReference)
        return fail("DishAllergensMissing");
      const sized = found.sizeName !== "" && found.sizeName !== found.productName;
      return {
        name: sized ? found.productName + " — " + found.sizeName : found.productName,
        nameZh: found.productNameZh,
        itemReference: found.allergens.itemReference,
      };
    };
    const used = new Set(body.slots.flatMap((slot) => (slot.code === null ? [] : [slot.code])));
    const nextCode = () => {
      let n = 1;
      while (used.has("SLOT-" + n)) n++;
      used.add("SLOT-" + n);
      return "SLOT-" + n;
    };
    const slots: ComboSlot[] = [];
    for (const [index, slot] of body.slots.entries()) {
      const code = slot.code ?? nextCode();
      const history = (current?.choiceHistory ?? []).filter((c) => c.groupCode === code);
      const optionSetReference = history[0]?.optionSetReference ?? null;
      const labels = slot.dishes.map((d) => dishLabel(d.skuReference));
      const setBody = {
        name: slot.name,
        nameZh: slot.nameZh,
        kind: slot.maximum === 1 ? ("One" as const) : ("Any" as const),
        minimum: slot.minimum,
        maximum: slot.maximum,
        perOptionMaximum: 1,
        options: slot.dishes.map((dish, i) => ({
          optionReference:
            history.find((c) => c.dishSkuReference === dish.skuReference)?.optionReference ?? null,
          name: labels[i]?.name ?? "",
          nameZh: labels[i]?.nameZh ?? "",
          offered: true,
          // A required slot starts with its first dish(es) chosen (the guest can change them).
          defaultChoice: i < slot.minimum,
        })),
      };
      const saved = (optionSetReference === null
        ? await optionSets.command({
            ...session,
            body: {
              action: "Create",
              operationReference: step("slot-set-" + index),
              internalCode: "COMBO-" + bundleReference.slice(-12).toUpperCase() + "-" + code,
              ...setBody,
            },
          })
        : await (async () => {
            const existing = (await optionSets.query({ ...session, optionSetReference })) as {
              optionSet: { aggregateVersion: number };
            };
            return optionSets.command({
              ...session,
              body: {
                action: "Save",
                operationReference: step("slot-set-" + index),
                optionSetReference,
                expectedAggregateVersion: existing.optionSet.aggregateVersion,
                ...setBody,
              },
            });
          })()) as unknown as {
        optionSet: {
          optionSetReference: string;
          options: readonly { optionReference: string; name: string }[];
        };
      };
      // The listed choices come first, in the order given.
      slots.push({
        code,
        name: slot.name,
        nameZh: slot.nameZh,
        minimum: slot.minimum,
        maximum: slot.maximum,
        optionSetReference: saved.optionSet.optionSetReference,
        dishes: slot.dishes.map((dish, i) => {
          const option = saved.optionSet.options[i];
          if (option === undefined || option.name !== labels[i]?.name) return fail("NotFound");
          return { ...dish, optionReference: option.optionReference };
        }),
      });
    }
    await combos.saveBundle({
      ...session,
      body: {
        operationReference: bundleOperation,
        bundleReference: body.bundleReference,
        expectedAggregateVersion: body.expectedAggregateVersion,
        name: body.name,
        nameZh: body.nameZh,
        description: body.description,
        descriptionZh: body.descriptionZh,
        priceMinor: body.priceMinor,
        slots,
      },
    });
    const dish = await saveDish(
      session,
      {
        action: "SaveDish",
        operationReference: step("dish"),
        menuReference: body.menuReference,
        productReference: current?.productReference ?? null,
        sectionCode: body.sectionCode,
        name: body.name,
        nameZh: body.nameZh,
        description: body.description,
        descriptionZh: body.descriptionZh,
        taxClassificationReference: body.taxClassificationReference,
        priceMinor: body.priceMinor,
        // A combo has one price, the Brand's; what was there is what the combo editor showed.
        priceScope: "AllStores",
        expectedPriceMinor: await comboPriceNow(session, current?.skuReference ?? null),
        choiceGroups: slots.map((slot) => ({
          optionSetReference: slot.optionSetReference,
          options: slot.dishes.map((d) => ({
            optionReference: d.optionReference,
            amountMinor: d.upgradeMinor,
          })),
        })),
        // The combo itself declares no allergens of its own (its recipe holds the kitchen step);
        // each choice adds its dish's. A combo stopped before this step has no recipe yet, so
        // saving it again declares it now.
        allergens:
          current?.dishRecorded === true &&
          (menu.sellables.find((x) => x.skuReference === current.skuReference)?.allergens?.source ??
            "None") !== "None"
            ? null
            : "ComboParts",
      },
      new Map(
        slots.flatMap((slot) =>
          slot.dishes.map((d) => [d.optionReference, dishLabel(d.skuReference).itemReference]),
        ),
      ),
      // v15 2026-10-29 finding a: the dish is the combo's from the moment it exists, so a save
      // stopped later (a choice recipe, a price) is finished by saving the combo again.
      async (productReference, skuReference) => {
        if (current?.dishRecorded === true) return;
        await combos.recordDish({ ...session, bundleReference, productReference, skuReference });
      },
      // v15 2026-10-29: the slots' groups were just saved (a dish's place, a part's first dish may
      // have changed); the combo's bindings are recomputed from them, never left stale.
      true,
    );
    return {
      status: "Saved" as const,
      bundleReference,
      productReference: dish.productReference,
      skuReference: dish.skuReference,
    };
  };

  /** "List it": the open price book, the waiting choice prices and the menu, alone at one store. */
  const listAll = async (session: Session, body: ListAllBody) => {
    const step = (purpose: string) => derivedReference(body.operationReference, purpose);
    // WP-2423 (v15 2026-11-05): a choice group turned into "a quantity of each" under Option sets:
    // its "no change" option recipes are carried to the new quantities first (a real change stays
    // for a person, and the check below names it). A stop here comes before anything is listed.
    let menu = await loadMenu(session, body.menuReference);
    // WP-2423 (M77, M167): a recipe bound or ended since the listing changed what a listed dish
    // contains. Guests already read it with the listed allergens; listing again reviews the menu
    // as it is now, so its own version is opened (the listed one stays for guests meanwhile).
    if (
      menu.publication !== null &&
      (
        (menu as { readonly sellables?: readonly { allergens?: { changedByRecipe?: unknown } }[] })
          .sellables ?? []
      ).some((sku) => sku.allergens?.changedByRecipe === true)
    )
      menu = await editableMenu(session, body.menuReference, step("recipe-allergens"));
    const skus = new Set(
      menu.menu.sections.flatMap((s) => s.items.map((item) => item.skuReference)),
    );
    // WP-2423 M71: the menu's own price draft must be the one the review showed, unchanged; a
    // price change started on the Prices page is never listed from here.
    const priceBooks = await priceList(session);
    const menuDraft = menuDraftOf(priceBooks);
    const confirmed = body.confirmedPriceBook;
    if (
      menuDraft === undefined
        ? confirmed !== null &&
          !priceBooks.books.some(
            (b) =>
              b.priceBookReference === confirmed.priceBookReference &&
              b.lifecycle === "Published" &&
              b.purpose === "MenuListing",
          )
        : confirmed === null ||
          confirmed.priceBookReference !== menuDraft.priceBookReference ||
          confirmed.aggregateVersion !== menuDraft.aggregateVersion
    )
      return fail("PricesChangedSinceShown");
    // WP-2423 M69: the menu's own check first. A dish whose allergens nobody answered (no recipe)
    // is refused at once, before the slow carrying of choices below; any other gap may be one that
    // carrying fixes, so it goes on and the check runs again after it.
    const checked = await options.menus
      .command({ ...session, body: { action: "Check", menuReference: body.menuReference } })
      .then(
        () => true,
        (error: unknown) => {
          const missing = (error as { problem?: { missing?: unknown } } | null)?.problem?.missing;
          if (error instanceof Error && error.name === "MerchantMenuError" && missing === "Recipe")
            throw error;
          return false;
        },
      );
    if (!checked) {
      try {
        await options.optionRecipes.extendNoChangeChoices({
          ...session,
          operationReference: body.operationReference,
          skuReferences: skus,
        });
      } catch (error) {
        // Not allowed to read or set option recipes: nothing is carried over, and the check below
        // names any choice that needs a person (as it did before).
        if (!(error instanceof MerchantOptionRecipeError && error.code === "PermissionDenied"))
          throw Object.assign(new MerchantOneStoreDishError("ChoiceRecipesStopped"), {
            cause: error,
          });
      }
      // v15 2026-10-29 finding c: nothing is published while the menu itself could not be listed
      // (its tax, choice recipes or allergen list): prices never go live ahead of their menu.
      await options.menus.command({
        ...session,
        body: { action: "Check", menuReference: body.menuReference },
      });
    }
    // Combos with saved changes first: each is listed alone at the Brand's one store.
    if (options.combos !== undefined)
      await options.combos.listDrafts({ ...session, operationReference: step("combos") });
    // The menu's own price draft: listed alone at the Brand's one Store by its author, or by the
    // Brand Owner at several; someone else's draft is published as a review (its author never
    // approves it). Retrying after it was published goes on to assign it.
    const listing = menuDraft?.priceBookReference ?? confirmed?.priceBookReference ?? null;
    if (listing !== null) {
      if (menuDraft !== undefined)
        await options.prices.command({
          ...session,
          body: {
            action: "Publish",
            operationReference: step("publish-" + listing.slice(-12)),
            priceBookReference: listing,
            expectedAggregateVersion: menuDraft.aggregateVersion,
            ...(menuDraft.startedBy === null || menuDraft.startedBy === priceBooks.viewer
              ? { approvalMode: "SingleStoreListing" }
              : {}),
          },
        });
      await options.prices.command({
        ...session,
        body: {
          action: "AssignToStore",
          operationReference: step("assign-" + listing.slice(-12)),
          priceBookReference: listing,
        },
      });
    }
    const waiting = await options.optionPrices.waiting(session);
    if (waiting.some((rule) => !rule.byViewer)) return fail("OthersPending");
    // A drinks menu easily waits on more choice prices than one publish takes; a retry after a
    // stop part-way carries on from what is still waiting.
    for (let at = 0; at < waiting.length; at += OPTION_PRICE_PUBLISH_LIMIT) {
      const rules = waiting.slice(at, at + OPTION_PRICE_PUBLISH_LIMIT).map((rule) => ({
        ruleReference: rule.ruleReference,
        expectedAggregateVersion: rule.aggregateVersion,
      }));
      await options.optionPrices.command({
        ...session,
        body: {
          action: "Publish",
          operationReference: step("choice-prices-" + (rules[0]?.ruleReference ?? "")),
          rules,
          approvalMode: "SingleStoreListing",
        },
      });
    }
    // Every dish on the menu that was never decided at the store is offered with it (read again:
    // listing its combos may have changed it).
    const listed = await loadMenu(session, body.menuReference);
    const onMenu = new Set(
      listed.menu.sections.flatMap((s) => s.items.map((item) => item.skuReference)),
    );
    await offerUndecided(session, onMenu, step);
    const result = await options.menus.command({
      ...session,
      body: { action: "List", operationReference: step("menu"), menuReference: body.menuReference },
    });
    // WP-2423 (v15 batch 5): at a Brand with several Stores, the dishes this listing adds to the
    // menu go on sale at its other Stores too, where nobody decided them — only once the menu is
    // listed (a refused listing offers nothing there), and never a dish guests could already see
    // on the menu (a Store that kept one hidden keeps it hidden). The review named each one with
    // its Store. A retry after the listing went through offers the same dishes (same keys).
    const added = new Set(listed.addedToMenu ?? []);
    if (added.size > 0)
      await options.availability.offerAtOtherStores?.({
        ...session,
        operationReference: step("offer-other-stores"),
        skuReferences: [...onMenu].filter((sku) => added.has(sku)),
        storeReferences: listed.menu.storeReferences ?? [],
      });
    return result;
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parseOneStoreDishBody(input.body);
    const session = { sessionCookie: input.sessionCookie, csrf: input.csrf };
    if (body.action === "SaveDish") return saveDish(session, body);
    try {
      return body.action === "SaveCombo"
        ? await saveCombo(session, body)
        : await listAll(session, body);
    } catch (error) {
      throw stoppedPartWay(error);
    }
  };
  return { command };
}
