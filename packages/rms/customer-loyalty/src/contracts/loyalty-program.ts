import type { AppendAuditRecordInput } from "@bop/audit";
import type { CustomerInstant, CustomerReference } from "../domain/customer-profile.js";
import type {
  LoyaltyLifecycleSimulation,
  LoyaltyProgram,
  LoyaltyProgramLifecycle,
  LoyaltyProgramVersion,
} from "../domain/loyalty-program.js";
export type LoyaltyProgramAction = "Create" | "AppendVersion" | "Validate" | "Publish" | "Schedule";
export interface LoyaltyProgramCommand {
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly actorReference: CustomerReference;
  readonly purpose: "LoyaltyProgramAdministration";
  readonly permission: "loyalty.program.edit" | "loyalty.program.approve";
  readonly operationReference: CustomerReference;
  readonly occurredAt: CustomerInstant;
  readonly action: LoyaltyProgramAction;
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface LoyaltyProgramRecord {
  readonly operationReference: CustomerReference;
  readonly intentHash: string;
  readonly command: LoyaltyProgramCommand;
  readonly before: LoyaltyProgram | null;
  readonly after: LoyaltyProgram;
  readonly simulation: LoyaltyLifecycleSimulation | null;
  readonly audit: AppendAuditRecordInput;
  readonly outcome: "Applied" | "AlreadyApplied";
}
export interface LoyaltyProgramQuery {
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly actorReference: CustomerReference;
  readonly purpose: "LoyaltyProgramAdministration";
  readonly permission: "loyalty.program.read";
  readonly programReference: CustomerReference | null;
  readonly nameToken: string | null;
  readonly programCode: string | null;
  readonly lifecycle: LoyaltyProgramLifecycle | "All";
  readonly storeReference: CustomerReference | null;
  readonly scheduled: boolean | null;
}
export interface LoyaltyProgramProjection {
  readonly projectionName: "loyalty_program_v1";
  readonly projectionVersion: 1;
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly asOfUtc: CustomerInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly mayViewRules: boolean;
    readonly mayEdit: boolean;
    readonly mayApprove: boolean;
  };
  readonly rows: readonly {
    readonly programReference: CustomerReference;
    readonly programCode: string;
    readonly name: string;
    readonly lifecycle: LoyaltyProgramLifecycle;
    readonly currentVersion: number;
    readonly memberCount: number | null;
    readonly earnSummary: string | null;
    readonly redeemSummary: string | null;
    readonly effectiveFromUtc: CustomerInstant;
    readonly effectiveToUtc: CustomerInstant | null;
  }[];
  readonly detail: null | {
    readonly programReference: CustomerReference;
    readonly aggregateVersion: number;
    readonly programCode: string;
    readonly version: LoyaltyProgramVersion;
    readonly validationIssues: readonly string[];
    readonly latestSimulation: LoyaltyLifecycleSimulation | null;
  };
}
