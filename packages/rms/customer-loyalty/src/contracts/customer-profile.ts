import type { AppendAuditRecordInput } from "@bop/audit";
import type {
  CustomerCreationBasis,
  CustomerInstant,
  CustomerProfile,
  CustomerReference,
  CustomerRelationshipStatus,
} from "../domain/customer-profile.js";
export type CustomerProfileAction =
  | "Create"
  | "UpdateProfile"
  | "AttachVerifiedContact"
  | "LinkUser"
  | "LinkGuestTransaction"
  | "AddServiceNote";
export interface CustomerProfileCommand {
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly actorReference: CustomerReference;
  readonly purpose: "CustomerProfileManagement";
  readonly permission: "customer.manage";
  readonly operationReference: CustomerReference;
  readonly occurredAt: CustomerInstant;
  readonly action: CustomerProfileAction;
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface CustomerProfileCommandRecord {
  readonly operationReference: CustomerReference;
  readonly intentHash: string;
  readonly command: CustomerProfileCommand;
  readonly profile: CustomerProfile;
  readonly audit: AppendAuditRecordInput;
  readonly outcome: "Applied" | "AlreadyApplied";
}
export interface CustomerProfileQuery {
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly actorReference: CustomerReference;
  readonly purpose: "CustomerProfileRead";
  readonly permission: "customer.manage";
  readonly selectedCustomerReference: CustomerReference | null;
  readonly approvedContactSearchReference: CustomerReference | null;
  readonly nameToken: string | null;
  readonly relationshipStatus: CustomerRelationshipStatus | "All";
  readonly loyaltyProgramReference: CustomerReference | null;
  readonly tierCode: string | null;
  readonly consentStatus: "All" | "Granted" | "Withdrawn" | "Missing";
  readonly lastInteractionFromUtc: CustomerInstant | null;
  readonly hasOpenCase: boolean | null;
  readonly cursor: string | null;
}
export interface CustomerProfileProjection {
  readonly projectionName: "customer_profile_v1";
  readonly projectionVersion: 1;
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly asOfUtc: CustomerInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly nextCursor: string | null;
  readonly permissions: {
    readonly mayViewContacts: boolean;
    readonly mayViewTransactions: boolean;
    readonly mayViewLoyalty: boolean;
    readonly mayViewConsent: boolean;
    readonly mayViewCommunications: boolean;
    readonly mayViewPrivacyCases: boolean;
    readonly mayViewServiceNotes: boolean;
    readonly mayViewAudit: boolean;
    readonly mayManage: boolean;
  };
  readonly rows: readonly {
    readonly customerReference: CustomerReference;
    readonly displayName: string;
    readonly maskedContact: string | null;
    readonly relationshipStatus: CustomerRelationshipStatus;
    readonly loyaltyStatus: string | null;
    readonly tierCode: string | null;
    readonly lastInteractionAt: CustomerInstant | null;
    readonly consentSummary: string | null;
    readonly openCase: boolean | null;
  }[];
  readonly detail: {
    readonly customerReference: CustomerReference;
    readonly aggregateVersion: number;
    readonly displayName: string;
    readonly preferredLocale: string | null;
    readonly relationshipStatus: CustomerRelationshipStatus;
    readonly creationBasis: CustomerCreationBasis;
    readonly userLinked: boolean;
    readonly verifiedContacts:
      | readonly {
          readonly contactReference: CustomerReference;
          readonly contactType: "Email" | "Phone";
          readonly maskedValue: string;
          readonly verifiedAt: CustomerInstant;
        }[]
      | null;
    readonly transactionReferences:
      | readonly {
          readonly transactionType: "Order" | "Reservation";
          readonly transactionReference: CustomerReference;
          readonly linkedAt: CustomerInstant;
        }[]
      | null;
    readonly loyaltyAccounts: readonly CustomerReference[] | null;
    readonly consentSummary: string | null;
    readonly communicationCount: number | null;
    readonly privacyCaseReferences: readonly CustomerReference[] | null;
    readonly serviceNotes:
      | readonly {
          readonly noteReference: CustomerReference;
          readonly categoryCode: string;
          readonly note: string;
          readonly occurredAt: CustomerInstant;
        }[]
      | null;
    readonly auditReference: CustomerReference | null;
  } | null;
}
