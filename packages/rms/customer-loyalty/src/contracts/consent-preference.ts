import type { AppendAuditRecordInput } from "@bop/audit";
import type { CustomerInstant, CustomerReference } from "../domain/customer-profile.js";
import type {
  ConsentPreferenceRecord,
  ConsentPurpose,
  ConsentStatus,
  ContactChannel,
} from "../domain/consent-preference.js";

interface ConsentCommandBase {
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly customerReference: CustomerReference;
  readonly actorReference: CustomerReference;
  readonly purpose: "ConsentAdministration";
  readonly permission: "customer.consent.manage";
  readonly operationReference: CustomerReference;
  readonly expectedVersion: number;
  readonly occurredAt: CustomerInstant;
}
export type ConsentPreferenceCommand =
  | (ConsentCommandBase & {
      readonly type: "RecordChoice";
      readonly input: {
        readonly consentReference: CustomerReference;
        readonly consentPurpose: ConsentPurpose;
        readonly channel: ContactChannel;
        readonly status: ConsentStatus;
        readonly contactMethodReference: CustomerReference;
        readonly policyVersion: string;
        readonly jurisdictionCode: string;
        readonly sourceCode: string;
        readonly effectiveAt: CustomerInstant;
        readonly evidenceReference: CustomerReference;
      };
    })
  | (ConsentCommandBase & {
      readonly type: "UpdatePreference";
      readonly input: {
        readonly preferredLanguage: string;
        readonly preferredChannel: ContactChannel | null;
        readonly quietHours: null | { readonly startMinute: number; readonly endMinute: number };
        readonly frequencyCode: "TransactionalOnly" | "Standard" | "Reduced";
        readonly storeReference: CustomerReference | null;
        readonly evidenceReference: CustomerReference;
      };
    });
export interface ConsentPreferenceCommandRecord {
  readonly operationReference: CustomerReference;
  readonly intentHash: string;
  readonly command: ConsentPreferenceCommand;
  readonly before: ConsentPreferenceRecord;
  readonly after: ConsentPreferenceRecord;
  readonly event: null | {
    readonly eventName: "CustomerConsentChanged";
    readonly customerReference: CustomerReference;
    readonly consentReference: CustomerReference;
    readonly purpose: ConsentPurpose;
    readonly channel: ContactChannel;
    readonly status: ConsentStatus;
    readonly occurredAt: CustomerInstant;
  };
  readonly audit: AppendAuditRecordInput;
  readonly outcome: "Applied" | "AlreadyApplied";
}
export interface ConsentPreferenceQuery {
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly customerReference: CustomerReference;
  readonly actorReference: CustomerReference;
  readonly purpose: "ConsentAdministration";
  readonly permission: "customer.consent.read";
  readonly consentPurpose: ConsentPurpose | "All";
  readonly channel: ContactChannel | "All";
  readonly status: ConsentStatus | "All";
}
export interface ConsentPreferenceProjection {
  readonly projectionName: "customer_consent_preference_v1";
  readonly projectionVersion: 1;
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly customerReference: CustomerReference;
  readonly asOfUtc: CustomerInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly mayManage: boolean;
    readonly mayExportProof: boolean;
    readonly mayViewEvidence: boolean;
  };
  readonly aggregateVersion: number;
  readonly choices: readonly (Omit<
    ConsentPreferenceRecord["choices"][number],
    "evidenceReference"
  > & {
    readonly evidenceReference: CustomerReference | null;
  })[];
  readonly preference: ConsentPreferenceRecord["preference"];
}
