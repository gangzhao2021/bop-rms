import type { AppendAuditRecordInput } from "@bop/audit";
import type { CustomerInstant, CustomerReference } from "../domain/customer-profile.js";
import type {
  LoyaltyAccount,
  LoyaltyAccountStatus,
  PointsException,
  PointsOperationInput,
  PointsTransaction,
  PointsTransactionType,
} from "../domain/loyalty-account.js";
export interface PointsCommand {
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly actorReference: CustomerReference;
  readonly purpose: "LoyaltyAccountSupport";
  readonly permission: "loyalty.points.operate" | "loyalty.points.correct";
  readonly operationReference: CustomerReference;
  readonly occurredAt: CustomerInstant;
  readonly accountReference: CustomerReference;
  readonly input: PointsOperationInput;
}
export interface PointsCommandRecord {
  readonly operationReference: CustomerReference;
  readonly intentHash: string;
  readonly command: PointsCommand;
  readonly before: LoyaltyAccount;
  readonly after: LoyaltyAccount;
  readonly transaction: PointsTransaction;
  readonly audit: AppendAuditRecordInput;
  readonly outcome: "Applied" | "AlreadyApplied";
}
export interface LoyaltyAccountQuery {
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly actorReference: CustomerReference;
  readonly purpose: "LoyaltyAccountSupport";
  readonly permission: "loyalty.account.read";
  readonly accountReference: CustomerReference | null;
  readonly orderReference: CustomerReference | null;
  readonly transactionTypes: readonly PointsTransactionType[];
  readonly fromUtc: CustomerInstant | null;
}
export interface LoyaltyAccountProjection {
  readonly projectionName: "loyalty_account_v1";
  readonly projectionVersion: 1;
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly asOfUtc: CustomerInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly mayViewLedger: boolean;
    readonly mayOperate: boolean;
    readonly mayCorrect: boolean;
  };
  readonly account: null | {
    readonly accountReference: CustomerReference;
    readonly aggregateVersion: number;
    readonly status: LoyaltyAccountStatus;
    readonly programReference: CustomerReference;
    readonly tierCode: string | null;
    readonly pendingPoints: number;
    readonly availablePoints: number;
    readonly reservedPoints: number;
    readonly lifetimeEarnedPoints: number;
    readonly pointsDebt: number;
    readonly expiringPoints: number;
    readonly ledger: readonly PointsTransaction[] | null;
    readonly rewardReferences: readonly CustomerReference[];
    readonly reservations: LoyaltyAccount["reservations"];
    readonly linkedAllocationReferences: readonly CustomerReference[];
  };
}
export interface PointsExceptionQuery {
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly actorReference: CustomerReference;
  readonly purpose: "LoyaltyExceptionReview";
  readonly permission: "loyalty.points.review";
  readonly accountReference: CustomerReference | null;
  readonly orderReference: CustomerReference | null;
  readonly type: PointsException["type"] | "All";
  readonly status: PointsException["status"] | "All";
  readonly programReference: CustomerReference | null;
  readonly ownerReference: CustomerReference | null;
  readonly overdue: boolean | null;
}
export interface PointsExceptionProjection {
  readonly projectionName: "loyalty_points_exception_v1";
  readonly projectionVersion: 1;
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly asOfUtc: CustomerInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: { readonly mayReview: boolean; readonly mayCorrect: boolean };
  readonly rows: readonly PointsException[];
}
