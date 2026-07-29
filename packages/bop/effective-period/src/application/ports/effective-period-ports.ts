import type { AppendAuditRecordInput } from "@bop/audit";
import type { BusinessAction, PermissionDecision, PermissionResourceScope } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type {
  EffectiveConfigurationVersion,
  EffectivePeriodCode,
  EffectivePeriodIntent,
  EffectivePeriodReference,
  EffectivePeriodVersion,
} from "../../contracts/effective-period.js";

export interface EffectivePeriodAuthorizationRequest {
  readonly tenantContext: TenantContext;
  readonly action: BusinessAction;
  readonly resourceScope: PermissionResourceScope;
  readonly familyReference: EffectivePeriodReference;
  readonly purposeCode: EffectivePeriodCode;
  readonly expectedVersion: EffectivePeriodVersion;
}

export interface EffectivePeriodAuthorizationPort {
  authorize(request: EffectivePeriodAuthorizationRequest): Promise<PermissionDecision>;
}

export interface CommitEffectivePeriodMutationInput {
  readonly expectedVersion: EffectivePeriodVersion;
  readonly idempotencyKey: EffectivePeriodReference;
  readonly current: EffectiveConfigurationVersion | null;
  readonly next: EffectiveConfigurationVersion;
  readonly intents: readonly EffectivePeriodIntent[];
  readonly audit: AppendAuditRecordInput;
}

export interface EffectivePeriodUnitOfWorkPort {
  /**
   * Atomically enforces idempotency and expected version, rechecks exact family/scope overlap
   * against the authoritative store, writes the immutable timing version and intent records, and
   * appends Audit. Replayed, stale, overlapping, partial, or mutable-history writes fail as one
   * transaction. The port records intents only and does not execute activation or expiry.
   */
  commit(input: CommitEffectivePeriodMutationInput): Promise<void>;
}

export interface EffectivePeriodPorts {
  readonly authorization: EffectivePeriodAuthorizationPort;
  readonly unitOfWork: EffectivePeriodUnitOfWorkPort;
}
