import type { CatalogCode, CatalogInstant, CatalogReference } from "../../domain/product.js";

export interface CurrentAvailabilityQueryInput {
  readonly brandReference: CatalogReference;
  readonly storeReference: CatalogReference;
  readonly sellableReference: CatalogReference;
  readonly channelCode: CatalogCode;
  readonly orderTypeCode: CatalogCode;
  readonly observedAt: CatalogInstant;
}

/** Internal owner ports. Caller authorizes scope; returned data is captured and validated. */
export interface CurrentAvailabilityQueryPorts {
  readonly rules: {
    loadCurrentRules(input: CurrentAvailabilityQueryInput): Promise<unknown>;
  };
  readonly killSwitch: {
    loadEvidence(input: CurrentAvailabilityQueryInput): Promise<unknown>;
  };
  readonly inventory: {
    loadEvidence(input: CurrentAvailabilityQueryInput): Promise<unknown>;
  };
  readonly clock: { now(): string };
}
