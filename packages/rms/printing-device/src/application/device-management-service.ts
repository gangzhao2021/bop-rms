import { validateAuditRecord } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";
import {
  createDeviceRecord,
  parseDeviceCode,
  parseDeviceInstant,
  parseDeviceReference,
  type DeviceRecord,
  type DeviceReference,
  type DeviceScope,
} from "../contracts/device-management.js";
import type {
  DeviceCommand,
  DeviceEvent,
  DeviceManagementPorts,
  DeviceOperation,
} from "./ports/device-management-ports.js";

export type DeviceManagementErrorCode =
  | "DEVICE_MANAGEMENT_INPUT_INVALID"
  | "DEVICE_MANAGEMENT_PERMISSION_DENIED"
  | "DEVICE_MANAGEMENT_VERSION_CONFLICT"
  | "DEVICE_MANAGEMENT_IDEMPOTENCY_CONFLICT"
  | "DEVICE_MANAGEMENT_LIFECYCLE_CONFLICT"
  | "DEVICE_MANAGEMENT_POLICY_BLOCKED"
  | "DEVICE_MANAGEMENT_CAPABILITY_INVALID"
  | "DEVICE_MANAGEMENT_ASSIGNMENT_INVALID"
  | "DEVICE_MANAGEMENT_DEPENDENCY_UNAVAILABLE";
export class DeviceManagementError extends Error {
  constructor(readonly code: DeviceManagementErrorCode) {
    super("Device management operation is unavailable");
    this.name = "DeviceManagementError";
  }
}
const fail = (code: DeviceManagementErrorCode = "DEVICE_MANAGEMENT_INPUT_INVALID"): never => {
  throw new DeviceManagementError(code);
};
function dependency(error: unknown): never {
  if (error instanceof DeviceManagementError) throw error;
  throw new DeviceManagementError("DEVICE_MANAGEMENT_DEPENDENCY_UNAVAILABLE");
}
function exact(value: unknown, fields: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail();
}
const permissions: Record<DeviceCommand, string> = {
  RegisterDevice: "device.register",
  ReviseConfiguration: "device.configuration.revise",
  ChangeLifecycle: "device.lifecycle.change",
  AssignDevice: "device.assignment.change",
  UnassignDevice: "device.assignment.change",
  RecordHealth: "device.health.record",
  RevokeCredential: "device.credential.revoke",
  OpenIncident: "device.incident.open",
};
const transitions: Record<DeviceRecord["lifecycle"], readonly DeviceRecord["lifecycle"][]> = {
  Draft: ["Provisioning", "Retired"],
  Provisioning: ["Active", "Suspended", "Inactive"],
  Active: ["Suspended", "Inactive", "Retired"],
  Suspended: ["Provisioning", "Active", "Inactive", "Retired"],
  Inactive: ["Provisioning", "Retired"],
  Retired: ["Inactive"],
};
function sameScope(a: DeviceScope, b: DeviceScope) {
  return (
    a.tenantReference === b.tenantReference &&
    a.brandReference === b.brandReference &&
    a.storeReference === b.storeReference
  );
}
function sameExcept(a: DeviceRecord, b: DeviceRecord, mutable: readonly (keyof DeviceRecord)[]) {
  const ignored = new Set<keyof DeviceRecord>(["revision", "updatedAt", ...mutable]);
  return (Object.keys(a) as (keyof DeviceRecord)[]).every(
    (key) => ignored.has(key) || JSON.stringify(a[key]) === JSON.stringify(b[key]),
  );
}
function events(previous: DeviceRecord | null, next: DeviceRecord): readonly DeviceEvent[] {
  const types: DeviceEvent["eventType"][] = [];
  if (previous !== null) {
    if (previous.lifecycle !== next.lifecycle) {
      if (next.lifecycle === "Provisioning") types.push("DeviceProvisioned");
      if (next.lifecycle === "Active") types.push("DeviceActivated");
      if (next.lifecycle === "Suspended") types.push("DeviceSuspended");
      if (next.lifecycle === "Retired") types.push("DeviceRetired");
    }
    if (previous.credentialStatus !== "Revoked" && next.credentialStatus === "Revoked")
      types.push("DeviceCredentialRevoked");
    if (JSON.stringify(previous.capabilities) !== JSON.stringify(next.capabilities))
      types.push("DeviceCapabilityChanged");
    if (
      previous.currentHealth?.health !== next.currentHealth?.health ||
      previous.currentHealth?.connectivity !== next.currentHealth?.connectivity
    )
      types.push("DeviceHealthChanged");
  }
  return Object.freeze(
    types.map((eventType) =>
      Object.freeze({
        eventType,
        deviceReference: next.deviceReference,
        tenantReference: next.scope.tenantReference,
        brandReference: next.scope.brandReference,
        storeReference: next.scope.storeReference,
        aggregateVersion: next.revision,
        lifecycle: next.lifecycle,
        health: next.currentHealth?.health ?? null,
        occurredAt: next.updatedAt,
      }),
    ),
  );
}
async function authorize(
  ports: DeviceManagementPorts,
  input: {
    command: DeviceCommand;
    operationReference: DeviceReference;
    targetReference: DeviceReference;
    scope: DeviceScope;
    purposeCode: string;
    observedAt: string;
  },
) {
  const evidence = await ports.authorization.authorize(input).catch(dependency);
  if (evidence === null) return fail("DEVICE_MANAGEMENT_PERMISSION_DENIED");
  try {
    const context = revalidateTenantContext(evidence.tenantContext);
    const audit = validateAuditRecord(evidence.audit, Date.parse(input.observedAt));
    const actorReference = context.actor.actorReference;
    if (
      actorReference === null ||
      evidence.tenantReference !== input.scope.tenantReference ||
      String(context.brand.brandReference) !== input.scope.brandReference ||
      String(context.store?.storeReference) !== input.scope.storeReference ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.action !== permissions[input.command] ||
      evidence.permission.scopeKind !== "Store" ||
      audit.brandId !== input.scope.brandReference ||
      audit.storeId !== input.scope.storeReference ||
      audit.actor.type === "System" ||
      audit.actor.reference !== actorReference ||
      audit.actionCode !== `DEVICE_${input.command.toUpperCase()}` ||
      audit.targetType !== "Device" ||
      audit.targetId !== input.targetReference ||
      audit.occurredAt !== input.observedAt
    )
      throw new Error("denied");
    return Object.freeze({
      audit,
      actorReference: parseDeviceReference(actorReference),
    });
  } catch {
    return fail("DEVICE_MANAGEMENT_PERMISSION_DENIED");
  }
}

