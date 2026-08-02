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
