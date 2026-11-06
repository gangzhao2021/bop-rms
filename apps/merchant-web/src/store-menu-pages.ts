import { t } from "./i18n/i18n.js";
import { parseSoleOperatorGate, type SoleOperatorGateView } from "./SoleOperatorSelfApproval.js";
import { newOperationReference } from "./operation-reference.js";
// The guest app's own menu reader, so staff are told exactly what guests cannot be shown.
import { guestUnreadableItems } from "../../customer-pwa/src/menu/menu-contract.js";
/** WP-2423 / DEC-MENU-REVISION: CAT-MENU-LIST / CAT-MENU-BUILDER view contract and same-origin client. */
export type MenuErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Conflict"
  | "Frozen"
  | "NotRevisable"
  | "NotDiscardable"
  | "ReviewBlocked"
  | "OptionPriceMissing"
  | "TaxNotCovered"
  | "OptionRecipeMissing"
  | "KitchenNotReady"
  | "ApprovalRequired"
  | "Lifecycle"
  | "Invalid"
  | "SoleOperatorNotInEffect"
  | "NeedsReverification"
  /** WP-2423 item 8 ⑥: listing without review needs a Brand with exactly one store. */
  | "NotSingleStore"
  /** WP-2423 item 8 ⑥ (declaring a dish's allergens): the Brand has no allergen list yet. */
  | "RegistryMissing"
  /** The store has no kitchen station for the dish's kitchen step. */
  | "NoKitchenStation"
  /** The dish has a real recipe; its allergens come from the recipe's ingredients. */
  | "RealRecipe"
  /** WP-2423 item 8 ⑦: the dish was declared the other way (allergens, or no stock ingredients). */
  | "DeclaredOtherwise"
  /** WP-2423 item 8 ⑥ (saving a dish): someone else's price changes wait to be listed. */
  | "OthersPending"
  /** The menu no longer has the chosen section. */
  | "NoSection"
  /** The dish has more than one size; sizes are edited on the product page. */
  | "ManySizes"
  /** WP-2423 item 8 ⑥ part 4: a combo offers something that is not a dish on sale. */
  | "NotADish"
  /** A dish the combo offers is no longer sold. */
  | "DishUnavailable"
  /** A dish in the combo has no allergens declared yet. */
  | "DishAllergensMissing"
  /** A dish in the combo has a real recipe (combos offer dishes with declared allergens). */
  | "DishHasRecipe"
  /**
   * WP-2423 (v15 2026-11-05): saving a dish refused a choice group that does not fit its option
   * set as it is now (no offered default, or a choice removed since the editor opened); the
   * problem names the dish and the group.
   */
  | "ChoiceGroup"
  /**
   * WP-2423 (v15 2026-11-05): "List it" stopped while carrying "no change" choices to a group's new
   * quantities, before anything was listed; listing again (same listing) finishes it.
   */
  | "ChoiceRecipesStopped"
  /**
   * v15 2026-10-29: a one-page menu save stopped at a later step (another page's command refused
   * it); what was saved before stays, and saving again goes on from there.
   */
  | "StoppedPartWay"
  /** WP-2423 M70: the price changed since the dish was opened. */
  | "PriceChanged"
  /** WP-2423 M70: several Stores: only the owner changes a dish's price for all of them. */
  | "NeedsBrandOwner"
  /** WP-2423 M70: a dish with no price yet takes its first price for every Store. */
  | "NoBrandPriceYet"
  /** WP-2423 M71: prices were saved after the "List it" review was shown. */
  | "PricesChangedSinceShown"
  /** WP-2423 M71: another price change went live after these menu prices were started. */
  | "PricesMoved"
  /** WP-2423 M69: dishes on the menu have no allergens answered yet. */
  | "AllergensUndeclared"
  /** WP-2423 M134: the Brand already has a choice group by that name. */
  | "CodeTaken"
  | "Offline"
  | "Unavailable";
export class MenuPageError extends Error {
  constructor(
    readonly code: MenuErrorCode,
    /** WP-2423 (v15 2026-10-22): what a blocked review found missing, when the server knows. */
    readonly problem: MenuReviewProblem | null = null,
    /** WP-2423 item 3: the dish exists although its save stopped; saving again continues it. */
    readonly productReference: string | null = null,
  ) {
    super(t("Menus are unavailable"));
    this.name = "MenuPageError";
  }
}
export interface MenuReviewProblem {
  readonly missing:
    | "Recipe"
    | "SubRecipe"
    | "OptionRecipe"
    | "AllergenDeclaration"
    | "AllergenList"
    /** Nothing was named missing; `reason` says why it stopped (WP-2423 item 14: never shown). */
    | "Stopped"
    /** 2026-10-31: an item is not taxed at one of the menu's Stores. */
    | "Tax"
    /** WP-2423 item 11: a Store's kitchen is not set up, or can't take this dish. */
    | "Kitchen"
    | "KitchenDish"
    /** WP-2423: the item has more choice combinations than one review checks. */
    | "TooManyChoices";
  readonly reason?: string;
  readonly productName: string | null;
  readonly sizeName: string | null;
  readonly optionName: string | null;
  readonly quantity: number | null;
  readonly ingredientName: string | null;
  /** The Store the gap is at (a menu served at several Stores), when named. */
  readonly storeName?: string | null;
  /** WP-2423 item 11: the Store whose kitchen setup fixes it. */
  readonly storeReference?: string | null;
}
const missingKinds = new Set<MenuReviewProblem["missing"]>([
  "Stopped",
  "Tax",
  "Kitchen",
  "KitchenDish",
  "TooManyChoices",
  "Recipe",
  "SubRecipe",
  "OptionRecipe",
  "AllergenDeclaration",
  "AllergenList",
]);
const optionalText = (value: unknown) =>
  typeof value === "string" && value.trim() && value.length <= 200 ? value.trim() : null;
