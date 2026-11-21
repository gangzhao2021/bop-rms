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
    /** WP-2423 role presets: staff role requests still waiting that would give this role. */
    countOpenAssignmentChanges(roleReference: RoleAdministrationReference): Promise<number>;
  };
  /**
   * WP-2423 role presets: for ApproveAlone only, read inside the transaction after the policy
   * fence: throws unless the submitter runs the Brand alone now with a second factor at most 15
   * minutes old, and returns that time for the mark.
   */
  readonly soleOperator?: { confirm(): Promise<{ readonly actorMfaAt: string }> };
  readonly policy: { currentVersion(brandReference: string): Promise<number> };
  readonly unitOfWork: {
    commit(input: {
      readonly idempotencyKey: string;
      /** Null for a new role (Create, Duplicate). */
      readonly expectedVersion: RoleAdministrationVersion | null;
      readonly current: RoleAdministrationVersionRecord | null;
      readonly next: RoleAdministrationVersionRecord;
      readonly activatePolicy: boolean;
      /**
       * ApproveAlone: confirmed inside the transaction after the role's lock; its second-factor
       * time is written with the mark and the audit.
       */
      readonly soleOperator: { confirm(): Promise<{ readonly actorMfaAt: string }> } | null;
      readonly audit: (actorMfaAt: string | null) => AppendAuditRecordInput;
    }): Promise<void>;
  };
}
