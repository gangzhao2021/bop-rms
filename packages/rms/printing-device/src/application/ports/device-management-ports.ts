import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type {
  DeviceRecord,
  DeviceReference,
  DeviceScope,
  DeviceType,
} from "../../contracts/device-management.js";

export type DeviceCommand =
  | "RegisterDevice"
  | "ReviseConfiguration"
  | "ChangeLifecycle"
  | "AssignDevice"
  | "UnassignDevice"
  | "RecordHealth"
  | "RevokeCredential"
  | "OpenIncident";
export type DeviceEventType =
  | "DeviceProvisioned"
  | "DeviceActivated"
  | "DeviceSuspended"
  | "DeviceRetired"
  | "DeviceCredentialRevoked"
  | "DeviceHealthChanged"
  | "DeviceCapabilityChanged";
export interface DeviceEvent {
  readonly eventType: DeviceEventType;
  readonly deviceReference: DeviceReference;
  readonly tenantReference: DeviceReference;
  readonly brandReference: DeviceReference;
  readonly storeReference: DeviceReference;
  readonly aggregateVersion: number;
  readonly lifecycle: DeviceRecord["lifecycle"];
  readonly health: "Healthy" | "Degraded" | "Unavailable" | "Unknown" | null;
  readonly occurredAt: string;
}
export interface DeviceOperation {
  readonly command: DeviceCommand;
  readonly operationReference: DeviceReference;
  readonly intentDigest: string;
  readonly device: DeviceRecord;
  readonly events: readonly DeviceEvent[];
}
export interface DeviceManagementPorts {
  readonly authorization: {
    authorize(input: {
      readonly command: DeviceCommand;
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
  readonly featurePolicy: {
    allowDeviceType(input: {
      readonly deviceType: DeviceType;
      readonly scope: DeviceScope;
      readonly observedAt: string;
    }): Promise<boolean>;
  };
  readonly capabilities: {
    validate(input: {
      readonly deviceReference: DeviceReference;
      readonly deviceType: DeviceType;
      readonly capabilities: DeviceRecord["capabilities"];
      readonly adapterTypeCode: string;
      readonly adapterVersionCode: string;
      readonly observedAt: string;
    }): Promise<boolean>;
  };
  readonly assignments: {
    validate(input: {
      readonly deviceReference: DeviceReference;
      readonly scope: DeviceScope;
      readonly assignment: NonNullable<DeviceRecord["assignment"]>;
      readonly observedAt: string;
    }): Promise<boolean>;
  };
  readonly credentials: {
    revoke(input: {
      readonly deviceReference: DeviceReference;
      readonly scope: DeviceScope;
      readonly credentialReference: DeviceReference;
      readonly credentialVersion: number;
      readonly requestedAt: string;
    }): Promise<DeviceReference>;
  };
  readonly incidents: {
    open(input: {
      readonly deviceReference: DeviceReference;
      readonly scope: DeviceScope;
      readonly healthSignalReference: DeviceReference;
      readonly requestedAt: string;
    }): Promise<DeviceReference>;
  };
  readonly repository: {
    resolveOperation(reference: DeviceReference): Promise<DeviceOperation | null>;
    loadLatest(reference: DeviceReference): Promise<DeviceRecord | null>;
    commit(input: {
      readonly operation: DeviceOperation;
      readonly expectedRevision: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<DeviceOperation>;
  };
}
