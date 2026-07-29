import type { AppendAuditRecordInput } from "@bop/audit";
import type { BusinessAction, PermissionDecision, PermissionResourceScope } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type {
  PublishingCode,
  PublishingLifecycleRecord,
  PublishingReference,
  PublishingReleaseRecord,
  PublishingVersion,
} from "../../contracts/publishing.js";

export interface PublishingAuthorizationRequest {
  readonly tenantContext: TenantContext;
  readonly action: BusinessAction;
  readonly resourceScope: PermissionResourceScope;
  readonly familyReference: PublishingReference;
  readonly purposeCode: PublishingCode;
  readonly expectedVersion: PublishingVersion;
}

export interface PublishingAuthorizationPort {
  authorize(request: PublishingAuthorizationRequest): Promise<PermissionDecision>;
}

export interface CommitPublishingMutationInput {
  readonly expectedVersion: PublishingVersion;
  readonly idempotencyKey: PublishingReference;
  readonly current: PublishingLifecycleRecord | null;
  readonly next: PublishingLifecycleRecord;
  readonly release: PublishingReleaseRecord | null;
  readonly supersededReleaseId: PublishingReference | null;
  readonly rollbackTargetReleaseId: PublishingReference | null;
  readonly audit: AppendAuditRecordInput;
}

export interface PublishingUnitOfWorkPort {
  /**
   * Atomically enforces idempotency and expected version, writes immutable next/release records,
   * verifies the supplied previous release is the current family/scope head and any rollback target
   * is an existing eligible immutable release, records supersession without modifying history, and
   * appends Audit. A missing or stale release head must fail the whole commit.
   */
  commit(input: CommitPublishingMutationInput): Promise<void>;
}

export interface PublishingPorts {
  readonly authorization: PublishingAuthorizationPort;
  readonly unitOfWork: PublishingUnitOfWorkPort;
}