export function parseMenuReviewProblem(value: unknown): MenuReviewProblem | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!missingKinds.has(raw.missing as MenuReviewProblem["missing"])) return null;
  const quantity = raw.quantity;
  const reason =
    typeof raw.reason === "string" && /^[A-Za-z0-9:_.@-]{1,120}$/u.test(raw.reason)
      ? raw.reason
      : undefined;
  return {
    missing: raw.missing as MenuReviewProblem["missing"],
    ...(reason === undefined ? {} : { reason }),
    productName: optionalText(raw.productName),
    sizeName: optionalText(raw.sizeName),
    optionName: optionalText(raw.optionName),
    quantity:
      typeof quantity === "number" && Number.isSafeInteger(quantity) && quantity >= 1
        ? quantity
        : null,
    ingredientName: optionalText(raw.ingredientName),
    storeName: optionalText(raw.storeName),
    storeReference:
      typeof raw.storeReference === "string" && /^[0-9a-f-]{36}$/u.test(raw.storeReference)
        ? raw.storeReference
        : null,
  };
}
/** WP-2423 item 11: where staff fix a blocked listing, when there is one place. */
export function menuReviewProblemFixHref(problem: MenuReviewProblem | null): string | null {
  return problem?.storeReference
    ? "/app/organization/stores/" + problem.storeReference + "/setup#kitchen-setup"
    : null;
}
/**
 * WP-2423 item 14: why a listing stopped, in plain words: what to do, never a code or file name.
 * The server sends a reason from a closed list; an older answer (`Check:NoAllergenList`) is read by
 * its last part, and anything else gets the general sentence (the log has the cause). That sentence
 * promises nothing about guests: a stop at the last step leaves new prices already showing.
 */
function menuStopText(
  reason: string | undefined,
  item: string,
  group: string | null,
  saving: boolean,
): string {
  switch (reason?.split(":").at(-1)) {
    case "ChoiceGroupDefault":
      // Only Option sets can fix it: saving the dish again would be refused the same way.
      return group === null
        ? saving
          ? t(
              "{item}: one of its choice groups has no choice guests start with that is still offered. Under Option sets, offer that choice again, or let another choice be the default. Then save the dish.",
              { item },
            )
          : t(
              "{item}: one of its choice groups has no choice guests start with that is still offered. Under Option sets, offer that choice again, or let another choice be the default. Then list the menu again. Nothing was listed.",
              { item },
            )
        : saving
          ? t(
              "{item}: {group} has no choice guests start with that is still offered. Under Option sets, open {group} and offer that choice again, or let another choice be the default. Then save the dish.",
              { item, group },
            )
          : t(
              "{item}: {group} has no choice guests start with that is still offered. Under Option sets, open {group} and offer that choice again, or let another choice be the default. Then list the menu again. Nothing was listed.",
              { item, group },
            );
    case "ChoiceGroupOption":
      return group === null
        ? t(
            "{item}: a choice in one of its groups was removed. Close the dish, open it again and save it.",
            {
              item,
            },
          )
        : t("{item}: a choice in {group} was removed. Close the dish, open it again and save it.", {
            item,
            group,
          });
    case "NoAllergenList":
      // A new merchant's first listing: the one step this page can name for them.
      return t(
        "Approve your allergen list first: open Allergens, approve the list, then list the menu.",
      );
    case "AllergenListChanged":
      return t("The allergen list changed while this was being checked. List the menu again.");
    case "AllergenEvidenceDiffers":
      return t(
        "{item}: what it declares no longer matches the approved allergen list. Open the dish, check its allergens, save it, then list the menu again.",
        { item: item },
      );
    case "NoAllergenEvidence":
      return t(
        "{item} has no allergen answers yet. Open the dish, answer each allergen, save it, then list the menu again.",
        { item: item },
      );
    case "NoDraft":
      return t("There is nothing new to list.");
    case "NotAuthorized":
      return t("Your sign-in no longer allows listing this menu. Ask the Owner to list it.");
    case "NoConfiguration":
      return t(
        "This menu has no dishes ready to list yet. Add a dish, answer its allergens, then list the menu.",
      );
    case "ChoiceGroup":
      return group === null
        ? t(
            "{item}: one of its choices no longer fits its choice group (an option was removed, or a default is no longer offered). Open the dish, check its choices, save it, then list the menu again.",
            { item: item },
          )
        : t(
            "{item}: its choices in {group} changed. Open the dish, check its choices, save it, then list the menu again.",
            { item, group },
          );
    default:
      return t(
        "The menu could not be listed this time. Try again in a minute; if it stops again, tell BOP support what time it happened.",
      );
  }
}
/**
 * The blocked review in staff words: which item, size, option or ingredient, and where to fix it.
 * `saving`: the refusal came from saving a dish (its next step is saving it), not from listing.
 */
