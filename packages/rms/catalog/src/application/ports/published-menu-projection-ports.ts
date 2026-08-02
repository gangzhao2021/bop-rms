import type { ConsumerTransaction } from "@bop/eventing";

import type {
  MenuPublishedEnvelope,
  PublishedMenuProjection,
  PublishedMenuSnapshot,
} from "../../contracts/published-menu-projection.js";
import type { CatalogInstant, CatalogReference } from "../../contracts/product.js";

export interface PublishedMenuProjectionPorts {
  readonly snapshots: {
    loadExact(input: {
      readonly brandReference: CatalogReference;
      readonly menuReference: CatalogReference;
      readonly menuVersionReference: CatalogReference;
      readonly releaseReference: CatalogReference;
      readonly snapshotDigest: string;
    }): Promise<PublishedMenuSnapshot | null>;
  };
  readonly projections: {
    load(menuReference: CatalogReference): Promise<PublishedMenuProjection | null>;
    replace(input: {
      readonly projection: PublishedMenuProjection;
      readonly envelope: MenuPublishedEnvelope;
      readonly transaction: ConsumerTransaction;
    }): Promise<PublishedMenuProjection>;
  };
  readonly references: {
    generateGeneration(): string;
    now(): CatalogInstant;
  };
}
