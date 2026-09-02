import type {
  CustomerProfileCommand,
  CustomerProfileCommandRecord,
  CustomerProfileProjection,
  CustomerProfileQuery,
} from "../../contracts/customer-profile.js";
import type { CustomerProfile, CustomerReference } from "../../domain/customer-profile.js";
export interface CustomerProfilePorts {
  readonly authorization: {
    authorize(input: CustomerProfileCommand | CustomerProfileQuery): Promise<{
      readonly authorized: true;
      readonly mayViewContacts?: boolean;
      readonly mayViewTransactions?: boolean;
      readonly mayViewLoyalty?: boolean;
      readonly mayViewConsent?: boolean;
      readonly mayViewCommunications?: boolean;
      readonly mayViewPrivacyCases?: boolean;
      readonly mayViewServiceNotes?: boolean;
      readonly mayViewAudit?: boolean;
      readonly mayManage?: boolean;
    } | null>;
  };
  readonly projection: { query(input: CustomerProfileQuery): Promise<CustomerProfileProjection> };
  readonly creationBasis: {
    validate(command: CustomerProfileCommand): Promise<unknown>;
  };
  readonly identity: {
    validateVerifiedContact(command: CustomerProfileCommand): Promise<unknown>;
    validateVerifiedUser(command: CustomerProfileCommand): Promise<unknown>;
  };
  readonly transactionSource: {
    validateGuestLink(command: CustomerProfileCommand): Promise<unknown>;
  };
  readonly repository: {
    resolveOperation(reference: CustomerReference): Promise<CustomerProfileCommandRecord | null>;
    load(input: {
      tenantReference: CustomerReference;
      brandReference: CustomerReference;
      customerReference: CustomerReference;
    }): Promise<CustomerProfile | null>;
    commit(record: CustomerProfileCommandRecord): Promise<CustomerProfileCommandRecord>;
  };
  readonly audit: {
    create(input: {
      command: CustomerProfileCommand;
      before: CustomerProfile | null;
      after: CustomerProfile;
    }): Promise<CustomerProfileCommandRecord["audit"]>;
  };
  readonly references: {
    generate(purpose: "CustomerProfile" | "GuestTransactionLink"): string;
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