export function menuReviewProblemText(problem: MenuReviewProblem, saving = false): string {
  const item =
    problem.productName === null
      ? t("An item on this menu")
      : problem.sizeName === null || problem.sizeName === problem.productName
        ? problem.productName
        : `${problem.productName} — ${problem.sizeName}`;
  const option =
    problem.optionName === null
      ? null
      : problem.quantity !== null && problem.quantity > 1
        ? `${problem.optionName} × ${problem.quantity}`
        : problem.optionName;
  switch (problem.missing) {
    case "TooManyChoices":
      // Found before anything of the listing went live: no price moved.
      return t(
        "{item} has too many choice combinations to list. Remove a choice or split it into two dishes. Nothing was changed.",
        { item: item },
      );
    case "Kitchen":
      return t(
        "The kitchen at {store} is not set up, so its orders could not reach a kitchen and guests can't order there yet. Set it up in that Store's Store setup, then list this menu again.",
        { store: problem.storeName ?? t("one of this menu's Stores") },
      );
    case "KitchenDish":
      return t(
        "{item} can't go to the kitchen at {store}: its recipe needs something that kitchen isn't set up for. Fix it under Kitchen in that Store's Store setup, then list this menu again.",
        { item: item, store: problem.storeName ?? t("one of this menu's Stores") },
      );
    case "Stopped":
      return menuStopText(problem.reason, item, problem.optionName, saving);
    case "Tax":
      return problem.storeName
        ? t(
            "{item} has no tax rate for one of this menu's order types at {store}, so guests there could not be quoted. Check {store}'s Tax review, or the product's tax class, then list it again.",
            { item: item, store: problem.storeName },
          )
        : t(
            "{item} has no tax rate for one of this menu's order types at one of its Stores. Check that Store's Tax review, or the product's tax class, then list it again.",
            { item: item },
          );
    case "Recipe":
      if (problem.storeName)
        return t(
          "{item} has no recipe at {store}: its recipe is assigned to another Store only, or to none. Under Recipes, assign its recipe to this size for the whole Brand (not this store only), then list it again.",
          { item: item, store: problem.storeName },
        );
      return t(
        "{item} has no allergens declared. Declare its allergens in this menu, or publish a recipe under Recipes and assign it to this size. Then list it again.",
        { item: item },
      );
    case "SubRecipe":
      return t(
        "A recipe used in {item} is not published. Publish it under Recipes, then submit again.",
        { item: item },
      );
    case "OptionRecipe":
      if (problem.storeName)
        return t(
          "{item} at {store}: the option {value} has no published recipe change for the recipe used there. Set, review and publish it under Option recipes, then list it again.",
          { item: item, store: problem.storeName, value: option ?? "chosen" },
        );
      return t(
        "{item}: the option {value} has no published recipe change. Set, review and publish it under Option recipes, then submit again.",
        { item: item, value: option ?? "chosen" },
      );
    case "AllergenDeclaration": {
      const ingredient =
        problem.ingredientName === null
          ? t("An ingredient")
          : t("The ingredient {ingredientName}", { ingredientName: problem.ingredientName });
      const where =
        option === null ? item : t("{item} with {option}", { item: item, option: option });
      return t(
        "{ingredient} in {where} has no current allergen declaration. Record or renew it under Allergens, then submit again.",
        { ingredient: ingredient, where: where },
      );
    }
    case "AllergenList":
      return t(
        "The Brand allergen list this menu uses is not approved. Approve it under Allergens, then submit again.",
      );
  }
}
export interface MenuPublicationStatus {
  readonly lifecycleReference: string;
  readonly lifecycleVersion: number;
  readonly state: string;
  readonly snapshotDigest: string;
  readonly changedAt: string;
}
export interface MenuReleaseSummary {
  readonly releaseReference: string;
  readonly sequence: number;
  readonly menuVersionReference: string;
  readonly createdAt: string;
}
/** WP-2423: a photo as customers see it (thumbnail of the reviewed photo, with its description). */
export interface MenuCustomerPhoto {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly altText: string;
}
export interface MenuCustomerViewItem {
  readonly placementReference: string;
  readonly skuReference: string;
  readonly sectionName: string;
  readonly name: string;
  readonly description: string | null;
  readonly photo: MenuCustomerPhoto | null;
  readonly newOnMenu: boolean | null;
  readonly descriptionChange: "Added" | "Changed" | "Removed" | null;
  readonly photoChange: "Added" | "Replaced" | "Removed" | "DescriptionChanged" | null;
  readonly before: {
    readonly description: string | null;
    readonly photo: MenuCustomerPhoto | null;
  } | null;
}
/** WP-2423: what customers will see, frozen in the review snapshot, against the published menu. */
export interface MenuCustomerView {
  readonly frozenAt: string;
  readonly comparedWithPublishedAt: string | null;
  readonly items: readonly MenuCustomerViewItem[];
  readonly removedFromMenu: readonly { readonly skuReference: string; readonly name: string }[];
}
export interface MenuSummary {
  readonly menuReference: string;
  readonly internalCode: string;
  readonly aggregateVersion: number;
  readonly currentVersionReference: string;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly placements: number;
  readonly publication: MenuPublicationStatus | null;
  readonly latestRelease: MenuReleaseSummary | null;
}
interface MenuViewBase {
  readonly sourceAsOf: string;
  readonly viewer: string;
  readonly permissions: {
    readonly mayRead: boolean;
    readonly mayEdit: boolean;
    readonly maySubmit: boolean;
    readonly mayApprove: boolean;
    readonly mayPublish: boolean;
  };
  readonly menus: readonly MenuSummary[];
}
export interface MenuListView extends MenuViewBase {
  readonly screenId: "CAT-MENU-LIST";
}
export interface MenuSellable {
  readonly skuReference: string;
  readonly skuCode: string;
  readonly productName: string;
  /** WP-2423 item 8 ⑥: the Chinese name ("" or absent when none). */
  readonly productNameZh?: string;
  readonly sizeName: string;
  readonly active: boolean;
  readonly priceMinor: string | null;
  /** WP-2423 item 8 ⑥: the dish (product) of the size, for its editor (absent in older views). */
  readonly productReference?: string;
  /** WP-2423 item 8 ⑥: what this Store will charge once listed, when different (null: none). */
  readonly pendingPriceMinor?: string | null;
  /** WP-2423 M70: the Brand price, and this Store's own price (null: it charges the Brand's). */
  readonly brandPriceMinor?: string | null;
  readonly storePriceMinor?: string | null;
  /** WP-2423 M70: a different Brand price waiting to be listed (null or absent: none). */
  readonly pendingBrandPriceMinor?: string | null;
  /** WP-2423: offered at the selected Store (Item availability); customers here see it only then.
   * Absent from older views: treated as offered. */
  readonly offeredHere?: boolean;
  /** WP-2423 item 8 ⑥: where the dish's allergens come from (absent from older views: None). */
  readonly allergens?: DishAllergens;
}
export type AllergenClassification = "Contains" | "CrossContactPossible";
export interface DishAllergens {
  /** Declared by staff in this page (labelled so, not a costed recipe), a real recipe, or not yet. */
  readonly source: "StaffDeclared" | "Recipe" | "None";
  /** WP-2423 item 8 ⑦: declared to use no stock ingredients (a charge such as tea); absent: no. */
  readonly noIngredients?: boolean;
  readonly declared: readonly {
    readonly allergenReference: string;
    readonly classification: AllergenClassification;
  }[];
}
export interface AllergenChoice {
  readonly allergenReference: string;
  readonly name: string;
  readonly nameZh: string;
}
/** WP-2423 item 8 ⑥: one dish as the one-page menu saves it (see merchant-one-store-dishes). */
export interface SaveDishCommand {
  readonly action: "SaveDish";
  readonly operationReference: string;
  readonly menuReference: string;
  readonly productReference: string | null;
  /** null only for a dish that exists: its place on the menu stays as it is. */
  readonly sectionCode: string | null;
  readonly name: string;
  readonly nameZh: string;
  readonly description: string;
  readonly descriptionZh: string;
  readonly taxClassificationReference: string;
  /** null only for a dish that exists: its price stays as it is. */
  readonly priceMinor: string | null;
  /** WP-2423 M70: where the price changes (null with no price). */
  readonly priceScope: "AllStores" | "ThisStore" | null;
  /** WP-2423 M70: the price seen for that scope (null: none). */
  readonly expectedPriceMinor: string | null;
  readonly choiceGroups: readonly {
    readonly optionSetReference: string;
    readonly options: readonly { readonly optionReference: string; readonly amountMinor: string }[];
  }[];
  /**
   * null: not declared in this save. "NoIngredients" (WP-2423 item 8 ⑦): a charge with no stock
   * ingredients, such as the per-head tea.
   */
  readonly allergens: DishAllergens["declared"] | "NoIngredients" | null;
}
/** WP-2423 item 8 ⑥ part 4: a combo saved from the one-page menu. */
export interface SaveComboCommand {
  readonly action: "SaveCombo";
  readonly operationReference: string;
  readonly menuReference: string;
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
    readonly code: string | null;
    readonly name: string;
    readonly nameZh: string;
    readonly minimum: number;
    readonly maximum: number;
    readonly dishes: readonly { readonly skuReference: string; readonly upgradeMinor: string }[];
  }[];
}
/** A combo as its editor reads it. */
export interface MenuCombo {
  readonly bundleReference: string;
  readonly aggregateVersion: number;
  readonly name: string;
  readonly nameZh: string;
  readonly description: string;
  readonly descriptionZh: string;
  readonly priceMinor: string;
  readonly productReference: string | null;
  readonly skuReference: string | null;
  /** Listed: guests get this version. Waiting: saved changes not listed yet. */
  readonly state: "Listed" | "Waiting";
  readonly slots: readonly {
    readonly code: string;
    readonly name: string;
    readonly nameZh: string;
    readonly minimum: number;
    readonly maximum: number;
    readonly dishes: readonly { readonly skuReference: string; readonly upgradeMinor: string }[];
  }[];
}
const comboText = (value: unknown) => (typeof value === "string" ? value : "");
export function parseMenuCombos(value: unknown): readonly MenuCombo[] {
  const list = (value as { combos?: unknown } | null)?.combos;
  if (!Array.isArray(list)) throw new MenuPageError("Unavailable");
  return list.map((candidate: unknown) => {
    const c = candidate as Record<string, unknown> | null;
    if (
      c === null ||
      typeof c !== "object" ||
      typeof c.bundleReference !== "string" ||
      typeof c.aggregateVersion !== "number" ||
      typeof c.priceMinor !== "string" ||
      (c.state !== "Listed" && c.state !== "Waiting") ||
      !Array.isArray(c.slots)
    )
      throw new MenuPageError("Unavailable");
    return {
      bundleReference: c.bundleReference,
      aggregateVersion: c.aggregateVersion,
      name: comboText(c.name),
      nameZh: comboText(c.nameZh),
      description: comboText(c.description),
      descriptionZh: comboText(c.descriptionZh),
      priceMinor: c.priceMinor,
      productReference: typeof c.productReference === "string" ? c.productReference : null,
      skuReference: typeof c.skuReference === "string" ? c.skuReference : null,
      state: c.state,
      slots: (c.slots as Record<string, unknown>[]).map((g) => ({
        code: comboText(g.code),
        name: comboText(g.name),
        nameZh: comboText(g.nameZh),
        minimum: Number(g.minimum),
        maximum: Number(g.maximum),
        dishes: (Array.isArray(g.dishes) ? (g.dishes as Record<string, unknown>[]) : []).map(
          (d) => ({
            skuReference: comboText(d.skuReference),
            upgradeMinor: comboText(d.upgradeMinor),
          }),
        ),
      })),
    };
  });
}
export interface ListAllCommand {
  readonly action: "ListAll";
  readonly operationReference: string;
  readonly menuReference: string;
  /** WP-2423 M71: the menu's own price draft as the review showed it (null: none waiting). */
  readonly confirmedPriceBook: {
    readonly priceBookReference: string;
    readonly aggregateVersion: number;
  } | null;
}
/** WP-2423 M71: the menu's own price draft, what "List it" publishes of prices. */
export interface MenuPriceDraft {
  readonly priceBookReference: string;
  readonly aggregateVersion: number;
  readonly startedByViewer: boolean;
  /** Another price change went live since it was started: it must be re-applied first. */
  readonly movedSinceStart: boolean;
  readonly prices: readonly {
    readonly skuReference: string;
    readonly fromMinor: string | null;
    readonly toMinor: string;
  }[];
}
export interface MenuBuilderView extends MenuViewBase {
  readonly screenId: "CAT-MENU-BUILDER";
  readonly menu: {
    readonly menuReference: string;
    readonly internalCode: string;
    readonly aggregateVersion: number;
    readonly versionReference: string;
    readonly name: string;
    readonly storeReferences: readonly string[];
    readonly channelCodes: readonly string[];
    readonly orderTypeCodes: readonly string[];
    readonly sections: readonly {
      readonly sectionReference: string;
      readonly code: string;
      readonly name: string;
      /** Owner 2026-10-23: the Simplified Chinese name customers see ("" or absent when none). */
      readonly nameZh?: string;
      readonly items: readonly {
        readonly placementReference: string;
        readonly skuReference: string;
        readonly featured: boolean;
      }[];
    }[];
  };
  readonly publication: MenuPublicationStatus | null;
  readonly latestRelease: MenuReleaseSummary | null;
  readonly submittedBy: string | null;
  /** WP-2423 Q19: present for a submitter who may approve: may they approve alone, and why not. */
  readonly soleOperator: SoleOperatorGateView | null;
  readonly sellables: readonly MenuSellable[];
  /** WP-2423: whether the viewer may offer items at this Store from the menu page. */
  readonly mayOfferHere?: boolean;
  readonly allergenRegistry: boolean;
  /** WP-2423: present once the version is frozen for review; absent from older views. */
  readonly customerView?: MenuCustomerView | null;
  /** WP-2423 item 8 ⑥: where "List it" would go on from, as the server decides it ("Listed":
   * guests already see this version). Absent from older views. */
  readonly listingStep?: "Listed" | "Submit" | "Approve" | "Publish" | "Stuck";
  /** WP-2423 item 8 ⑥: the Brand's allergen list staff declare from (absent: none). */
  readonly allergenChoices?: readonly AllergenChoice[];
  /** WP-2423 item 8 ⑥: the Brand keeps stock: declared allergens should become real recipes. */
  readonly keepsStock?: boolean;
  /**
   * DEC-BRAND-MULTI-STORE segment 9: whether the Brand has several Stores, and whether this menu
   * serves the selected Store. Absent from older views (one Store).
   */
  readonly stores?: { readonly severalStores: boolean; readonly servesHere: boolean };
  /** WP-2423 M71: the menu's own price draft (null or absent: none waiting). */
  readonly priceDraft?: MenuPriceDraft | null;
  /** WP-2423 M71: price changes started on the Prices page: never listed from here. */
  readonly priceChangesOnPricesPage?: number;
  /** WP-2423 M70: where this person may change a dish's price (absent: one Store). */
  readonly pricePowers?: {
    readonly severalStores: boolean;
    readonly mayAllStores: boolean;
    readonly mayThisStore: boolean;
  };
}
export interface MenuSectionInput {
  readonly sectionReference: string | null;
  readonly code: string;
  readonly name: string;
  readonly nameZh: string;
  readonly items: readonly { readonly skuReference: string; readonly featured: boolean }[];
}
export type MenuCommand =
  | {
      readonly action: "SaveDraft";
      readonly operationReference: string;
      readonly menuReference: string;
      readonly expectedAggregateVersion: number;
      readonly name: string;
      readonly sections: readonly MenuSectionInput[];
    }
  | {
      readonly action: "Revise";
      readonly operationReference: string;
      readonly menuReference: string;
      readonly expectedAggregateVersion: number;
    }
  | {
      /** WP-2423: discard the open draft; the menu goes back to its latest release. */
      readonly action: "DiscardDraft";
      readonly operationReference: string;
      readonly menuReference: string;
      readonly expectedAggregateVersion: number;
    }
  | {
      readonly action: "Submit";
      readonly operationReference: string;
      readonly menuReference: string;
    }
  | {
      readonly action: "Approve" | "Publish";
      readonly operationReference: string;
      readonly menuReference: string;
      readonly menuVersionReference: string;
      readonly expectedVersion: number;
      readonly snapshotDigest: string;
      /** WP-2423 Q19: the submitter approves alone as sole operator (Approve only). */
      readonly approvalMode?: "SoleOperator";
    }
  | {
      /** WP-2423 item 8 ⑥: "List it" at a single store (submit, approve as listing, publish). */
      readonly action: "List";
      readonly operationReference: string;
      readonly menuReference: string;
    }
  | {
      readonly action: "Rebuild";
      readonly operationReference: string;
      readonly menuReference: string;
      readonly publishOperationReference: string;
    };
