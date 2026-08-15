import {
  parseDeviceCode,
  parseDeviceInstant,
  parseDeviceReference,
  type DeviceCode,
  type DeviceReference,
  type DeviceScope,
} from "./device-management.js";

export const kdsUatCheckCodes = [
  "ACCESSIBILITY",
  "AUTO_LOCK",
  "MANAGED_BROWSER",
  "NAMED_SESSION_HANDOVER",
  "NETWORK_LOSS",
  "NOTIFICATION",
  "REPLACEMENT",
  "RESOLUTION",
  "VISIBILITY_LOCK",
  "WAKE_POWER",
] as const;
export type KdsUatCheckCode = (typeof kdsUatCheckCodes)[number];
export type KdsProfileLifecycle = "Draft" | "Published" | "Revoked";
export interface KdsProfileVersion {
  readonly versionReference: DeviceReference;
  readonly versionNumber: number;
  readonly profileLabelCode: DeviceCode;
  readonly browserFamily: "ChromiumManaged";
  readonly minimumLogicalWidth: number;
  readonly minimumLogicalHeight: number;
  readonly wakePolicyCode: DeviceCode;
  readonly powerPolicyCode: DeviceCode;
  readonly autoLockSeconds: number;
  readonly visibilityLossLocks: true;
  readonly handoverPolicy: "LockThenRotateNamedSession";
  readonly notificationMode: "VisualAndAudible" | "VisualOnly";
  readonly networkProcedureCode: "KDS-NETWORK-RECOVERY-V1";
  readonly replacementProcedureCode: "KDS-REPLACEMENT-V1";
  readonly checklistVersionCode: DeviceCode;
  readonly createdAt: string;
}
export interface KdsProfileAssignment {
  readonly assignmentReference: DeviceReference;
  readonly deviceReference: DeviceReference;
  readonly stationReference: DeviceReference;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}
