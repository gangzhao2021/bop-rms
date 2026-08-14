import type {
  LoyaltyProgramCommand,
  LoyaltyProgramProjection,
  LoyaltyProgramQuery,
  LoyaltyProgramRecord,
} from "../../contracts/loyalty-program.js";
import type { CustomerReference } from "../../domain/customer-profile.js";
import type { LoyaltyLifecycleSimulation, LoyaltyProgram } from "../../domain/loyalty-program.js";
export interface LoyaltyProgramPorts {
  readonly authorization: {
    authorize(input: LoyaltyProgramCommand | LoyaltyProgramQuery): Promise<{
      authorized: boolean;
      mayViewRules: boolean;
      mayEdit: boolean;
      mayApprove: boolean;
    } | null>;
  };
  readonly validation: {
    validate(input: { command: LoyaltyProgramCommand; program: LoyaltyProgram }): Promise<{
      valid: boolean;
      evidenceReference: CustomerReference;
      simulation: LoyaltyLifecycleSimulation;
      pricingCalculatedMoney: false;
      pointsUsedAsTender: false;
      effectiveVersionConflict: false;
    }>;
  };
  readonly approval: {
    validate(input: { command: LoyaltyProgramCommand; program: LoyaltyProgram }): Promise<{
      approved: boolean;
      approvalReference: CustomerReference;
      approverReference: CustomerReference;
    }>;
  };
  readonly repository: {
    load(input: {
      tenantReference: CustomerReference;
      brandReference: CustomerReference;
      programReference: CustomerReference;
    }): Promise<LoyaltyProgram | null>;
    resolveOperation(reference: CustomerReference): Promise<LoyaltyProgramRecord | null>;
    commit(record: LoyaltyProgramRecord): Promise<LoyaltyProgramRecord>;
  };
  readonly projection: { query(query: LoyaltyProgramQuery): Promise<LoyaltyProgramProjection> };
  readonly audit: {
    create(input: {
      command: LoyaltyProgramCommand;
      before: LoyaltyProgram | null;
      after: LoyaltyProgram;
    }): Promise<LoyaltyProgramRecord["audit"]>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