export interface MenuClient {
  load(menuReference: string | null): Promise<unknown>;
  command?(command: MenuCommand): Promise<unknown>;
  /** WP-2423 item 8 ⑥: what the dish editor reads — the product (or the Brand's tax classes and
   * choice groups for a new dish) and the choice prices. */
  loadDish?(productReference: string | null): Promise<{ product: unknown; optionPrices: unknown }>;
  /** WP-2423 item 3 F: every dish's choices and prices, to see which dishes have a group. */
  loadChoicePrices?(): Promise<unknown>;
  /**
   * WP-2423 M71: the menu's price changes, started again from the prices in use now (another
   * change went live after they were made).
   */
  rebasePriceDraft?(priceBookReference: string, aggregateVersion: number): Promise<unknown>;
  /** WP-2423 item 8 ⑥: one dish saved, or everything listed. */
  oneStore?(command: SaveDishCommand | ListAllCommand | SaveComboCommand): Promise<unknown>;
  /** WP-2423 item 8 ⑥ part 4: the combos of the one-page menu. */
  combos?(): Promise<unknown>;
  /** WP-2423 item 8 ⑧: the kitchen sections (档口) and a dish's section (read, or change one). */
  kitchenSections?(
    command:
      | { readonly action: "Read"; readonly productReferences: readonly string[] }
      | {
          readonly action: "ChangeDish";
          readonly productReference: string;
          readonly operationReference: string;
          readonly expectedVersion: number;
          readonly sectionReference: string | null;
        },
  ): Promise<unknown>;
  /** WP-2423 item 8 ⑦: a dish's "not prepared by the kitchen" mark (read, or change one). */
  kitchenNotPrepared?(
    command:
      | { readonly action: "Read"; readonly productReferences: readonly string[] }
      | {
          readonly action: "Change";
          readonly productReference: string;
          readonly operationReference: string;
          readonly expectedVersion: number;
          readonly notPrepared: boolean;
        },
  ): Promise<unknown>;
  productAlcohol?(command: unknown): Promise<unknown>;
  /** WP-2423 item 8 ⑥ (v15 finding g): a simple choice group made from the dish editor. */
  createChoiceGroup?(command: NewChoiceGroupCommand): Promise<unknown>;
  /**
   * Owner 2026-10-29: the listed items guests cannot be shown (the guest app could not read them),
   * by name, from the menus guests see now (dine-in and pickup); null when that cannot be read.
   */
  guestUnreadable?(): Promise<readonly string[] | null>;
}
/** A choice group as the choice groups page creates it (saved directly, no review). */
export interface NewChoiceGroupCommand {
  readonly action: "Create";
  readonly operationReference: string;
  readonly name: string;
  readonly nameZh: string;
  readonly kind: "One" | "Any" | "Quantity";
  readonly minimum: number;
  readonly maximum: number | null;
  readonly perOptionMaximum: number;
  readonly options: readonly {
    readonly optionReference: null;
    readonly name: string;
    readonly nameZh: string;
    readonly offered: true;
    readonly defaultChoice: boolean;
  }[];
}
const object = (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
export function parseMenuListView(value: unknown): MenuListView {
  const r = object(value);
  if (r === null || r.screenId !== "CAT-MENU-LIST" || !Array.isArray(r.menus))
    throw new Error("MENU_PAGE_INVALID");
  return r as unknown as MenuListView;
}
export function parseMenuBuilderView(value: unknown): MenuBuilderView {
  const r = object(value);
  const menu = object(r?.menu);
  if (
    r === null ||
    r.screenId !== "CAT-MENU-BUILDER" ||
    menu === null ||
    !Array.isArray(menu.sections) ||
    !Array.isArray(r.sellables)
  )
    throw new Error("MENU_PAGE_INVALID");
  return {
    ...r,
    soleOperator: parseSoleOperatorGate(r.soleOperator),
    customerView: parseMenuCustomerView(r.customerView),
  } as unknown as MenuBuilderView;
}
const photoPath = /^\/media\/images\/[0-9a-f]{64}\.(?:jpg|webp)$/u;
const dimension = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 20_000;
const text = (value: unknown) => (typeof value === "string" ? value : null);
function parseCustomerPhoto(value: unknown): MenuCustomerPhoto | null {
  const photo = object(value);
  if (
    photo === null ||
    typeof photo.url !== "string" ||
    !photoPath.test(photo.url) ||
    !dimension(photo.width) ||
    !dimension(photo.height) ||
    typeof photo.altText !== "string"
  )
    return null;
  return {
    url: photo.url,
    width: photo.width as number,
    height: photo.height as number,
    altText: photo.altText,
  };
}
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T | null =>
  values.includes(value as T) ? (value as T) : null;
/** Lenient on display, strict on what reaches the DOM: only public photo paths are rendered. */
export function parseMenuCustomerView(value: unknown): MenuCustomerView | null {
  const view = object(value);
  if (view === null || typeof view.frozenAt !== "string" || !Array.isArray(view.items)) return null;
  const items = view.items.flatMap((candidate: unknown): MenuCustomerViewItem[] => {
    const item = object(candidate);
    if (
      item === null ||
      typeof item.placementReference !== "string" ||
      typeof item.skuReference !== "string" ||
      typeof item.name !== "string"
    )
      return [];
    const before = object(item.before);
    return [
      {
        placementReference: item.placementReference,
        skuReference: item.skuReference,
        sectionName: text(item.sectionName) ?? "",
        name: item.name,
        description: text(item.description),
        photo: parseCustomerPhoto(item.photo),
        newOnMenu: typeof item.newOnMenu === "boolean" ? item.newOnMenu : null,
        descriptionChange: oneOf(item.descriptionChange, ["Added", "Changed", "Removed"] as const),
        photoChange: oneOf(item.photoChange, [
          "Added",
          "Replaced",
          "Removed",
          "DescriptionChanged",
        ] as const),
        before:
          before === null
            ? null
            : { description: text(before.description), photo: parseCustomerPhoto(before.photo) },
      },
    ];
  });
  return {
    frozenAt: view.frozenAt,
    comparedWithPublishedAt: text(view.comparedWithPublishedAt),
    items,
    removedFromMenu: (Array.isArray(view.removedFromMenu) ? view.removedFromMenu : []).flatMap(
      (candidate: unknown) => {
        const removed = object(candidate);
        return removed !== null &&
          typeof removed.skuReference === "string" &&
          typeof removed.name === "string"
          ? [{ skuReference: removed.skuReference, name: removed.name }]
          : [];
      },
    ),
  };
}
/** Plain words for what changed for customers, e.g. "1 new item, 2 photos changed". */
export function customerViewChangeSummary(view: MenuCustomerView): string | null {
  if (view.comparedWithPublishedAt === null) return null;
  const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
  const newItems = view.items.filter((item) => item.newOnMenu === true).length;
  const descriptions = view.items.filter((item) => item.descriptionChange !== null).length;
  const photos = view.items.filter((item) => item.photoChange !== null).length;
  const parts = [
    newItems ? count(newItems, t("new item"), t("new items")) : "",
    descriptions ? count(descriptions, t("description changed"), t("descriptions changed")) : "",
    photos ? count(photos, t("photo changed"), t("photos changed")) : "",
    view.removedFromMenu.length
      ? count(view.removedFromMenu.length, t("item removed"), t("items removed"))
      : "",
  ].filter(Boolean);
  return parts.length === 0
    ? t("No changes to items, descriptions or photos.")
    : parts.join(", ") + ".";
}
export const descriptionChangeText = {
  Added: t("New description"),
  Changed: t("Description changed"),
  Removed: t("Description removed"),
} as const;
export const photoChangeText = {
  Added: t("New photo"),
  Replaced: t("Photo replaced"),
  Removed: t("Photo removed"),
  DescriptionChanged: t("Photo description changed"),
} as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const parseMenuRouteReference = (value: string | undefined): string | null =>
  value !== undefined && uuid.test(value) ? value : null;
export const sectionCode = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/[^A-Za-z0-9_]/gu, "")
    .replace(/^[^A-Za-z]+|_+$/gu, "")
    .toUpperCase()
    .slice(0, 40);
