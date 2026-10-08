import type {
  CustomerMenuQueryInput,
  CustomerMenuQueryResult,
} from "../../contracts/customer-menu-query.js";
import type { PublishedMenuProjection } from "../../contracts/published-menu-projection.js";
import type { CatalogReference } from "../../contracts/product.js";

export interface CustomerMenuStoreContext {
  readonly brandReference: CatalogReference;
  readonly storeReference: CatalogReference;
  readonly status: "Active" | "Inactive";
}

/** WP-2423 8.6: one item's state at the Store — offered, sold out, and its current base price. */
export interface CustomerMenuStoreFact {
  readonly availability: "Available" | "SoldOut" | "NotOffered";
  readonly price: { readonly amount: string; readonly currency: string } | null;
  /** WP-2423 slice 4.5: each published option's current price for one, by "binding:option". */
  readonly optionPrices?: ReadonlyMap<
    string,
    { readonly amount: string; readonly currency: string }
  >;
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
      /** The published options of those items to price (each item's own bindings). */
      readonly options?: readonly {
        readonly sellableReference: CatalogReference;
        readonly bindingReference: CatalogReference;
        readonly optionReference: CatalogReference;
      }[];
    }): Promise<ReadonlyMap<string, CustomerMenuStoreFact>>;
  };
}

export interface CustomerMenuQuery {
  getPublishedMenu(input: unknown): Promise<CustomerMenuQueryResult>;
}

export type CustomerMenuQueryRequest = CustomerMenuQueryInput;
