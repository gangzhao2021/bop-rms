import type { AppendAuditRecordInput } from "@bop/audit";
import type { BusinessAction, PermissionDecision, PermissionResourceScope } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type { FeatureControlAdministrationDefinition } from "../../contracts/feature-control-administration.js";
import type {
  FeatureControlReference,
  FeatureControlVersion,
} from "../../contracts/feature-control.js";
export interface FeatureControlAdministrationAuthorizationRequest {
  readonly tenantContext: TenantContext;
  readonly action: BusinessAction;
  readonly resourceScope: PermissionResourceScope;
  readonly controlId: FeatureControlReference;
  readonly expectedVersion: FeatureControlVersion;
}
export interface FeatureControlAdministrationPorts {
  readonly authorization: {
    authorize(
      request: FeatureControlAdministrationAuthorizationRequest,
    ): Promise<PermissionDecision>;
  };
  readonly unitOfWork: {
    commit(input: {
      readonly idempotencyKey: string;
      readonly expectedVersion: FeatureControlVersion;
      readonly current: FeatureControlAdministrationDefinition;
      readonly next: FeatureControlAdministrationDefinition;
      readonly audit: AppendAuditRecordInput;
    }): Promise<void>;
  };
}