/** WP-2423: plain names for a menu's sales channels and order types (never the internal codes). */
const channelNames: Readonly<Record<string, string>> = {
  CUSTOMER_PWA: t("Customer ordering app"),
  POS: t("Counter"),
};
const orderTypeNames: Readonly<Record<string, string>> = {
  DINE_IN: t("Dine-in"),
  PICKUP: t("Pickup"),
};
const plainCode = (code: string) =>
  code.charAt(0) + code.slice(1).toLowerCase().replaceAll("_", " ");
export const channelText = (codes: readonly string[]) =>
  codes.map((code) => channelNames[code] ?? plainCode(code)).join(", ");
export const orderTypeText = (codes: readonly string[]) =>
  codes.map((code) => orderTypeNames[code] ?? plainCode(code)).join(", ");
/** Items placed on the menu that customers at this Store cannot see because they are not offered
 * here, in menu order, without repeats. */
export function itemsNotOfferedHere(view: MenuBuilderView): readonly MenuSellable[] {
  const sellables = new Map(view.sellables.map((item) => [item.skuReference, item]));
  const seen = new Set<string>();
  const hidden: MenuSellable[] = [];
  for (const section of view.menu.sections)
    for (const item of section.items) {
      const sellable = sellables.get(item.skuReference);
      if (sellable === undefined || sellable.offeredHere !== false || seen.has(item.skuReference))
        continue;
      seen.add(item.skuReference);
      hidden.push(sellable);
    }
  return hidden;
}
/** Where the current version stands: editable, in review, approved or published. */
export function menuStage(publication: MenuPublicationStatus | null) {
  if (publication === null) return "Editing" as const;
  if (publication.state === "Published") return "Published" as const;
  if (publication.state === "Approved") return "Approved" as const;
  if (publication.state === "Archived") return "Archived" as const;
  return "InReview" as const;
}
/**
 * How staff change a menu version that can no longer be edited (DEC-MENU-REVISION): the server
 * copies the current version into a new draft. A published version gets a revision; a version in
 * review or approved but not yet published is withdrawn to change it (there is no other way back
 * to editing) and must be reviewed again. A version being edited is changed in place.
 */
