export type DevicePageErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class DevicePageError extends Error {
  constructor(readonly code: DevicePageErrorCode) {
    super("Device page unavailable");
    this.name = "DevicePageError";
  }
}
export interface DeviceClient {
  load(): Promise<unknown>;
}
type DeviceType =
  | "PosTerminal"
  | "ReceiptPrinter"
  | "KitchenPrinter"
  | "LabelPrinter"
  | "KitchenDisplay"
  | "CustomerDisplay"
  | "OrderStatusDisplay"
  | "KitchenAlertDevice"
  | "PaymentTerminalReference"
  | "StoreGateway"
  | "Other";
type Lifecycle = "Draft" | "Provisioning" | "Active" | "Suspended" | "Inactive" | "Retired";
export interface DeviceView {
  readonly screenId: "DEV-DEVICE-LIST" | "DEV-DEVICE-DETAIL";
  readonly queryName: "device_management_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly sourceAsOf: string;
  readonly freshness: "Current" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly permissions: {
    readonly mayRegister: boolean;
    readonly mayAssign: boolean;
    readonly mayDisable: boolean;
    readonly mayOpenIncident: boolean;
    readonly mayRevokeCredential: boolean;
    readonly mayQuarantine: boolean;
    readonly mayRetire: boolean;
  };
  readonly filters: {
    readonly labelCode: string | null;
    readonly safeSerialSuffix: string | null;
    readonly deviceType: DeviceType | null;
    readonly storeReference: string | null;
    readonly lifecycle: Lifecycle | null;
    readonly stationReference: string | null;
    readonly offlineOnly: boolean;
    readonly outdatedOnly: boolean;
  };
  readonly devices: readonly {
    readonly deviceReference: string;
    readonly displayLabelCode: string;
    readonly safeSerialSuffix: string | null;
    readonly deviceType: DeviceType;
    readonly storeReference: string;
    readonly stationReference: string | null;
    readonly assignmentReference: string | null;
    readonly lifecycle: Lifecycle;
    readonly health: "Healthy" | "Degraded" | "Unavailable" | "Unknown";
    readonly connectivity: "Online" | "Intermittent" | "Offline" | "Unknown";
    readonly softwareVersionCode: string | null;
    readonly profileVersionCode: string | null;
    readonly lastSeenAt: string | null;
    readonly capabilityCodes: readonly string[];
    readonly configurationSourceReference: string | null;
    readonly namedOperatorSessionSummaryReference: string | null;
    readonly openIncidentReference: string | null;
    readonly auditSummaryReference: string;
    readonly pilotEligibility: "BrowserKds" | "PaymentTerminalBoundary" | "FutureTriggerDisabled";
  }[];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const codePattern = /^[A-Z0-9][A-Z0-9_.:-]{0,63}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = (): never => {
  throw new DevicePageError("Unavailable");
};
function object(value: unknown, fields: readonly string[]) {
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
  return value as Record<string, unknown>;
}
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail();
const reference = (value: unknown) =>
  typeof value === "string" && uuid.test(value) ? value : fail();
const nullableReference = (value: unknown) => (value === null ? null : reference(value));
const code = (value: unknown) =>
  typeof value === "string" && codePattern.test(value) ? value : fail();
const nullableCode = (value: unknown) => (value === null ? null : code(value));
const instant = (value: unknown) =>
  typeof value === "string" &&
  instantPattern.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail();
const nullableInstant = (value: unknown) => (value === null ? null : instant(value));
const bool = (value: unknown) => (typeof value === "boolean" ? value : fail());
const deviceTypes = [
  "PosTerminal",
  "ReceiptPrinter",
  "KitchenPrinter",
  "LabelPrinter",
  "KitchenDisplay",
  "CustomerDisplay",
  "OrderStatusDisplay",
  "KitchenAlertDevice",
  "PaymentTerminalReference",
  "StoreGateway",
  "Other",
] as const;
const lifecycles = ["Draft", "Provisioning", "Active", "Suspended", "Inactive", "Retired"] as const;
function device(value: unknown): DeviceView["devices"][number] {
  const raw = object(value, [
    "deviceReference",
    "displayLabelCode",
    "safeSerialSuffix",
    "deviceType",
    "storeReference",
    "stationReference",
    "assignmentReference",
    "lifecycle",
    "health",
    "connectivity",
    "softwareVersionCode",
    "profileVersionCode",
    "lastSeenAt",
    "capabilityCodes",
    "configurationSourceReference",
    "namedOperatorSessionSummaryReference",
    "openIncidentReference",
    "auditSummaryReference",
    "pilotEligibility",
  ]);
  if (!Array.isArray(raw.capabilityCodes) || raw.capabilityCodes.length > 50) return fail();
  const capabilityCodes = Object.freeze(raw.capabilityCodes.map(code));
  if (new Set(capabilityCodes).size !== capabilityCodes.length) return fail();
  const connectivity = oneOf(raw.connectivity, [
    "Online",
    "Intermittent",
    "Offline",
    "Unknown",
  ] as const);
  const health = oneOf(raw.health, ["Healthy", "Degraded", "Unavailable", "Unknown"] as const);
  const lastSeenAt = nullableInstant(raw.lastSeenAt);
  if (
    (connectivity === "Offline" && health === "Healthy") ||
    (connectivity === "Offline" && lastSeenAt !== null)
  )
    return fail();
  const deviceType = oneOf(raw.deviceType, deviceTypes);
  const pilotEligibility = oneOf(raw.pilotEligibility, [
    "BrowserKds",
    "PaymentTerminalBoundary",
    "FutureTriggerDisabled",
  ] as const);
  if ((pilotEligibility === "BrowserKds") !== (deviceType === "KitchenDisplay")) return fail();
  if (deviceType === "PaymentTerminalReference" && pilotEligibility !== "PaymentTerminalBoundary")
    return fail();
  if (
    deviceType !== "KitchenDisplay" &&
    deviceType !== "PaymentTerminalReference" &&
    pilotEligibility !== "FutureTriggerDisabled"
  )
    return fail();
  return Object.freeze({
    deviceReference: reference(raw.deviceReference),
    displayLabelCode: code(raw.displayLabelCode),
    safeSerialSuffix: nullableCode(raw.safeSerialSuffix),
    deviceType,
    storeReference: reference(raw.storeReference),
    stationReference: nullableReference(raw.stationReference),
    assignmentReference: nullableReference(raw.assignmentReference),
    lifecycle: oneOf(raw.lifecycle, lifecycles),
    health,
    connectivity,
    softwareVersionCode: nullableCode(raw.softwareVersionCode),
    profileVersionCode: nullableCode(raw.profileVersionCode),
    lastSeenAt,
    capabilityCodes,
    configurationSourceReference: nullableReference(raw.configurationSourceReference),
    namedOperatorSessionSummaryReference: nullableReference(
      raw.namedOperatorSessionSummaryReference,
    ),
    openIncidentReference: nullableReference(raw.openIncidentReference),
    auditSummaryReference: reference(raw.auditSummaryReference),
    pilotEligibility,
  });
}
export function parseDeviceView(value: unknown): DeviceView {
  const raw = object(value, [
    "screenId",
    "queryName",
    "queryVersion",
    "generatedAt",
    "sourceAsOf",
    "freshness",
    "completeness",
    "permissions",
    "filters",
    "devices",
  ]);
  const permissions = object(raw.permissions, [
    "mayRegister",
    "mayAssign",
    "mayDisable",
    "mayOpenIncident",
    "mayRevokeCredential",
    "mayQuarantine",
    "mayRetire",
  ]);
  const filters = object(raw.filters, [
    "labelCode",
    "safeSerialSuffix",
    "deviceType",
    "storeReference",
    "lifecycle",
    "stationReference",
    "offlineOnly",
    "outdatedOnly",
  ]);
  if (!Array.isArray(raw.devices) || raw.devices.length > 500) return fail();
  const devices = Object.freeze(raw.devices.map(device));
  if (new Set(devices.map((item) => item.deviceReference)).size !== devices.length) return fail();
  const screenId = oneOf(raw.screenId, ["DEV-DEVICE-LIST", "DEV-DEVICE-DETAIL"] as const);
  if (screenId === "DEV-DEVICE-DETAIL" && devices.length !== 1) return fail();
  return Object.freeze({
    screenId,
    queryName: oneOf(raw.queryName, ["device_management_v1"] as const),
    queryVersion: raw.queryVersion === 1 ? 1 : fail(),
    generatedAt: instant(raw.generatedAt),
    sourceAsOf: instant(raw.sourceAsOf),
    freshness: oneOf(raw.freshness, ["Current", "Stale"] as const),
    completeness: oneOf(raw.completeness, ["Complete", "Partial"] as const),
    permissions: Object.freeze({
      mayRegister: bool(permissions.mayRegister),
      mayAssign: bool(permissions.mayAssign),
      mayDisable: bool(permissions.mayDisable),
      mayOpenIncident: bool(permissions.mayOpenIncident),
      mayRevokeCredential: bool(permissions.mayRevokeCredential),
      mayQuarantine: bool(permissions.mayQuarantine),
      mayRetire: bool(permissions.mayRetire),
    }),
    filters: Object.freeze({
      labelCode: nullableCode(filters.labelCode),
      safeSerialSuffix: nullableCode(filters.safeSerialSuffix),
      deviceType: filters.deviceType === null ? null : oneOf(filters.deviceType, deviceTypes),
      storeReference: nullableReference(filters.storeReference),
      lifecycle: filters.lifecycle === null ? null : oneOf(filters.lifecycle, lifecycles),
      stationReference: nullableReference(filters.stationReference),
      offlineOnly: bool(filters.offlineOnly),
      outdatedOnly: bool(filters.outdatedOnly),
    }),
    devices,
  });
}
export const unavailableDeviceClient: DeviceClient = {
  load: async () => {
    throw new DevicePageError("Unavailable");
  },
};