export interface KdsUatCheckResult {
  readonly resultReference: DeviceReference;
  readonly checkCode: KdsUatCheckCode;
  readonly outcome: "Passed" | "Failed" | "Blocked";
  readonly safeResultCode: DeviceCode;
  readonly recordedAt: string;
}
export interface KdsUatRun {
  readonly runReference: DeviceReference;
  readonly runNumber: number;
  readonly profileVersionReference: DeviceReference;
  readonly deviceReference: DeviceReference;
  readonly stationReference: DeviceReference;
  readonly checklistVersionCode: DeviceCode;
  readonly browserVersionCode: DeviceCode;
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly status: "NotRun" | "InProgress" | "Blocked" | "Failed" | "Passed";
  readonly dueAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly evidenceReference: DeviceReference | null;
  readonly checks: readonly KdsUatCheckResult[];
}
export interface KdsProfileRecord {
  readonly profileReference: DeviceReference;
  readonly revision: number;
  readonly scope: DeviceScope;
  readonly lifecycle: KdsProfileLifecycle;
  readonly currentVersion: KdsProfileVersion;
  readonly assignment: KdsProfileAssignment | null;
  readonly currentUat: KdsUatRun | null;
  readonly createdByReference: DeviceReference;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export class KdsProfileContractError extends Error {
  constructor() {
    super("KDS_PROFILE_INPUT_INVALID");
    this.name = "KdsProfileContractError";
  }
}
const fail = (): never => {
  throw new KdsProfileContractError();
};
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
const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fail();
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail();
const nullableReference = (value: unknown) => (value === null ? null : parseDeviceReference(value));
const nullableInstant = (value: unknown) => (value === null ? null : parseDeviceInstant(value));
function version(value: unknown): KdsProfileVersion {
  const raw = exact(value, [
    "versionReference",
    "versionNumber",
    "profileLabelCode",
    "browserFamily",
    "minimumLogicalWidth",
    "minimumLogicalHeight",
    "wakePolicyCode",
    "powerPolicyCode",
    "autoLockSeconds",
    "visibilityLossLocks",
    "handoverPolicy",
    "notificationMode",
    "networkProcedureCode",
    "replacementProcedureCode",
    "checklistVersionCode",
    "createdAt",
  ]);
  const minimumLogicalWidth = positive(raw.minimumLogicalWidth);
  const minimumLogicalHeight = positive(raw.minimumLogicalHeight);
  const autoLockSeconds = positive(raw.autoLockSeconds);
  if (
    minimumLogicalWidth < 1024 ||
    minimumLogicalHeight < 768 ||
    autoLockSeconds < 60 ||
    autoLockSeconds > 900 ||
    raw.visibilityLossLocks !== true
  )
    return fail();
  return Object.freeze({
    versionReference: parseDeviceReference(raw.versionReference),
    versionNumber: positive(raw.versionNumber),
    profileLabelCode: parseDeviceCode(raw.profileLabelCode),
    browserFamily: oneOf(raw.browserFamily, ["ChromiumManaged"] as const),
    minimumLogicalWidth,
    minimumLogicalHeight,
    wakePolicyCode: parseDeviceCode(raw.wakePolicyCode),
    powerPolicyCode: parseDeviceCode(raw.powerPolicyCode),
    autoLockSeconds,
    visibilityLossLocks: true,
    handoverPolicy: oneOf(raw.handoverPolicy, ["LockThenRotateNamedSession"] as const),
    notificationMode: oneOf(raw.notificationMode, ["VisualAndAudible", "VisualOnly"] as const),
    networkProcedureCode: oneOf(raw.networkProcedureCode, ["KDS-NETWORK-RECOVERY-V1"] as const),
    replacementProcedureCode: oneOf(raw.replacementProcedureCode, ["KDS-REPLACEMENT-V1"] as const),
    checklistVersionCode: parseDeviceCode(raw.checklistVersionCode),
    createdAt: parseDeviceInstant(raw.createdAt),
  });
}
function assignment(value: unknown): KdsProfileAssignment | null {
  if (value === null) return null;
  const raw = exact(value, [
    "assignmentReference",
    "deviceReference",
    "stationReference",
    "effectiveFrom",
    "effectiveTo",
  ]);
  const effectiveFrom = parseDeviceInstant(raw.effectiveFrom);
  const effectiveTo = nullableInstant(raw.effectiveTo);
  if (effectiveTo !== null && Date.parse(effectiveTo) <= Date.parse(effectiveFrom)) return fail();
  return Object.freeze({
    assignmentReference: parseDeviceReference(raw.assignmentReference),
    deviceReference: parseDeviceReference(raw.deviceReference),
    stationReference: parseDeviceReference(raw.stationReference),
    effectiveFrom,
    effectiveTo,
  });
}
function check(value: unknown): KdsUatCheckResult {
  const raw = exact(value, [
    "resultReference",
    "checkCode",
    "outcome",
    "safeResultCode",
    "recordedAt",
  ]);
  return Object.freeze({
    resultReference: parseDeviceReference(raw.resultReference),
    checkCode: oneOf(raw.checkCode, kdsUatCheckCodes),
    outcome: oneOf(raw.outcome, ["Passed", "Failed", "Blocked"] as const),
    safeResultCode: parseDeviceCode(raw.safeResultCode),
    recordedAt: parseDeviceInstant(raw.recordedAt),
  });
}
function uat(value: unknown): KdsUatRun | null {
  if (value === null) return null;
  const raw = exact(value, [
    "runReference",
    "runNumber",
    "profileVersionReference",
    "deviceReference",
    "stationReference",
    "checklistVersionCode",
    "browserVersionCode",
    "logicalWidth",
    "logicalHeight",
    "status",
    "dueAt",
    "startedAt",
    "completedAt",
    "evidenceReference",
    "checks",
  ]);
  if (!Array.isArray(raw.checks) || raw.checks.length > kdsUatCheckCodes.length) return fail();
  const checks = Object.freeze(raw.checks.map(check));
  if (new Set(checks.map((item) => item.checkCode)).size !== checks.length) return fail();
  const status = oneOf(raw.status, [
    "NotRun",
    "InProgress",
    "Blocked",
    "Failed",
    "Passed",
  ] as const);
  const startedAt = nullableInstant(raw.startedAt);
  const completedAt = nullableInstant(raw.completedAt);
  const evidenceReference = nullableReference(raw.evidenceReference);
  if (
    (status === "NotRun") !== (startedAt === null) ||
    ["Blocked", "Failed", "Passed"].includes(status) !== (completedAt !== null) ||
    (status === "Passed") !== (evidenceReference !== null)
  )
    return fail();
  if (
    status === "Passed" &&
    (checks.length !== kdsUatCheckCodes.length || checks.some((item) => item.outcome !== "Passed"))
  )
    return fail();
  return Object.freeze({
    runReference: parseDeviceReference(raw.runReference),
    runNumber: positive(raw.runNumber),
    profileVersionReference: parseDeviceReference(raw.profileVersionReference),
    deviceReference: parseDeviceReference(raw.deviceReference),
    stationReference: parseDeviceReference(raw.stationReference),
    checklistVersionCode: parseDeviceCode(raw.checklistVersionCode),
    browserVersionCode: parseDeviceCode(raw.browserVersionCode),
    logicalWidth: positive(raw.logicalWidth),
    logicalHeight: positive(raw.logicalHeight),
    status,
    dueAt: parseDeviceInstant(raw.dueAt),
    startedAt,
    completedAt,
    evidenceReference,
    checks,
  });
}
export function createKdsProfileRecord(value: unknown): KdsProfileRecord {
  const raw = exact(value, [
    "profileReference",
    "revision",
    "scope",
    "lifecycle",
    "currentVersion",
    "assignment",
    "currentUat",
    "createdByReference",
    "createdAt",
    "updatedAt",
  ]);
  const scopeRaw = exact(raw.scope, ["tenantReference", "brandReference", "storeReference"]);
  const currentVersion = version(raw.currentVersion);
  const currentAssignment = assignment(raw.assignment);
  const currentUat = uat(raw.currentUat);
  const profile = Object.freeze({
    profileReference: parseDeviceReference(raw.profileReference),
    revision: positive(raw.revision),
    scope: Object.freeze({
      tenantReference: parseDeviceReference(scopeRaw.tenantReference),
      brandReference: parseDeviceReference(scopeRaw.brandReference),
      storeReference: parseDeviceReference(scopeRaw.storeReference),
    }),
    lifecycle: oneOf(raw.lifecycle, ["Draft", "Published", "Revoked"] as const),
    currentVersion,
    assignment: currentAssignment,
    currentUat,
    createdByReference: parseDeviceReference(raw.createdByReference),
    createdAt: parseDeviceInstant(raw.createdAt),
    updatedAt: parseDeviceInstant(raw.updatedAt),
  });
  if (
    Date.parse(profile.updatedAt) < Date.parse(profile.createdAt) ||
    profile.currentVersion.createdAt > profile.updatedAt ||
    (currentUat !== null &&
      (currentAssignment === null ||
        currentUat.profileVersionReference !== currentVersion.versionReference ||
        currentUat.deviceReference !== currentAssignment.deviceReference ||
        currentUat.stationReference !== currentAssignment.stationReference ||
        currentUat.checklistVersionCode !== currentVersion.checklistVersionCode ||
        currentUat.logicalWidth < currentVersion.minimumLogicalWidth ||
        currentUat.logicalHeight < currentVersion.minimumLogicalHeight)) ||
    (profile.lifecycle === "Published" && currentUat?.status !== "Passed")
  )
    return fail();
  return profile;
}