export function menuRevisionAction(
  stage: ReturnType<typeof menuStage>,
  hasPublishedMenu: boolean,
): { readonly label: string; readonly note: string; readonly done: string } | null {
  const customers = hasPublishedMenu
    ? t(" Customers keep seeing the published menu meanwhile.")
    : "";
  if (stage === "Editing") return null;
  if (stage === "InReview" || stage === "Approved")
    return {
      label: t("Withdraw to make changes"),
      note:
        (stage === "InReview"
          ? t(
              "Takes this version out of review and opens a copy to edit; it must be submitted for review again.",
            )
          : t(
              "Sets this approved version aside unpublished and opens a copy to edit; it must be submitted and approved again.",
            )) + customers,
      done: t("Withdrawn. Edit the new draft and submit it for review again."),
    };
  return {
    label: t("Start a revision"),
    note: hasPublishedMenu
      ? t("Customers keep seeing the published menu until the revision is published.")
      : t("Opens a copy to edit; it must be submitted for review and published again."),
    done: t("A new version was started from this one; edit it and submit it for review."),
  };
}
/**
 * WP-2423 (v15 2026-10-16): an open draft of a menu that has been published can be discarded by
 * whoever may edit menus; the menu goes back to its last published version and customers see no
 * change. A version in review is withdrawn first; a never-published menu has nothing to go back to.
 */
