import type { AppendAuditRecordInput } from "@bop/audit";
import type { BusinessAction, PermissionDecision, PermissionResourceScope } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type {
  FeatureControlDefinition,
  FeatureControlReference,
  FeatureControlVersion,
} from "../../contracts/feature-control.js";

export interface FeatureControlAuthorizationRequest {
  readonly tenantContext: TenantContext;
  readonly action: BusinessAction;
  readonly resourceScope: PermissionResourceScope;
  readonly controlId: FeatureControlReference;
  readonly expectedVersion: FeatureControlVersion;
}

export interface FeatureControlAuthorizationPort {
  authorize(request: FeatureControlAuthorizationRequest): Promise<PermissionDecision>;
}

export interface CommitFeatureControlMutationInput {
  readonly expectedVersion: FeatureControlVersion;
  readonly current: FeatureControlDefinition;
  readonly next: FeatureControlDefinition;
  readonly audit: AppendAuditRecordInput;
}

export interface FeatureControlUnitOfWorkPort {
  /**
   * Atomically persists the next control version and appends the supplied Audit record.
   * Implementations must reject an expected-version mismatch and must never commit only one side.
   */
  commit(input: CommitFeatureControlMutationInput): Promise<void>;
}

export interface FeatureControlMutationPorts {
  readonly authorization: FeatureControlAuthorizationPort;
  readonly unitOfWork: FeatureControlUnitOfWorkPort;
}
