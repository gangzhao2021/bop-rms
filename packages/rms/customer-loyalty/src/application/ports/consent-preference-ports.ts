import type {
  ConsentPreferenceCommand,
  ConsentPreferenceCommandRecord,
  ConsentPreferenceProjection,
  ConsentPreferenceQuery,
} from "../../contracts/consent-preference.js";
import type { ConsentPreferenceRecord } from "../../domain/consent-preference.js";
import type { CustomerReference } from "../../domain/customer-profile.js";
export interface ConsentPreferencePorts {
  readonly authorization: {
    authorize(input: ConsentPreferenceCommand | ConsentPreferenceQuery): Promise<{
      authorized: boolean;
      mayManage: boolean;
      mayExportProof: boolean;
      mayViewEvidence: boolean;
    } | null>;
  };
  readonly evidence: {
    verify(command: ConsentPreferenceCommand): Promise<{
      verified: boolean;
      identityContactValueDisclosed: false;
      customerReference: CustomerReference;
      evidenceReference: CustomerReference;
      policyApproved: boolean;
    }>;
  };
  readonly repository: {
    load(command: ConsentPreferenceCommand): Promise<ConsentPreferenceRecord | null>;
    resolveOperation(reference: CustomerReference): Promise<ConsentPreferenceCommandRecord | null>;
    commit(record: ConsentPreferenceCommandRecord): Promise<ConsentPreferenceCommandRecord>;
  };
  readonly projections: {
    load(query: ConsentPreferenceQuery): Promise<ConsentPreferenceProjection>;
  };
  readonly audit: {
    create(input: {
      command: ConsentPreferenceCommand;
      before: ConsentPreferenceRecord;
      after: ConsentPreferenceRecord;
    }): Promise<ConsentPreferenceCommandRecord["audit"]>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