export function mayDiscardDraft(view: MenuBuilderView): boolean {
  return (
    view.permissions.mayEdit &&
    menuStage(view.publication) === "Editing" &&
    view.latestRelease !== null &&
    view.latestRelease.menuVersionReference !== view.menu.versionReference
  );
}
export const priceText = (minor: string | null) =>
  minor === null
    ? null
    : (minor.length <= 2 ? "0" : minor.slice(0, -2)) + "." + minor.padStart(2, "0").slice(-2);
export const unavailableMenuClient: MenuClient = {
  load: async () => {
    throw new MenuPageError("Unavailable");
  },
};
const codes = new Set<MenuErrorCode>([
  "PermissionDenied",
  "NotFound",
  "Conflict",
  "Frozen",
  "NotRevisable",
  "NotDiscardable",
  "ReviewBlocked",
  "OptionPriceMissing",
  "TaxNotCovered",
  "OptionRecipeMissing",
  "KitchenNotReady",
  "ApprovalRequired",
  "Lifecycle",
  "Invalid",
  "SoleOperatorNotInEffect",
  "NeedsReverification",
  "NotSingleStore",
  "RegistryMissing",
  "NoKitchenStation",
  "RealRecipe",
  "DeclaredOtherwise",
  "OthersPending",
  "NoSection",
  "ManySizes",
  "NotADish",
  "DishUnavailable",
  "DishAllergensMissing",
  "DishHasRecipe",
  "ChoiceGroup",
  "ChoiceRecipesStopped",
  "PriceChanged",
  "NeedsBrandOwner",
  "NoBrandPriceYet",
  "PricesChangedSinceShown",
  "PricesMoved",
  "AllergensUndeclared",
  "CodeTaken",
]);
export function createMenuClient(csrf: string, fetcher: typeof fetch = fetch): MenuClient {
  const post = async (path: string, body: unknown) => {
    let response: Response;
    try {
      response = await fetcher(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify(body),
      });
    } catch {
      throw new MenuPageError("Offline");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: unknown;
        part?: unknown;
        productReference?: unknown;
      } | null;
      // A Store price that changed since it was shown (the Store price command's own word).
      const code = (
        payload?.error === "Changed" ? "PriceChanged" : String(payload?.error)
      ) as MenuErrorCode;
      const refusal = new MenuPageError(
        codes.has(code)
          ? code
          : response.status === 403
            ? "PermissionDenied"
            : // Another page's command refused a step of a one-page save (409 with its page).
              response.status === 409 && typeof payload?.part === "string"
              ? "StoppedPartWay"
              : "Unavailable",
        code === "ReviewBlocked" ||
          code === "ChoiceGroup" ||
          code === "OptionRecipeMissing" ||
          code === "TaxNotCovered" ||
          code === "KitchenNotReady"
          ? parseMenuReviewProblem((payload as { problem?: unknown } | null)?.problem)
          : null,
        typeof payload?.productReference === "string" ? payload.productReference : null,
      );
      // WP-2423 M134: the group the Brand already has by the name given.
      const existing = (payload as { optionSetReference?: unknown } | null)?.optionSetReference;
      if (typeof existing === "string")
        Object.defineProperty(refusal, "optionSetReference", { value: existing });
      throw refusal;
    }
    return response.json() as Promise<unknown>;
  };
  return {
    load: (menuReference) => post("/merchant/commerce/menus/query", { menuReference }),
    command: (command) => post("/merchant/commerce/menus/command", command),
    loadDish: async (productReference) => {
      const [product, optionPrices] = await Promise.all([
        post("/merchant/commerce/products/query", { productReference }),
        // Only this dish's prices and the usual extras: the whole list takes seconds to read.
        post("/merchant/commerce/option-prices/query", { productReference }),
      ]);
      return { product, optionPrices };
    },
    loadChoicePrices: () => post("/merchant/commerce/option-prices/query", {}),
    rebasePriceDraft: (priceBookReference, aggregateVersion) =>
      post("/merchant/commerce/pricing/command", {
        action: "Rebase",
        operationReference: newOperationReference(),
        priceBookReference,
        expectedAggregateVersion: aggregateVersion,
      }),
    oneStore: (command) => post("/merchant/commerce/one-store-dishes/command", command),
    combos: () => post("/merchant/commerce/one-store-combos/query", {}),
    kitchenNotPrepared: (command) =>
      post("/merchant/commerce/kitchen-not-prepared/command", command),
    productAlcohol: (command) => post("/merchant/commerce/product-alcohol/command", command),
    kitchenSections: (command) => post("/merchant/commerce/kitchen-sections/command", command),
    createChoiceGroup: (command) => post("/merchant/commerce/option-sets/command", command),
    guestUnreadable: async () => {
      // Each menu guests can see now; one not listed (or not readable here) is skipped.
      const menus = await Promise.all(
        ["/merchant/counter/menu?orderType=DineIn", "/merchant/counter/menu"].map(async (path) => {
          try {
            const response = await fetcher(path, {
              credentials: "same-origin",
              redirect: "error",
              cache: "no-store",
              headers: { Accept: "application/json" },
            });
            return response.ok
              ? [((await response.json()) as { menu?: unknown } | null)?.menu]
              : [];
          } catch {
            return [];
          }
        }),
      );
      const read = menus.flat();
      return read.length === 0 ? null : [...new Set(read.flatMap(guestUnreadableItems))];
    },
  };
}

