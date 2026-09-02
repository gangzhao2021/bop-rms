import type { BrandReference, CanonicalInstant, StoreReference } from "@bop/tenant";
import type {
  StoreAdministrationReference,
  StoreConfigurationVersion,
} from "../../contracts/store-configuration-administration.js";

export type StoreConfigurationAdministrationCommand =
  "SaveDraft" | "Validate" | "Submit" | "Approve" | "Publish";

export interface StoreConfigurationOperation {
  readonly command: StoreConfigurationAdministrationCommand;
  readonly operationReference: StoreAdministrationReference;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference;
  readonly intentDigest: string;
  readonly resultingVersion: number;
  readonly configuration: StoreConfigurationVersion;
}

export interface StoreConfigurationAdministrationPorts {
  readonly authorization: {
    authorize(input: {
      readonly command: StoreConfigurationAdministrationCommand;
      readonly actorReference: StoreAdministrationReference;
      readonly brandReference: BrandReference;
      readonly storeReference: StoreReference;
      readonly purposeCode: string;
      readonly observedAt: CanonicalInstant;
    }): Promise<boolean>;
  };
  readonly repository: {
    resolveOperation(
      operationReference: StoreAdministrationReference,
    ): Promise<StoreConfigurationOperation | null>;
    loadLatest(
      brandReference: BrandReference,
      storeReference: StoreReference,
    ): Promise<StoreConfigurationVersion | null>;
    commit(input: {
      readonly operation: StoreConfigurationOperation;
      readonly expectedVersion: number;
      readonly audit: {
        readonly actorReference: StoreAdministrationReference;
        readonly auditReference: StoreAdministrationReference;
        readonly purposeCode: string;
        readonly occurredAt: CanonicalInstant;
      };
    }): Promise<StoreConfigurationOperation>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
    validateControlledReferences(configuration: StoreConfigurationVersion): Promise<boolean>;
    validateBrandBaseCompatibility(configuration: StoreConfigurationVersion): Promise<boolean>;
  };
  readonly approval: {
    validate(configuration: StoreConfigurationVersion): Promise<boolean>;
  };
  readonly publishing: {
    validate(configuration: StoreConfigurationVersion): Promise<boolean>;
  };
  readonly liveGate: {
    validate(configuration: StoreConfigurationVersion): Promise<boolean>;
  };
}
