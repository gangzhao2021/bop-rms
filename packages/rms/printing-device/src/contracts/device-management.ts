export type DeviceReference = string & { readonly __deviceReference: unique symbol };
export type DeviceCode = string & { readonly __deviceCode: unique symbol };
export interface DeviceScope {
  readonly tenantReference: DeviceReference;
  readonly brandReference: DeviceReference;
  readonly storeReference: DeviceReference;
}
export const deviceTypes = [
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
export type DeviceType = (typeof deviceTypes)[number];
export const deviceLifecycles = [
  "Draft",
  "Provisioning",
  "Active",
  "Suspended",
  "Inactive",
  "Retired",
] as const;
export type DeviceLifecycle = (typeof deviceLifecycles)[number];
export type DeviceHealth = "Healthy" | "Degraded" | "Unavailable" | "Unknown";
export type DeviceConnectivity = "Online" | "Offline" | "Intermittent" | "NotApplicable";
export interface DeviceCapability {
  readonly capabilityCode: DeviceCode;
  readonly validatedModelReference: DeviceReference;
  readonly validationReference: DeviceReference;
}
export interface DeviceAssignment {
  readonly assignmentReference: DeviceReference;
  readonly stationReference: DeviceReference | null;
  readonly profileReference: DeviceReference | null;
  readonly configurationSourceReference: DeviceReference;
  readonly namedOperatorSessionSummaryReference: DeviceReference | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}
export interface DeviceHealthSnapshot {
  readonly signalReference: DeviceReference;
  readonly health: DeviceHealth;
  readonly connectivity: DeviceConnectivity;
  readonly observedAt: string;
  readonly lastSeenAt: string | null;
  readonly heartbeatDueAt: string | null;
  readonly softwareVersionCode: DeviceCode;
  readonly profileVersionCode: DeviceCode;
  readonly incidentReference: DeviceReference | null;
}
export interface DeviceRecord {
  readonly deviceReference: DeviceReference;
  readonly revision: number;
  readonly scope: DeviceScope;
  readonly deviceType: DeviceType;
  readonly deviceCode: DeviceCode;
  readonly safeSerialSuffix: string | null;
  readonly lifecycle: DeviceLifecycle;
  readonly configurationVersion: number;
  readonly displayLabelCode: DeviceCode;
  readonly physicalLocationReference: DeviceReference | null;
  readonly networkConnectionTypeCode: DeviceCode;
  readonly adapterTypeCode: DeviceCode;
  readonly adapterVersionCode: DeviceCode;
  readonly capabilities: readonly DeviceCapability[];
  readonly routingTagCodes: readonly DeviceCode[];
  readonly locale: string;
  readonly timeZone: string;
  readonly outputProfileReference: DeviceReference | null;
  readonly heartbeatIntervalSeconds: number;
  readonly credentialReference: DeviceReference | null;
  readonly credentialVersion: number | null;
  readonly credentialStatus: "NotProvisioned" | "Active" | "Revoked";
  readonly assignment: DeviceAssignment | null;
  readonly currentHealth: DeviceHealthSnapshot | null;
  readonly createdByReference: DeviceReference;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class DeviceContractError extends Error {
  constructor(readonly code: "DEVICE_INPUT_INVALID" | "DEVICE_SCOPE_INVALID") {
    super("Device input is invalid");
    this.name = "DeviceContractError";
  }
}
const fail = (
  code: "DEVICE_INPUT_INVALID" | "DEVICE_SCOPE_INVALID" = "DEVICE_INPUT_INVALID",
): never => {
  throw new DeviceContractError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const codePattern = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const localePattern = /^[a-z]{2,3}(?:-[A-Z]{2})?$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
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
const positive = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fail();
export function parseDeviceReference(value: unknown): DeviceReference {
  return typeof value === "string" && uuid.test(value) ? (value as DeviceReference) : fail();
}
export function parseDeviceCode(value: unknown): DeviceCode {
  return typeof value === "string" && codePattern.test(value) ? (value as DeviceCode) : fail();
}
export function parseDeviceInstant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !instantPattern.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    return fail();
  return value;
}
const nullableReference = (value: unknown): DeviceReference | null =>
  value === null ? null : parseDeviceReference(value);
const nullableInstant = (value: unknown): string | null =>
  value === null ? null : parseDeviceInstant(value);
function parseScope(value: unknown): DeviceScope {
  const raw = exact(value, ["tenantReference", "brandReference", "storeReference"]);
  return Object.freeze({
    tenantReference: parseDeviceReference(raw.tenantReference),
    brandReference: parseDeviceReference(raw.brandReference),
    storeReference: parseDeviceReference(raw.storeReference),
  });
}
function timeZone(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) return fail();
  try {
    if (new Intl.DateTimeFormat("en-CA", { timeZone: value }).resolvedOptions().timeZone !== value)
      return fail();
  } catch {
    return fail();
  }
  return value;
}
function capability(value: unknown): DeviceCapability {
  const raw = exact(value, ["capabilityCode", "validatedModelReference", "validationReference"]);
  return Object.freeze({
    capabilityCode: parseDeviceCode(raw.capabilityCode),
    validatedModelReference: parseDeviceReference(raw.validatedModelReference),
    validationReference: parseDeviceReference(raw.validationReference),
  });
}
function assignment(value: unknown): DeviceAssignment | null {
  if (value === null) return null;
  const raw = exact(value, [
    "assignmentReference",
    "stationReference",
    "profileReference",
    "configurationSourceReference",
    "namedOperatorSessionSummaryReference",
    "effectiveFrom",
    "effectiveTo",
  ]);
  const effectiveFrom = parseDeviceInstant(raw.effectiveFrom);
  const effectiveTo = nullableInstant(raw.effectiveTo);
  if (effectiveTo !== null && Date.parse(effectiveTo) <= Date.parse(effectiveFrom)) return fail();
  return Object.freeze({
    assignmentReference: parseDeviceReference(raw.assignmentReference),
    stationReference: nullableReference(raw.stationReference),
    profileReference: nullableReference(raw.profileReference),
    configurationSourceReference: parseDeviceReference(raw.configurationSourceReference),
    namedOperatorSessionSummaryReference: nullableReference(
      raw.namedOperatorSessionSummaryReference,
    ),
    effectiveFrom,
    effectiveTo,
  });
}
export function createDeviceHealthSnapshot(value: unknown): DeviceHealthSnapshot {
  const raw = exact(value, [
    "signalReference",
    "health",
    "connectivity",
    "observedAt",
    "lastSeenAt",
    "heartbeatDueAt",
    "softwareVersionCode",
    "profileVersionCode",
    "incidentReference",
  ]);
  const observedAt = parseDeviceInstant(raw.observedAt);
  const lastSeenAt = nullableInstant(raw.lastSeenAt);
  const heartbeatDueAt = nullableInstant(raw.heartbeatDueAt);
  const health = oneOf(raw.health, ["Healthy", "Degraded", "Unavailable", "Unknown"] as const);
  const connectivity = oneOf(raw.connectivity, [
    "Online",
    "Offline",
    "Intermittent",
    "NotApplicable",
  ] as const);
  if (
    (connectivity === "Online" && lastSeenAt === null) ||
    (health === "Healthy" && connectivity !== "Online") ||
    (lastSeenAt !== null && Date.parse(lastSeenAt) > Date.parse(observedAt)) ||
    (heartbeatDueAt !== null && Date.parse(heartbeatDueAt) < Date.parse(observedAt)) ||
    (lastSeenAt === null && health !== "Unknown") ||
    (lastSeenAt === null && connectivity !== "Offline" && connectivity !== "NotApplicable")
  )
    return fail();
  return Object.freeze({
    signalReference: parseDeviceReference(raw.signalReference),
    health,
    connectivity,
    observedAt,
    lastSeenAt,
    heartbeatDueAt,
    softwareVersionCode: parseDeviceCode(raw.softwareVersionCode),
    profileVersionCode: parseDeviceCode(raw.profileVersionCode),
    incidentReference: nullableReference(raw.incidentReference),
  });
}
export function createDeviceRecord(value: unknown): DeviceRecord {
  const raw = exact(value, [
    "deviceReference",
    "revision",
    "scope",
    "deviceType",
    "deviceCode",
    "safeSerialSuffix",
    "lifecycle",
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
    "credentialReference",
    "credentialVersion",
    "credentialStatus",
    "assignment",
    "currentHealth",
    "createdByReference",
    "createdAt",
    "updatedAt",
  ]);
  if (!Array.isArray(raw.capabilities) || raw.capabilities.length > 50) return fail();
  const capabilities = Object.freeze(raw.capabilities.map(capability));
  if (new Set(capabilities.map((item) => item.capabilityCode)).size !== capabilities.length)
    return fail();
  if (!Array.isArray(raw.routingTagCodes) || raw.routingTagCodes.length > 30) return fail();
  const routingTagCodes = Object.freeze(raw.routingTagCodes.map(parseDeviceCode));
  if (new Set(routingTagCodes).size !== routingTagCodes.length) return fail();
  const credentialReference = nullableReference(raw.credentialReference);
  const credentialVersion = raw.credentialVersion === null ? null : positive(raw.credentialVersion);
  const credentialStatus = oneOf(raw.credentialStatus, [
    "NotProvisioned",
    "Active",
    "Revoked",
  ] as const);
  if (
    (credentialReference === null) !== (credentialVersion === null) ||
    (credentialStatus === "NotProvisioned") !== (credentialReference === null)
  )
    return fail();
  const lifecycle = oneOf(raw.lifecycle, deviceLifecycles);
  if (lifecycle === "Active" && credentialStatus !== "Active") return fail();
  const createdAt = parseDeviceInstant(raw.createdAt);
  const updatedAt = parseDeviceInstant(raw.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) return fail();
  return Object.freeze({
    deviceReference: parseDeviceReference(raw.deviceReference),
    revision: positive(raw.revision),
    scope: parseScope(raw.scope),
    deviceType: oneOf(raw.deviceType, deviceTypes),
    deviceCode: parseDeviceCode(raw.deviceCode),
    safeSerialSuffix:
      raw.safeSerialSuffix === null
        ? null
        : typeof raw.safeSerialSuffix === "string" && /^[A-Z0-9]{4,12}$/u.test(raw.safeSerialSuffix)
          ? raw.safeSerialSuffix
          : fail(),
    lifecycle,
    configurationVersion: positive(raw.configurationVersion),
    displayLabelCode: parseDeviceCode(raw.displayLabelCode),
    physicalLocationReference: nullableReference(raw.physicalLocationReference),
    networkConnectionTypeCode: parseDeviceCode(raw.networkConnectionTypeCode),
    adapterTypeCode: parseDeviceCode(raw.adapterTypeCode),
    adapterVersionCode: parseDeviceCode(raw.adapterVersionCode),
    capabilities,
    routingTagCodes,
    locale: typeof raw.locale === "string" && localePattern.test(raw.locale) ? raw.locale : fail(),
    timeZone: timeZone(raw.timeZone),
    outputProfileReference: nullableReference(raw.outputProfileReference),
    heartbeatIntervalSeconds:
      typeof raw.heartbeatIntervalSeconds === "number" &&
      Number.isSafeInteger(raw.heartbeatIntervalSeconds) &&
      raw.heartbeatIntervalSeconds >= 15 &&
      raw.heartbeatIntervalSeconds <= 3600
        ? raw.heartbeatIntervalSeconds
        : fail(),
    credentialReference,
    credentialVersion,
    credentialStatus,
    assignment: assignment(raw.assignment),
    currentHealth:
      raw.currentHealth === null ? null : createDeviceHealthSnapshot(raw.currentHealth),
    createdByReference: parseDeviceReference(raw.createdByReference),
    createdAt,
    updatedAt,
  });
}
