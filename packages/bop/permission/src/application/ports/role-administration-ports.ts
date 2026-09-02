import type { AppendAuditRecordInput } from "@bop/audit";
import type { TenantContext } from "@bop/tenant";
import type {
  BusinessAction,
  PermissionDecision,
  PermissionResourceScope,
} from "../../contracts/permission-evaluation.js";
import type {
  RoleAdministrationReference,
  RoleAdministrationVersion,
  RoleAdministrationVersionRecord,
} from "../../contracts/role-administration.js";
export interface RoleAdministrationAuthorizationRequest {
  readonly tenantContext: TenantContext;
  readonly action: BusinessAction;
  readonly resourceScope: PermissionResourceScope;
  readonly roleReference: RoleAdministrationReference;
  readonly expectedVersion: RoleAdministrationVersion;
}
export interface RoleAdministrationPorts {
  readonly authorization: {
    authorize(request: RoleAdministrationAuthorizationRequest): Promise<PermissionDecision>;
  };
  readonly impact: {
    countActiveAssignments(roleReference: RoleAdministrationReference): Promise<number>;
  };
  readonly policy: { currentVersion(brandReference: string): Promise<number> };
  readonly unitOfWork: {
    commit(input: {
      readonly idempotencyKey: string;
      readonly expectedVersion: RoleAdministrationVersion;
      readonly current: RoleAdministrationVersionRecord;
      readonly next: RoleAdministrationVersionRecord;
      readonly activatePolicy: boolean;
      readonly audit: AppendAuditRecordInput;
    }): Promise<void>;
  };
}
