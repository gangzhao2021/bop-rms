import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type {
  ComplianceCode,
  ComplianceDashboardFilter,
  ComplianceDashboardSourceSnapshot,
  ComplianceReference,
  ComplianceScope,
} from "../../contracts/compliance-dashboard.js";

export interface ComplianceDashboardAuthorizationEvidence {
  readonly tenantReference: string;
  readonly tenantContext: TenantContext;
  readonly permission: PermissionDecision;
}

export interface ComplianceDashboardPorts {
  readonly authorization: {
    authorize(input: {
      readonly operationReference: ComplianceReference;
      readonly purposeCode: ComplianceCode;
      readonly scope: ComplianceScope;
      readonly observedAt: string;
    }): Promise<ComplianceDashboardAuthorizationEvidence | null>;
  };
  readonly source: {
    load(input: {
      readonly scope: ComplianceScope;
      readonly filter: ComplianceDashboardFilter;
      readonly observedAt: string;
    }): Promise<ComplianceDashboardSourceSnapshot | null>;
  };
}
