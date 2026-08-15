import type { AppendAuditRecordInput } from "@bop/audit";
import type { BusinessAction, PermissionDecision, PermissionResourceScope } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type { LiveGateRecord } from "../../contracts/live-gate.js";
import type { PublishingReference, PublishingVersion } from "../../contracts/publishing.js";
export interface LiveGateAuthorizationRequest {
  readonly tenantContext: TenantContext;
  readonly action: BusinessAction;
  readonly resourceScope: PermissionResourceScope;
  readonly gateReference: PublishingReference;
  readonly expectedVersion: PublishingVersion;
}
export interface LiveGateMutationPorts {
  readonly authorization: {
    authorize(request: LiveGateAuthorizationRequest): Promise<PermissionDecision>;
  };
  readonly unitOfWork: {
    commit(input: {
      readonly idempotencyKey: string;
      readonly expectedVersion: PublishingVersion;
      readonly current: LiveGateRecord;
      readonly next: LiveGateRecord;
      readonly audit: AppendAuditRecordInput;
    }): Promise<void>;
  };
}
