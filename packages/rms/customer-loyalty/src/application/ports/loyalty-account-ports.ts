import type {
  LoyaltyAccountProjection,
  LoyaltyAccountQuery,
  PointsCommand,
  PointsCommandRecord,
  PointsExceptionProjection,
  PointsExceptionQuery,
} from "../../contracts/loyalty-account.js";
import type { CustomerReference } from "../../domain/customer-profile.js";
import type { LoyaltyAccount } from "../../domain/loyalty-account.js";
export interface LoyaltyAccountPorts {
  readonly authorization: {
    authorize(input: PointsCommand | LoyaltyAccountQuery | PointsExceptionQuery): Promise<{
      authorized: boolean;
      mayViewLedger: boolean;
      mayOperate: boolean;
      mayCorrect: boolean;
      mayReview: boolean;
    } | null>;
  };
  readonly source: {
    validate(command: PointsCommand): Promise<{
      valid: boolean;
      sourceFactsMutated: false;
      points: number;
      sourceReference: CustomerReference;
      programVersionReference: CustomerReference;
      ruleVersionReference: CustomerReference;
      originalTransactionReference: CustomerReference | null;
    }>;
  };
  readonly repository: {
    load(input: {
      tenantReference: CustomerReference;
      brandReference: CustomerReference;
      accountReference: CustomerReference;
    }): Promise<LoyaltyAccount | null>;
    resolveOperation(reference: CustomerReference): Promise<PointsCommandRecord | null>;
    commit(record: PointsCommandRecord): Promise<PointsCommandRecord>;
  };
  readonly projections: {
    account(query: LoyaltyAccountQuery): Promise<LoyaltyAccountProjection>;
    exceptions(query: PointsExceptionQuery): Promise<PointsExceptionProjection>;
  };
  readonly audit: {
    create(input: {
      command: PointsCommand;
      before: LoyaltyAccount;
      after: LoyaltyAccount;
    }): Promise<PointsCommandRecord["audit"]>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
