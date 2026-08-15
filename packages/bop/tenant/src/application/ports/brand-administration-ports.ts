import type {
  Brand,
  BrandReference,
  CanonicalInstant,
  OrganizationVersion,
  Store,
} from "../../domain/brand-store.js";
import type {
  BrandAdministrationReference,
  BrandConfigurationVersion,
  BrandStoreMembershipRecord,
} from "../../contracts/brand-administration.js";
export type BrandAdministrationCommand =
  | "CreateBrand"
  | "ActivateBrand"
  | "ArchiveBrand"
  | "SaveConfigurationDraft"
  | "SubmitConfiguration"
  | "ApproveConfiguration"
  | "PublishConfiguration"
  | "AddStoreMembership"
  | "RemoveStoreMembership";
export type BrandAdministrationArtifact =
  Brand | BrandConfigurationVersion | BrandStoreMembershipRecord;
export interface BrandAdministrationOperation {
  readonly command: BrandAdministrationCommand;
  readonly operationReference: BrandAdministrationReference;
  readonly brandReference: BrandReference;
  readonly intentDigest: string;
  readonly brandVersion: OrganizationVersion;
  readonly artifact: BrandAdministrationArtifact;
}
export interface BrandAdministrationPorts {
  readonly authorization: {
    authorize(input: {
      readonly command: BrandAdministrationCommand;
      readonly actorReference: BrandAdministrationReference;
      readonly brandReference: BrandReference;
      readonly purposeCode: string;
      readonly observedAt: CanonicalInstant;
    }): Promise<boolean>;
  };
  readonly approval: {
    validate(input: {
      readonly brandReference: BrandReference;
      readonly approvalEvidenceReference: BrandAdministrationReference;
      readonly configurationVersionReference: BrandAdministrationReference | null;
      readonly observedAt: CanonicalInstant;
    }): Promise<boolean>;
  };
  readonly publishing: {
    validate(input: {
      readonly configuration: BrandConfigurationVersion;
      readonly observedAt: CanonicalInstant;
    }): Promise<boolean>;
  };
  readonly references: {
    validateMedia(reference: BrandAdministrationReference | null): Promise<boolean>;
    validateCatalog(reference: BrandAdministrationReference): Promise<boolean>;
    hashIntent(value: string): string;
    equals(a: string, b: string): boolean;
  };
  readonly repository: {
    loadBrand(reference: BrandReference): Promise<Brand | null>;
    loadStore(reference: string): Promise<Store | null>;
    loadLatestConfiguration(reference: BrandReference): Promise<BrandConfigurationVersion | null>;
    loadLatestMembership(
      brandReference: BrandReference,
      storeReference: string,
    ): Promise<BrandStoreMembershipRecord | null>;
    resolveOperation(
      reference: BrandAdministrationReference,
    ): Promise<BrandAdministrationOperation | null>;
    commit(input: {
      readonly operation: BrandAdministrationOperation;
      readonly expectedBrandVersion: number;
      readonly audit: {
        readonly actorReference: BrandAdministrationReference;
        readonly purposeCode: string;
        readonly auditReference: BrandAdministrationReference;
        readonly occurredAt: CanonicalInstant;
      };
    }): Promise<BrandAdministrationOperation>;
  };
}
