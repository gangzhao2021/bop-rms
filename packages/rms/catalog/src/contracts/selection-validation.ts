import type { CatalogInstant, CatalogReference } from "../domain/product.js";

export type CatalogOrderingSourceChannel = "Api" | "Pos" | "Qr" | "Web";
export type CatalogOrderingOrderType = "DineIn" | "Pickup";

export interface CatalogSelectionQuantity {
  readonly optionReference: CatalogReference;
  readonly quantity: number;
}

export interface ValidateCatalogSelectionInput {
  readonly brandReference: CatalogReference;
  readonly storeReference: CatalogReference;
  readonly sourceChannel: CatalogOrderingSourceChannel;
  readonly orderType: CatalogOrderingOrderType;
  readonly sellableReference: CatalogReference;
  readonly optionSelections: readonly CatalogSelectionQuantity[];
  readonly observedAt: CatalogInstant;
}

export interface CatalogSelectionRuleEvidence {
  readonly bindingReference: CatalogReference;
  readonly optionSetVersionReference: CatalogReference;
}

export interface CatalogSelectionAccepted {
  readonly status: "Accepted";
  readonly brandReference: CatalogReference;
  readonly storeReference: CatalogReference;
  readonly sourceChannel: CatalogOrderingSourceChannel;
  readonly orderType: CatalogOrderingOrderType;
  readonly sellableReference: CatalogReference;
  readonly optionSelections: readonly CatalogSelectionQuantity[];
  readonly menuVersionReference: CatalogReference;
  readonly productVersionReference: CatalogReference;
  readonly catalogChannelCode: string;
  readonly catalogOrderTypeCode: string;
  readonly ruleEvidence: readonly CatalogSelectionRuleEvidence[];
  readonly validatedAt: CatalogInstant;
}

export type CatalogSelectionValidationResult =
  | CatalogSelectionAccepted
  | {
      readonly status: "Rejected";
      readonly reason:
        | "SELLABLE_UNAVAILABLE"
        | "OPTION_NOT_ENABLED"
        | "OPTION_QUANTITY_INVALID"
        | "RULE_UNSATISFIED"
        | "OPTION_CONFLICT";
    };

/**
 * WP-2423 (DEC-PRICE-HOLD §3, price-hold-dish-changes): one cart line priced on one menu version
 * and found on another. The dish keeps its product version while the restaurant renames it or
 * changes its allergens (a draft edited in place), so the published menus are compared.
 */
export interface CatalogDishChangeKey {
  readonly sellableReference: string;
  readonly productVersionReference: string;
  /** The menu version the guest's price was confirmed on. */
  readonly fromMenuVersionReference: string;
  /** The menu version the dish is sold on now. */
  readonly toMenuVersionReference: string;
}
/**
 * What the guest is told differently about the dish on the newer menu: its name (any language) or
 * its allergens (any line of the disclosure). A dish either menu does not show exactly once is
 * answered as both, so it is never held unchecked.
 */
export type CatalogDishChange = "Name" | "Allergens";
