import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  DeviceManagementError,
  createDeviceManagementService,
  createDeviceRecord,
  type DeviceManagementPorts,
  type DeviceOperation,
  type DeviceRecord,
} from "../index.js";

const id = (n: number) => `018f9993-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  tenant: id(1),
  brand: id(2),
  store: id(3),
  actor: id(4),
  policy: id(5),
  audit: id(6),
  correlation: id(7),
  device: id(8),
  creator: id(4),
  model: id(9),
  validation: id(10),
  credential: id(11),
  assignment: id(12),
  station: id(13),
  configurationSource: id(14),
  signal: id(15),
  incident: id(16),
};
const times = Array.from(
  { length: 12 },
  (_, index) => `2026-08-15T${String(10 + index).padStart(2, "0")}:00:00.000Z`,
);
const time = (index: number) => {
  const value = times[index];
  if (value === undefined) throw new Error("synthetic Device instant missing");
  return value;
};
const scope = {
  tenantReference: ids.tenant,
  brandReference: ids.brand,
  storeReference: ids.store,
};
function tenant(observedAt: string) {
  return createTenantContext(
    {
      actorType: "User",
      actorReference: ids.actor,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: observedAt,
      recentMfaAt: null,
    } as never,
    createBrand({
      brandReference: ids.brand,
      code: "DEVICE",
      displayName: "Synthetic Device Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: time(0),
      updatedAt: time(0),
    }),
    createStore({
      storeReference: ids.store,
      brandReference: ids.brand,
      code: "DEVICE-1",
      displayName: "Synthetic Device Store",
      timeZone: "America/Toronto",
      locale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: time(0),
      updatedAt: time(0),
    }),
    observedAt,
  );
}
function device(options: Record<string, unknown> = {}): DeviceRecord {
  return createDeviceRecord({
    deviceReference: ids.device,
    revision: 1,
    scope,
    deviceType: "KitchenDisplay",
    deviceCode: "KDS_01",
    safeSerialSuffix: "ABCD1234",
    lifecycle: "Draft",
    configurationVersion: 1,
    displayLabelCode: "HOT_KITCHEN_KDS",
    physicalLocationReference: ids.station,
    networkConnectionTypeCode: "MANAGED_BROWSER",
    adapterTypeCode: "BROWSER_KDS",
    adapterVersionCode: "V1",
    capabilities: [
      {
        capabilityCode: "TOUCH_INPUT",
        validatedModelReference: ids.model,
        validationReference: ids.validation,
      },
    ],
    routingTagCodes: ["HOT_KITCHEN"],
    locale: "en-CA",
    timeZone: "America/Toronto",
    outputProfileReference: null,
    heartbeatIntervalSeconds: 60,
    credentialReference: ids.credential,
    credentialVersion: 1,
    credentialStatus: "Active",
    assignment: null,
    currentHealth: null,
    createdByReference: ids.creator,
    createdAt: time(0),
    updatedAt: time(0),
    ...options,
  });
}
function fixture(
  options: {
    readonly allowType?: boolean;
    readonly validCapabilities?: boolean;
    readonly validAssignment?: boolean;
  } = {},
) {
  let latest: DeviceRecord | null = null;
  let deny = false;
  const operations = new Map<string, DeviceOperation>();
  const actions = {
    RegisterDevice: "device.register",
    ReviseConfiguration: "device.configuration.revise",
    ChangeLifecycle: "device.lifecycle.change",
    AssignDevice: "device.assignment.change",
    UnassignDevice: "device.assignment.change",
    RecordHealth: "device.health.record",
    RevokeCredential: "device.credential.revoke",
    OpenIncident: "device.incident.open",
  } as const;
  const ports: DeviceManagementPorts = {
    authorization: {
      async authorize(input) {
        if (deny) return null;
        return {
          tenantReference: ids.tenant,
          tenantContext: tenant(input.observedAt),
          permission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: actions[input.command],
            scopeKind: "Store",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          audit: {
            auditId: ids.audit,
            brandId: ids.brand,
            storeId: ids.store,
            actor: { type: "User", reference: ids.actor },
            actionCode: `DEVICE_${input.command.toUpperCase()}`,
            targetType: "Device",
            targetId: input.targetReference,
            beforeSummary: {},
            afterSummary: {},
            reasonCode: "AUTHORIZED_DEVICE_OPERATION",
            correlationId: ids.correlation,
            occurredAt: input.observedAt,
            sourceChannel: "API",
            dataClassification: "Confidential",
            retentionPolicyCode: "DEVICE_OPERATION",
            retentionPolicyVersion: 1,
          },
        } as never;
      },
    },
    references: { hashIntent: (value) => `intent:${value}`, equals: (a, b) => a === b },
    featurePolicy: {
      async allowDeviceType() {
        return options.allowType ?? true;
      },
    },
    capabilities: {
      async validate() {
        return options.validCapabilities ?? true;
      },
    },
    assignments: {
      async validate() {
        return options.validAssignment ?? true;
      },
    },
    credentials: {
      async revoke(input) {
        return input.credentialReference;
      },
    },
    incidents: {
      async open() {
        return ids.incident as never;
      },
    },
    repository: {
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async loadLatest() {
        return latest;
      },
      async commit({ operation, expectedRevision }) {
        if ((latest?.revision ?? 0) !== expectedRevision) throw new Error("stale");
        latest = operation.device;
        operations.set(operation.operationReference, operation);
        return operation;
      },
    },
  };
  return {
    service: createDeviceManagementService(ports),
    operations,
    latest: () => latest,
    setDeny(value: boolean) {
      deny = value;
    },
  };
}
const command = (operation: number, expectedRevision: number, value: DeviceRecord) => ({
  operationReference: id(operation),
  expectedRevision,
  device: value,
  purposeCode: "DEVICE_ADMINISTRATION",
  occurredAt: value.updatedAt,
});
function revise(previous: DeviceRecord, at: string, values: Record<string, unknown>) {
  return device({ ...previous, revision: previous.revision + 1, updatedAt: at, ...values });
}
async function active(f: ReturnType<typeof fixture>) {
  const initial = device();
  await f.service.registerDevice(command(30, 0, initial));
  const assigned = revise(initial, time(1), {
    assignment: {
      assignmentReference: ids.assignment,
      stationReference: ids.station,
      profileReference: null,
      configurationSourceReference: ids.configurationSource,
      namedOperatorSessionSummaryReference: null,
      effectiveFrom: time(1),
      effectiveTo: null,
    },
  });
  await f.service.assignDevice(command(31, 1, assigned));
  const provisioning = revise(assigned, time(2), { lifecycle: "Provisioning" });
  await f.service.changeLifecycle(command(32, 2, provisioning));
  const activated = revise(provisioning, time(3), { lifecycle: "Active" });
  await f.service.changeLifecycle(command(33, 3, activated));
  return activated;
}

describe("WP-2180 Device management", () => {
  it("registers, assigns, provisions and activates only an approved capable Device", async () => {
    const f = fixture();
    await active(f);
    expect(f.operations.get(id(32))?.events.map((item) => item.eventType)).toEqual([
      "DeviceProvisioned",
    ]);
    expect(f.operations.get(id(33))?.events.map((item) => item.eventType)).toEqual([
      "DeviceActivated",
    ]);
  });

  it("keeps Health independent and publishes only timestamped state change", async () => {
    const f = fixture();
    const current = await active(f);
    const health = revise(current, time(4), {
      currentHealth: {
        signalReference: ids.signal,
        health: "Unknown",
        connectivity: "Offline",
        observedAt: time(4),
        lastSeenAt: null,
        heartbeatDueAt: time(5),
        softwareVersionCode: "CHROME_140",
        profileVersionCode: "KDS_PROFILE_V1",
        incidentReference: null,
      },
    });
    await f.service.recordHealth(command(34, 4, health));
    expect(f.latest()).toMatchObject({ lifecycle: "Active", currentHealth: { health: "Unknown" } });
    expect(f.operations.get(id(34))?.events).toMatchObject([
      { eventType: "DeviceHealthChanged", health: "Unknown" },
    ]);
  });

  it("blocks disabled physical/future-trigger types and unvalidated capabilities", async () => {
    const physical = device({ deviceType: "KitchenPrinter" });
    await expect(
      fixture({ allowType: false }).service.registerDevice(command(40, 0, physical)),
    ).rejects.toMatchObject({ code: "DEVICE_MANAGEMENT_POLICY_BLOCKED" });
    await expect(
      fixture({ validCapabilities: false }).service.registerDevice(command(41, 0, device())),
    ).rejects.toMatchObject({ code: "DEVICE_MANAGEMENT_CAPABILITY_INVALID" });
  });

  it("re-authorizes idempotent replay and rejects intent reuse", async () => {
    const f = fixture();
    const input = command(50, 0, device());
    await f.service.registerDevice(input);
    f.setDeny(true);
    await expect(f.service.registerDevice(input)).rejects.toMatchObject({
      code: "DEVICE_MANAGEMENT_PERMISSION_DENIED",
    });
    f.setDeny(false);
    await expect(
      f.service.registerDevice(command(50, 0, device({ displayLabelCode: "OTHER_KDS" }))),
    ).rejects.toMatchObject({ code: "DEVICE_MANAGEMENT_IDEMPOTENCY_CONFLICT" });
  });

  it("revokes credential by opaque owner reference and suspends without changing Payment facts", async () => {
    const f = fixture();
    const current = await active(f);
    const revoked = revise(current, time(4), {
      lifecycle: "Suspended",
      credentialStatus: "Revoked",
    });
    await f.service.revokeCredential(command(60, 4, revoked));
    expect(f.operations.get(id(60))?.events.map((item) => item.eventType)).toEqual([
      "DeviceSuspended",
      "DeviceCredentialRevoked",
    ]);
    expect(JSON.stringify(f.latest())).not.toMatch(/payment|provider|token|secret/iu);
  });

  it("opens an opaque incident from the exact current Health signal", async () => {
    const f = fixture();
    const current = await active(f);
    const health = revise(current, time(4), {
      currentHealth: {
        signalReference: ids.signal,
        health: "Degraded",
        connectivity: "Intermittent",
        observedAt: time(4),
        lastSeenAt: time(3),
        heartbeatDueAt: time(5),
        softwareVersionCode: "CHROME_140",
        profileVersionCode: "KDS_PROFILE_V1",
        incidentReference: null,
      },
    });
    await f.service.recordHealth(command(70, 4, health));
    const incident = revise(health, time(5), {
      currentHealth: { ...health.currentHealth, incidentReference: ids.incident },
    });
    await expect(f.service.openIncident(command(71, 5, incident))).resolves.toMatchObject({
      device: { currentHealth: { incidentReference: ids.incident } },
    });
  });

  it("rejects impossible Health, retired shortcuts, restricted extras and stale revisions", async () => {
    expect(() =>
      createDeviceRecord({
        ...device(),
        currentHealth: {
          signalReference: ids.signal,
          health: "Healthy",
          connectivity: "Offline",
          observedAt: time(1),
          lastSeenAt: null,
          heartbeatDueAt: time(2),
          softwareVersionCode: "V1",
          profileVersionCode: "V1",
          incidentReference: null,
        },
      }),
    ).toThrow();
    expect(() => createDeviceRecord({ ...device(), credentialToken: "forbidden" })).toThrow();
    const f = fixture();
    const initial = device();
    await f.service.registerDevice(command(80, 0, initial));
    const retired = revise(initial, time(1), { lifecycle: "Retired" });
    await f.service.changeLifecycle(command(81, 1, retired));
    const activeAgain = revise(retired, time(2), { lifecycle: "Active" });
    await expect(f.service.changeLifecycle(command(82, 2, activeAgain))).rejects.toBeInstanceOf(
      DeviceManagementError,
    );
    await expect(f.service.reviseConfiguration(command(83, 1, initial))).rejects.toMatchObject({
      code: "DEVICE_MANAGEMENT_VERSION_CONFLICT",
    });
  });
});
