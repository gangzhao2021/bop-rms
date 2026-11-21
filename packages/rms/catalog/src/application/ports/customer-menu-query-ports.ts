import type { SellableAllergenChange } from "../../domain/sellable-allergen-change.js";
import type {
  CustomerMenuQueryInput,
  CustomerMenuQueryResult,
} from "../../contracts/customer-menu-query.js";
import type { PublishedMenuProjection } from "../../contracts/published-menu-projection.js";
import type {
  PublishedDefaultOptionSelection,
  PublishedOptionRule,
} from "../../domain/published-menu-projection.js";
import type { CatalogReference } from "../../contracts/product.js";

export interface CustomerMenuStoreContext {
  readonly brandReference: CatalogReference;
  readonly storeReference: CatalogReference;
  readonly status: "Active" | "Inactive";
}

/** WP-2423 8.6: one item's state at the Store — offered, sold out, and its current base price. */
export interface CustomerMenuStoreFact {
  readonly availability: "Available" | "SoldOut" | "NotOffered";
  /** WP-2423 DEC-ALCOHOL: the dish contains alcohol, and whether it can be ordered right now. */
  readonly alcohol?: "OnSale" | "LastCall" | "OutsideHours";
  readonly price: { readonly amount: string; readonly currency: string } | null;
  /** WP-2423 slice 4.5: each published option's current price for one, by "binding:option". */
  readonly optionPrices?: ReadonlyMap<
    string,
    { readonly amount: string; readonly currency: string }
  >;
  /**
   * WP-2423 item 8 ⑥ part 4: the item's choices that stand for a dish of a combo. A part whose
   * choices all do starts unchosen for guests (Owner 2026-10-28 combo decision 1).
   */
  readonly comboChoices?: ReadonlySet<string>;
  /**
   * WP-2423 (cart-unsellable-dishes): the item's published choices the Store does not offer right
   * now (absent or empty: all offered). The menu still shows them, greyed, never pre-chosen.
   */
  readonly notOfferedOptions?: ReadonlySet<string>;
  /**
   * WP-2423 (M22, M24): the item's choices sold out at the Store now — its own mark on the choice,
   * or a combo dish marked sold out. Shown "Sold out today", never pre-chosen; the cart, quote and
   * checkout refuse them from the same answer (`listOptionsOffNow`).
   */
  readonly soldOutOptions?: ReadonlySet<string>;
  /**
   * WP-2423 (M77, M167): the dish's allergens as resolved after a recipe change recorded since
   * this menu version was checked for listing. Guests read them with the listed ones.
   */
  readonly allergenChange?: SellableAllergenChange;
}

export interface CustomerMenuQueryPorts {
  readonly stores: {
    resolvePublic(publicStoreReference: CatalogReference): Promise<CustomerMenuStoreContext | null>;
  };
  readonly projections: {
    loadCandidates(input: {
      readonly brandReference: CatalogReference;
      readonly storeReference: CatalogReference;
      readonly channelCode: CustomerMenuQueryInput["channelCode"];
      readonly orderTypeCode: CustomerMenuQueryInput["orderTypeCode"];
      readonly requestedAt: CustomerMenuQueryInput["requestedAt"];
    }): Promise<readonly PublishedMenuProjection[]>;
  };
  /** Store availability and prices; without it every published item shows as available, unpriced. */
  readonly storeFacts?: {
    load(input: {
      readonly brandReference: CatalogReference;
      readonly storeReference: CatalogReference;
      readonly channelCode: CustomerMenuQueryInput["channelCode"];
      readonly orderTypeCode: CustomerMenuQueryInput["orderTypeCode"];
      readonly requestedAt: CustomerMenuQueryInput["requestedAt"];
      readonly sellableReferences: readonly CatalogReference[];
      /** WP-2423 (M77): the listed menu version shown (absent: no allergen change is read). */
      readonly menuVersionReference?: CatalogReference;
      /** The published options of those items to price (each item's own bindings). */
      readonly options?: readonly {
        readonly sellableReference: CatalogReference;
        readonly bindingReference: CatalogReference;
        readonly optionReference: CatalogReference;
      }[];
      /**
       * WP-2423 Q12: each item as normally ordered on this channel — its published product version
       * and default option choices — so the Store's stock can be observed for it.
       */
      readonly items?: readonly {
        readonly sellableReference: CatalogReference;
        readonly productVersionReference: CatalogReference;
        readonly defaultOptionSelections: readonly PublishedDefaultOptionSelection[];
        /** WP-2423 (M22, M24): its published rules, to choose again around choices off now. */
        readonly optionRules?: readonly PublishedOptionRule[];
      }[];
    }): Promise<ReadonlyMap<string, CustomerMenuStoreFact>>;
  };
}

export interface CustomerMenuQuery {
  getPublishedMenu(input: unknown): Promise<CustomerMenuQueryResult>;
}

export type CustomerMenuQueryRequest = CustomerMenuQueryInput;