export function createDeviceManagementService(ports: DeviceManagementPorts) {
  async function apply(input: {
    readonly command: DeviceCommand;
    readonly operationReference: string;
    readonly expectedRevision: number;
    readonly device: unknown;
    readonly purposeCode: string;
    readonly occurredAt: string;
  }) {
    exact(input, [
      "command",
      "operationReference",
      "expectedRevision",
      "device",
      "purposeCode",
      "occurredAt",
    ]);
    let device: DeviceRecord;
    let operationReference: DeviceReference;
    let occurredAt: string;
    let purposeCode: string;
    try {
      device = createDeviceRecord(input.device);
      operationReference = parseDeviceReference(input.operationReference);
      occurredAt = parseDeviceInstant(input.occurredAt);
      purposeCode = parseDeviceCode(input.purposeCode);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
        return fail();
    } catch {
      return fail();
    }
    if (device.updatedAt !== occurredAt) return fail("DEVICE_MANAGEMENT_VERSION_CONFLICT");
    const authorized = await authorize(ports, {
      command: input.command,
      operationReference,
      targetReference: device.deviceReference,
      scope: device.scope,
      purposeCode,
      observedAt: occurredAt,
    });
    if (
      input.command === "RegisterDevice" &&
      device.createdByReference !== authorized.actorReference
    )
      return fail("DEVICE_MANAGEMENT_PERMISSION_DENIED");
    const digest = ports.references.hashIntent(JSON.stringify(input));
    const existing = await ports.repository.resolveOperation(operationReference).catch(dependency);
    if (existing !== null) {
      if (!ports.references.equals(existing.intentDigest, digest))
        return fail("DEVICE_MANAGEMENT_IDEMPOTENCY_CONFLICT");
      return Object.freeze({ status: "AlreadyApplied" as const, device: existing.device });
    }
    const latest = await ports.repository.loadLatest(device.deviceReference).catch(dependency);
    if (
      device.revision !== input.expectedRevision + 1 ||
      (latest === null ? input.expectedRevision !== 0 : latest.revision !== input.expectedRevision)
    )
      return fail("DEVICE_MANAGEMENT_VERSION_CONFLICT");
    if (input.command === "RegisterDevice") {
      const allowed = await ports.featurePolicy
        .allowDeviceType({
          deviceType: device.deviceType,
          scope: device.scope,
          observedAt: occurredAt,
        })
        .catch(dependency);
      const validCapabilities = await ports.capabilities
        .validate({
          deviceReference: device.deviceReference,
          deviceType: device.deviceType,
          capabilities: device.capabilities,
          adapterTypeCode: device.adapterTypeCode,
          adapterVersionCode: device.adapterVersionCode,
          observedAt: occurredAt,
        })
        .catch(dependency);
      if (!allowed) return fail("DEVICE_MANAGEMENT_POLICY_BLOCKED");
      if (!validCapabilities) return fail("DEVICE_MANAGEMENT_CAPABILITY_INVALID");
      if (
        latest !== null ||
        device.revision !== 1 ||
        device.lifecycle !== "Draft" ||
        device.configurationVersion !== 1 ||
        device.assignment !== null ||
        device.currentHealth !== null ||
        device.createdAt !== occurredAt
      )
        return fail("DEVICE_MANAGEMENT_LIFECYCLE_CONFLICT");
    } else {
      if (
        latest === null ||
        !sameScope(latest.scope, device.scope) ||
        latest.deviceReference !== device.deviceReference ||
        latest.deviceType !== device.deviceType ||
        latest.deviceCode !== device.deviceCode ||
        latest.createdByReference !== device.createdByReference ||
        latest.createdAt !== device.createdAt
      )
        return fail("DEVICE_MANAGEMENT_LIFECYCLE_CONFLICT");
      if (input.command === "ReviseConfiguration") {
        const valid = await ports.capabilities
          .validate({
            deviceReference: device.deviceReference,
            deviceType: device.deviceType,
            capabilities: device.capabilities,
            adapterTypeCode: device.adapterTypeCode,
            adapterVersionCode: device.adapterVersionCode,
            observedAt: occurredAt,
          })
          .catch(dependency);
        if (!valid) return fail("DEVICE_MANAGEMENT_CAPABILITY_INVALID");
        if (
          latest.lifecycle === "Retired" ||
          device.configurationVersion !== latest.configurationVersion + 1 ||
          !sameExcept(latest, device, [
            "configurationVersion",
            "displayLabelCode",
            "physicalLocationReference",
            "networkConnectionTypeCode",
            "adapterTypeCode",
            "adapterVersionCode",
            "capabilities",
            "routingTagCodes",
            "locale",
            "timeZone",
            "outputProfileReference",
            "heartbeatIntervalSeconds",
          ])
        )
          return fail("DEVICE_MANAGEMENT_LIFECYCLE_CONFLICT");
      }
      if (input.command === "ChangeLifecycle") {
        if (
          !transitions[latest.lifecycle].includes(device.lifecycle) ||
          !sameExcept(latest, device, ["lifecycle"])
        )
          return fail("DEVICE_MANAGEMENT_LIFECYCLE_CONFLICT");
        if (device.lifecycle === "Active") {
          const allowed = await ports.featurePolicy
            .allowDeviceType({
              deviceType: device.deviceType,
              scope: device.scope,
              observedAt: occurredAt,
            })
            .catch(dependency);
          const valid = await ports.capabilities
            .validate({
              deviceReference: device.deviceReference,
              deviceType: device.deviceType,
              capabilities: device.capabilities,
              adapterTypeCode: device.adapterTypeCode,
              adapterVersionCode: device.adapterVersionCode,
              observedAt: occurredAt,
            })
            .catch(dependency);
          if (!allowed) return fail("DEVICE_MANAGEMENT_POLICY_BLOCKED");
          if (!valid || device.assignment === null)
            return fail("DEVICE_MANAGEMENT_CAPABILITY_INVALID");
        }
      }
      if (input.command === "AssignDevice") {
        if (
          device.assignment === null ||
          latest.assignment !== null ||
          !sameExcept(latest, device, ["assignment"])
        )
          return fail("DEVICE_MANAGEMENT_ASSIGNMENT_INVALID");
        const valid = await ports.assignments
          .validate({
            deviceReference: device.deviceReference,
            scope: device.scope,
            assignment: device.assignment,
            observedAt: occurredAt,
          })
          .catch(dependency);
        if (!valid) return fail("DEVICE_MANAGEMENT_ASSIGNMENT_INVALID");
      }
      if (input.command === "UnassignDevice") {
        if (
          latest.assignment === null ||
          device.assignment !== null ||
          latest.lifecycle === "Active" ||
          !sameExcept(latest, device, ["assignment"])
        )
          return fail("DEVICE_MANAGEMENT_ASSIGNMENT_INVALID");
      }
      if (input.command === "RecordHealth") {
        if (
          device.currentHealth === null ||
          !sameExcept(latest, device, ["currentHealth"]) ||
          (latest.currentHealth !== null &&
            Date.parse(device.currentHealth.observedAt) <=
              Date.parse(latest.currentHealth.observedAt))
        )
          return fail("DEVICE_MANAGEMENT_LIFECYCLE_CONFLICT");
      }
      if (input.command === "RevokeCredential") {
        if (
          latest.credentialReference === null ||
          latest.credentialVersion === null ||
          device.credentialReference !== latest.credentialReference ||
          device.credentialVersion !== latest.credentialVersion ||
          device.credentialStatus !== "Revoked" ||
          device.lifecycle !== "Suspended" ||
          !sameExcept(latest, device, ["credentialStatus", "lifecycle"])
        )
          return fail("DEVICE_MANAGEMENT_LIFECYCLE_CONFLICT");
        const outcome = await ports.credentials
          .revoke({
            deviceReference: device.deviceReference,
            scope: device.scope,
            credentialReference: latest.credentialReference,
            credentialVersion: latest.credentialVersion,
            requestedAt: occurredAt,
          })
          .catch(dependency);
        if (outcome !== latest.credentialReference)
          return fail("DEVICE_MANAGEMENT_DEPENDENCY_UNAVAILABLE");
      }
      if (input.command === "OpenIncident") {
        if (
          latest.currentHealth === null ||
          latest.currentHealth.incidentReference !== null ||
          device.currentHealth?.incidentReference === null ||
          device.currentHealth?.signalReference !== latest.currentHealth.signalReference ||
          !sameExcept(latest, device, ["currentHealth"])
        )
          return fail("DEVICE_MANAGEMENT_LIFECYCLE_CONFLICT");
        const outcome = await ports.incidents
          .open({
            deviceReference: device.deviceReference,
            scope: device.scope,
            healthSignalReference: latest.currentHealth.signalReference,
            requestedAt: occurredAt,
          })
          .catch(dependency);
        if (outcome !== device.currentHealth.incidentReference)
          return fail("DEVICE_MANAGEMENT_DEPENDENCY_UNAVAILABLE");
      }
    }
    const operation: DeviceOperation = Object.freeze({
      command: input.command,
      operationReference,
      intentDigest: digest,
      device,
      events: events(latest, device),
    });
    const committed = await ports.repository
      .commit({
        operation,
        expectedRevision: input.expectedRevision,
        audit: authorized.audit,
      })
      .catch(dependency);
    return Object.freeze({ status: "Applied" as const, device: committed.device });
  }
  const invoke =
    (command: DeviceCommand) =>
    (input: {
      readonly operationReference: string;
      readonly expectedRevision: number;
      readonly device: unknown;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) =>
      apply({ ...input, command });
  return Object.freeze({
    registerDevice: invoke("RegisterDevice"),
    reviseConfiguration: invoke("ReviseConfiguration"),
    changeLifecycle: invoke("ChangeLifecycle"),
    assignDevice: invoke("AssignDevice"),
    unassignDevice: invoke("UnassignDevice"),
    recordHealth: invoke("RecordHealth"),
    revokeCredential: invoke("RevokeCredential"),
    openIncident: invoke("OpenIncident"),
  });
}
