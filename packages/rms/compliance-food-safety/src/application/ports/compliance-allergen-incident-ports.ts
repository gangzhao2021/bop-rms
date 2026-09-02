import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type {
  AllergenControlReview,
  FoodSafetyIncidentRecord,
} from "../../contracts/compliance-allergen-incident.js";
import type {
  ComplianceCode,
  ComplianceReference,
  ComplianceScope,
} from "../../contracts/compliance-dashboard.js";

export type ComplianceAllergenIncidentCommand =
  | "RecordAllergenReview"
  | "ReviseAllergenReview"
  | "EnforceAllergenBlocks"
  | "ReportFoodSafetyIncident"
  | "ReviseFoodSafetyIncident"
  | "EnforceIncidentBlocks";
export interface ComplianceAllergenIncidentEvent {
  readonly eventType: "AllergenControlFailureDetected" | "FoodSafetyIncidentReported";
  readonly recordReference: ComplianceReference;
  readonly tenantReference: ComplianceReference;
  readonly brandReference: ComplianceReference;
  readonly storeReference: ComplianceReference | null;
  readonly requirementVersionReference: ComplianceReference;
  readonly severity: FoodSafetyIncidentRecord["severity"];
  readonly occurredAt: string;
}
export interface ComplianceAllergenIncidentOperation {
  readonly command: ComplianceAllergenIncidentCommand;
  readonly operationReference: ComplianceReference;
  readonly intentDigest: string;
  readonly allergenReview: AllergenControlReview | null;
  readonly incident: FoodSafetyIncidentRecord | null;
  readonly events: readonly ComplianceAllergenIncidentEvent[];
}
export interface ComplianceAllergenIncidentPorts {
  readonly authorization: {
    authorize(input: {
      readonly command: ComplianceAllergenIncidentCommand;
      readonly operationReference: ComplianceReference;
      readonly targetReference: ComplianceReference;
      readonly scope: ComplianceScope;
      readonly purposeCode: ComplianceCode;
      readonly observedAt: string;
    }): Promise<{
      readonly tenantReference: string;
      readonly tenantContext: TenantContext;
      readonly permission: PermissionDecision;
      readonly audit: AppendAuditRecordInput;
    } | null>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
  readonly repository: {
    resolveOperation(
      reference: ComplianceReference,
    ): Promise<ComplianceAllergenIncidentOperation | null>;
    loadLatestReview(reference: ComplianceReference): Promise<AllergenControlReview | null>;
    loadLatestIncident(reference: ComplianceReference): Promise<FoodSafetyIncidentRecord | null>;
    commit(input: {
      readonly operation: ComplianceAllergenIncidentOperation;
      readonly expectedRevision: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<ComplianceAllergenIncidentOperation>;
  };
  readonly allergenSources: {
    assess(input: {
      readonly scope: ComplianceScope;
      readonly subjectKind: AllergenControlReview["subjectKind"];
      readonly subjectReference: ComplianceReference;
      readonly configurationDigest: string;
      readonly allergenPolicyVersionReference: ComplianceReference;
      readonly recipeVersionReferences: readonly ComplianceReference[];
      readonly sourceVersionReferences: readonly ComplianceReference[];
    }): Promise<{
      readonly scope: ComplianceScope;
      readonly matchesPinned: boolean;
      readonly invalidatingSourceVersionReference: ComplianceReference | null;
      readonly assessedAt: string;
    }>;
  };
  readonly cases: {
    resolve(reference: ComplianceReference): Promise<{
      readonly scope: ComplianceScope;
      readonly caseType: "FoodSafetyIncident";
      readonly lifecycle:
        "Open" | "Investigating" | "CorrectiveAction" | "Verification" | "Closed" | "Cancelled";
    } | null>;
  };
  readonly ownerBlocks: {
    enforce(input: {
      readonly operationReference: ComplianceReference;
      readonly scope: ComplianceScope;
      readonly reasonCode: "ALLERGEN_REVIEW_UNSAFE" | "FOOD_SAFETY_INCIDENT";
      readonly subjectReference: ComplianceReference | null;
      readonly orderReference: ComplianceReference | null;
      readonly requirementVersionReference: ComplianceReference;
      readonly configurationDigest: string | null;
      readonly requestedAt: string;
    }): Promise<{
      readonly availabilityBlockOutcomeReference: ComplianceReference;
      readonly paymentBlockOutcomeReference: ComplianceReference;
    }>;
  };
}
