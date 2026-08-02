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

export interface CustomerMenuQueryPorts {
  readonly stores: {
    resolvePublic(publicStoreReference: CatalogReference): Promise<CustomerMenuStoreContext | null>;
  };
  readonly projections: {
    loadCandidates(input: {
      readonly brandReference: CatalogReference;
      readonly storeReference: CatalogReference;
    }): Promise<readonly PublishedMenuProjection[]>;
  };
}

export interface CustomerMenuQuery {
  getPublishedMenu(input: unknown): Promise<CustomerMenuQueryResult>;
}

export type CustomerMenuQueryRequest = CustomerMenuQueryInput;