/** WP-2423 Q31: the editable part of a menu draft, as kept on this device until it is saved. */
export interface MenuDraftContent {
  readonly name: string;
  readonly sections: readonly {
    readonly sectionReference: string | null;
    readonly code: string | null;
    readonly name: string;
    readonly nameZh: string;
    readonly items: readonly { readonly skuReference: string; readonly featured: boolean }[];
  }[];
}
export interface StoredMenuDraft extends MenuDraftContent {
  /** The menu version the changes were made on; they are offered back only on that version. */
  readonly aggregateVersion: number;
  readonly keptAt: string;
}

const menuDraftKey = (menuReference: string) => `bop.menu-draft.${menuReference}`;

/** The same text for the same menu content, so a draft can be compared with what is saved. */
export function menuDraftFingerprint(content: MenuDraftContent): string {
  return JSON.stringify({
    name: content.name,
    sections: content.sections.map((section) => ({
      sectionReference: section.sectionReference,
      code: section.code,
      name: section.name,
      nameZh: section.nameZh,
      items: section.items.map((item) => [item.skuReference, item.featured]),
    })),
  });
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function parseStoredMenuDraft(value: unknown): StoredMenuDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const draft = value as Record<string, unknown>;
  if (
    !isString(draft.name) ||
    !isString(draft.keptAt) ||
    !Number.isSafeInteger(draft.aggregateVersion) ||
    !Array.isArray(draft.sections)
  )
    return null;
  const sections: StoredMenuDraft["sections"][number][] = [];
  for (const entry of draft.sections as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const section = entry as Record<string, unknown>;
    if (
      !(section.sectionReference === null || isString(section.sectionReference)) ||
      !(section.code === null || isString(section.code)) ||
      !isString(section.name) ||
      !isString(section.nameZh) ||
      !Array.isArray(section.items)
    )
      return null;
    const items: { skuReference: string; featured: boolean }[] = [];
    for (const raw of section.items as unknown[]) {
      if (typeof raw !== "object" || raw === null) return null;
      const item = raw as Record<string, unknown>;
      if (!isString(item.skuReference) || typeof item.featured !== "boolean") return null;
      items.push({ skuReference: item.skuReference, featured: item.featured });
    }
    sections.push({
      sectionReference: section.sectionReference,
      code: section.code,
      name: section.name,
      nameZh: section.nameZh,
      items,
    });
  }
  return {
    name: draft.name,
    keptAt: draft.keptAt,
    aggregateVersion: draft.aggregateVersion as number,
    sections,
  };
}

/** Unsaved menu changes kept on this device (menu names and items only, never customer data). */
export const menuDraftStore = {
  read(menuReference: string): StoredMenuDraft | null {
    try {
      const raw = globalThis.localStorage?.getItem(menuDraftKey(menuReference));
      return raw ? parseStoredMenuDraft(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  },
  write(menuReference: string, draft: StoredMenuDraft): void {
    try {
      globalThis.localStorage?.setItem(menuDraftKey(menuReference), JSON.stringify(draft));
    } catch {
      // Storage full or blocked: the leave warning still protects the changes on this page.
    }
  },
  clear(menuReference: string): void {
    try {
      globalThis.localStorage?.removeItem(menuDraftKey(menuReference));
    } catch {
      // Nothing kept.
    }
  },
};
