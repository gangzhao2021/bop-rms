import type { CatalogCode, CatalogInstant, CatalogReference } from "../domain/product.js";

export const customerMenuFreshnessTargetMilliseconds = 5_000 as const;

export interface CustomerMenuQueryInput {
  readonly publicStoreReference: CatalogReference;
  readonly channelCode: CatalogCode;
  readonly orderTypeCode: CatalogCode;
  readonly locale: string;
  readonly requestedAt: CatalogInstant;
  readonly searchTerm: string | null;
  readonly sectionReference: CatalogReference | null;
}

export interface CustomerMenuOptionRuleDto {
  readonly bindingReference: CatalogReference;
  readonly optionSetVersionReference: CatalogReference;
  readonly minimumSelections: number;
  readonly maximumSelections: number;
  readonly enabledOptionReferences: readonly CatalogReference[];
  readonly defaultOptionReferences: readonly CatalogReference[];
}

export interface CustomerMenuSellableDto {
  readonly sellableReference: CatalogReference;
  readonly productVersionReference: CatalogReference;
  readonly name: string;
  readonly presentationRole: "Standard" | "Featured" | "Promotional" | "Sponsored";
  readonly pinned: boolean;
  readonly availability: "Available";
  readonly optionRules: readonly CustomerMenuOptionRuleDto[];
  readonly displayPrice: {
    readonly status: "Unavailable";
    readonly amount: null;
    readonly currency: null;
    readonly reason: "PRICING_NOT_INTEGRATED";
  };
  readonly taxDisplayContext: {
    readonly status: "Unavailable";
    readonly taxInclusive: null;
    readonly reason: "FINAL_QUOTE_REQUIRED";
  };
}

export interface CustomerMenuSectionDto {
  readonly sectionReference: CatalogReference;
  readonly name: string;
  readonly sellables: readonly CustomerMenuSellableDto[];
}

export interface CustomerMenuFound {
  readonly status: "Found";
  readonly schemaVersion: 1;
  readonly projection: {
    readonly name: "catalog_published_menu_v1";
    readonly version: 1;
    readonly asOfUtc: CatalogInstant;
    readonly sourceCheckpoint: CatalogReference;
    readonly sourceAggregateVersion: number;
    readonly freshnessStatus: "Fresh";
    readonly freshnessTargetMilliseconds: 5_000;
    readonly stale: false;
    readonly partial: true;
  };
  readonly scope: {
    readonly publicStoreReference: CatalogReference;
    readonly channelCode: CatalogCode;
    readonly orderTypeCode: CatalogCode;
    readonly effectiveAt: CatalogInstant;
  };
  readonly menu: {
    readonly menuReference: CatalogReference;
    readonly menuVersionReference: CatalogReference;
    readonly releaseReference: CatalogReference;
    readonly locale: string;
    readonly name: string;
    readonly effectiveFrom: CatalogInstant;
    readonly effectiveUntil: CatalogInstant | null;
    readonly sections: readonly CustomerMenuSectionDto[];
  };
}

export type CustomerMenuQueryResult =
  | CustomerMenuFound
  | { readonly status: "NotFound" }
  | { readonly status: "ProjectionStale" }
  | { readonly status: "Unavailable" };
