import type {
  CatalogOrderingOrderType,
  CatalogOrderingSourceChannel,
} from "../../contracts/selection-validation.js";
import type { CatalogInstant, CatalogReference } from "../../domain/product.js";

export interface CatalogResolvedOption {
  readonly optionReference: CatalogReference;
  readonly maximumQuantity: number;
  readonly conflictOptionReferences: readonly CatalogReference[];
}

export interface CatalogResolvedSelectionRule {
  readonly bindingReference: CatalogReference;
  readonly optionSetVersionReference: CatalogReference;
  readonly activationOptionReferences: readonly CatalogReference[];
  readonly minimumQuantity: number;
  readonly maximumQuantity: number;
  readonly options: readonly CatalogResolvedOption[];
}

export interface CurrentCatalogSelectionSnapshot {
  readonly brandReference: CatalogReference;
  readonly storeReference: CatalogReference;
  readonly sourceChannel: CatalogOrderingSourceChannel;
  readonly orderType: CatalogOrderingOrderType;
  readonly sellableReference: CatalogReference;
  readonly availability: "Available";
  readonly freshnessStatus: "Fresh";
  readonly menuVersionReference: CatalogReference;
  readonly productVersionReference: CatalogReference;
  readonly catalogChannelCode: string;
  readonly catalogOrderTypeCode: string;
  readonly effectiveFrom: CatalogInstant;
  readonly effectiveUntil: CatalogInstant | null;
  readonly resolvedAt: CatalogInstant;
  readonly rules: readonly CatalogResolvedSelectionRule[];
}

export interface CatalogSelectionValidationPorts {
  readonly snapshots: {
    resolveCurrent(input: {
      readonly brandReference: CatalogReference;
      readonly storeReference: CatalogReference;
      readonly sourceChannel: CatalogOrderingSourceChannel;
      readonly orderType: CatalogOrderingOrderType;
      readonly sellableReference: CatalogReference;
      readonly observedAt: CatalogInstant;
    }): Promise<CurrentCatalogSelectionSnapshot | null>;
  };
}
