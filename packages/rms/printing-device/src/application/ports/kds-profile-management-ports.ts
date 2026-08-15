import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type { DeviceReference, DeviceScope } from "../../contracts/device-management.js";
import type { KdsProfileRecord } from "../../contracts/kds-profile-management.js";
export type KdsProfileCommand =
  | "CreateKdsProfile"
  | "ReviseKdsProfile"
  | "AssignKdsProfile"
  | "RecordKdsUat"
  | "PublishKdsProfile"
  | "RevokeKdsProfile";
export interface KdsProfileOperation {
  readonly command: KdsProfileCommand;
  readonly operationReference: DeviceReference;
  readonly intentDigest: string;
  readonly profile: KdsProfileRecord;
}
export interface KdsProfileManagementPorts {
  readonly authorization: {
    authorize(input: {
      readonly command: KdsProfileCommand;
      readonly operationReference: DeviceReference;
      readonly targetReference: DeviceReference;
      readonly scope: DeviceScope;
      readonly purposeCode: string;
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
  readonly eligibility: {
    validate(input: { readonly profile: KdsProfileRecord; readonly observedAt: string }): Promise<{
      readonly eligible: boolean;
      readonly activeNamedOperatorSession: boolean;
      readonly fresh: boolean;
    }>;
  };
  readonly evidence: {
    isAccepted(input: {
      readonly evidenceReference: DeviceReference;
      readonly profileReference: DeviceReference;
      readonly runReference: DeviceReference;
      readonly observedAt: string;
    }): Promise<boolean>;
  };
  readonly repository: {
    resolveOperation(reference: DeviceReference): Promise<KdsProfileOperation | null>;
    loadLatest(reference: DeviceReference): Promise<KdsProfileRecord | null>;
    commit(input: {
      readonly operation: KdsProfileOperation;
      readonly expectedRevision: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<KdsProfileOperation>;
  };
}
