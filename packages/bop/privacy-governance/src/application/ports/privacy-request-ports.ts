import type {
  PrivacyCommand,
  PrivacyCommandRecord,
  PrivacyRequestProjection,
  PrivacyRequestQuery,
} from "../../contracts/privacy-request.js";
import type { PrivacyReference, PrivacyRequest } from "../../domain/privacy-request.js";
export interface PrivacyRequestPorts {
  readonly authorization: {
    authorize(input: PrivacyCommand | PrivacyRequestQuery): Promise<{
      authorized: boolean;
      mayManage: boolean;
      mayIntake: boolean;
      mayVerify: boolean;
      mayFulfill: boolean;
      mayViewVerification: boolean;
    } | null>;
  };
  readonly evidence: {
    verify(command: PrivacyCommand): Promise<{
      valid: boolean;
      proportionalIdentityProof: boolean;
      legalOrPolicyApproved: boolean;
      evidenceReference: PrivacyReference;
    }>;
  };
  readonly repository: {
    load(command: PrivacyCommand): Promise<PrivacyRequest | null>;
    resolveOperation(reference: PrivacyReference): Promise<PrivacyCommandRecord | null>;
    commit(record: PrivacyCommandRecord): Promise<PrivacyCommandRecord>;
  };
  readonly projections: { load(query: PrivacyRequestQuery): Promise<PrivacyRequestProjection> };
  readonly audit: {
    create(
      command: PrivacyCommand,
      before: PrivacyRequest,
      after: PrivacyRequest,
    ): Promise<PrivacyReference>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
