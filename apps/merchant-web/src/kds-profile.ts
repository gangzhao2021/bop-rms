export interface KdsProfileView {
  readonly screenId: "DEV-KDS-PROFILE";
  readonly queryName: "kds_profile_management_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly sourceAsOf: string;
  readonly freshness: "Current" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly profileReference: string;
  readonly profileVersionReference: string;
  readonly profileVersion: number;
  readonly profileLabelCode: string;
  readonly storeReference: string;
  readonly storeLabel: string;
  readonly stationReference: string | null;
  readonly stationLabel: string | null;
  readonly lifecycle: "Draft" | "Published" | "Revoked";
  readonly browserFamily: "ChromiumManaged";
  readonly minimumLogicalWidth: number;
  readonly minimumLogicalHeight: number;
  readonly wakePolicyCode: string;
  readonly powerPolicyCode: string;
  readonly autoLockSeconds: number;
  readonly visibilityLossLocks: true;
  readonly handoverPolicy: "LockThenRotateNamedSession";
  readonly notificationMode: "VisualAndAudible" | "VisualOnly";
  readonly networkProcedureCode: "KDS-NETWORK-RECOVERY-V1";
  readonly replacementProcedureCode: "KDS-REPLACEMENT-V1";
  readonly assignmentReference: string | null;
  readonly assignedDeviceReference: string | null;
  readonly operatorSessionStatus: "SignedOut" | "NamedLocked" | "NamedActive" | "HandoverRequired";
  readonly uat: {
    readonly runReference: string | null;
    readonly checklistVersionCode: string;
    readonly browserVersionCode: string | null;
    readonly logicalWidth: number | null;
    readonly logicalHeight: number | null;
    readonly status: "NotRun" | "InProgress" | "Blocked" | "Failed" | "Passed";
    readonly dueAt: string;
    readonly completedAt: string | null;
    readonly evidenceReference: string | null;
    readonly checks: readonly {
      readonly checkCode:
        | "ACCESSIBILITY"
        | "AUTO_LOCK"
        | "MANAGED_BROWSER"
        | "NAMED_SESSION_HANDOVER"
        | "NETWORK_LOSS"
        | "NOTIFICATION"
        | "REPLACEMENT"
        | "RESOLUTION"
        | "VISIBILITY_LOCK"
        | "WAKE_POWER";
      readonly outcome: "Passed" | "Failed" | "Blocked" | "NotRun";
      readonly safeResultCode: string | null;
    }[];
  };
  readonly filters: {
    readonly storeReference: string | null;
    readonly stationReference: string | null;
    readonly lifecycle: "Draft" | "Published" | "Revoked" | null;
    readonly uatDue: "All" | "Due" | "Overdue";
  };
  readonly permissions: {
    readonly mayCreate: boolean;
    readonly mayAssign: boolean;
    readonly mayRunUat: boolean;
    readonly mayPublish: boolean;
    readonly mayRevoke: boolean;
  };
}
export interface KdsProfileClient {
  loadProfile(): Promise<unknown>;
}
export class KdsProfileClientError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "FeatureDisabled"
      | "Offline"
      | "Stale"
      | "Conflict"
      | "CommandFailed"
      | "Unavailable",
  ) {
    super("KDS Profile is unavailable");
    this.name = "KdsProfileClientError";
  }
}
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE = /^[^\p{Cc}\p{Cf}]{1,100}$/u;
const CODE = /^[A-Z0-9][A-Z0-9_.:-]{0,63}$/u;
const fail = (): never => {
  throw new Error("KDS_PROFILE_INVALID");
};
function closed(value: unknown, keys: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return fail();
  return value as Record<string, unknown>;
}
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail();
const ref = (value: unknown) => (typeof value === "string" && UUID_V7.test(value) ? value : fail());
const nullableRef = (value: unknown) => (value === null ? null : ref(value));
const code = (value: unknown) => (typeof value === "string" && CODE.test(value) ? value : fail());
const nullableCode = (value: unknown) => (value === null ? null : code(value));
const instant = (value: unknown) =>
  typeof value === "string" &&
  INSTANT.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail();
const nullableInstant = (value: unknown) => (value === null ? null : instant(value));
const bool = (value: unknown) => (typeof value === "boolean" ? value : fail());
const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fail();
const checkCodes = [
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
function check(value: unknown): KdsProfileView["uat"]["checks"][number] {
  const raw = closed(value, ["checkCode", "outcome", "safeResultCode"]);
  const outcome = oneOf(raw.outcome, ["Passed", "Failed", "Blocked", "NotRun"] as const);
  const safeResultCode = nullableCode(raw.safeResultCode);
  if ((outcome === "NotRun") !== (safeResultCode === null)) return fail();
  return Object.freeze({ checkCode: oneOf(raw.checkCode, checkCodes), outcome, safeResultCode });
}
export function parseKdsProfileView(value: unknown): KdsProfileView {
  const input = closed(value, [
    "screenId",
    "queryName",
    "queryVersion",
    "generatedAt",
    "sourceAsOf",
    "freshness",
    "completeness",
    "profileReference",
    "profileVersionReference",
    "profileVersion",
    "profileLabelCode",
    "storeReference",
    "storeLabel",
    "stationReference",
    "stationLabel",
    "lifecycle",
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
    "assignmentReference",
    "assignedDeviceReference",
    "operatorSessionStatus",
    "uat",
    "filters",
    "permissions",
  ]);
  const uatRaw = closed(input.uat, [
    "runReference",
    "checklistVersionCode",
    "browserVersionCode",
    "logicalWidth",
    "logicalHeight",
    "status",
    "dueAt",
    "completedAt",
    "evidenceReference",
    "checks",
  ]);
  if (!Array.isArray(uatRaw.checks) || uatRaw.checks.length !== checkCodes.length) return fail();
  const checks = Object.freeze(uatRaw.checks.map(check));
  if (new Set(checks.map((item) => item.checkCode)).size !== checks.length) return fail();
  const uatStatus = oneOf(uatRaw.status, [
    "NotRun",
    "InProgress",
    "Blocked",
    "Failed",
    "Passed",
  ] as const);
  const evidenceReference = nullableRef(uatRaw.evidenceReference);
  const completedAt = nullableInstant(uatRaw.completedAt);
  const runReference = nullableRef(uatRaw.runReference);
  const browserVersionCode = nullableCode(uatRaw.browserVersionCode);
  const logicalWidth = uatRaw.logicalWidth === null ? null : positive(uatRaw.logicalWidth);
  const logicalHeight = uatRaw.logicalHeight === null ? null : positive(uatRaw.logicalHeight);
  if (
    (uatStatus === "NotRun") !== (runReference === null) ||
    (uatStatus === "NotRun") !== (browserVersionCode === null) ||
    (uatStatus === "Passed") !== (evidenceReference !== null) ||
    ["Blocked", "Failed", "Passed"].includes(uatStatus) !== (completedAt !== null) ||
    (uatStatus === "Passed" && checks.some((item) => item.outcome !== "Passed"))
  )
    return fail();
  const assignmentReference = nullableRef(input.assignmentReference);
  const assignedDeviceReference = nullableRef(input.assignedDeviceReference);
  const stationReference = nullableRef(input.stationReference);
  const stationLabel =
    input.stationLabel === null
      ? null
      : typeof input.stationLabel === "string" && SAFE.test(input.stationLabel)
        ? input.stationLabel
        : fail();
  if (
    (assignmentReference === null) !== (assignedDeviceReference === null) ||
    (assignmentReference === null) !== (stationReference === null) ||
    (stationReference === null) !== (stationLabel === null)
  )
    return fail();
  const minimumLogicalWidth = positive(input.minimumLogicalWidth);
  const minimumLogicalHeight = positive(input.minimumLogicalHeight);
  const autoLockSeconds = positive(input.autoLockSeconds);
  if (
    minimumLogicalWidth < 1024 ||
    minimumLogicalHeight < 768 ||
    autoLockSeconds < 60 ||
    autoLockSeconds > 900 ||
    input.visibilityLossLocks !== true
  )
    return fail();
  const filters = closed(input.filters, [
    "storeReference",
    "stationReference",
    "lifecycle",
    "uatDue",
  ]);
  const permissions = closed(input.permissions, [
    "mayCreate",
    "mayAssign",
    "mayRunUat",
    "mayPublish",
    "mayRevoke",
  ]);
  return Object.freeze({
    screenId: oneOf(input.screenId, ["DEV-KDS-PROFILE"] as const),
    queryName: oneOf(input.queryName, ["kds_profile_management_v1"] as const),
    queryVersion: input.queryVersion === 1 ? 1 : fail(),
    generatedAt: instant(input.generatedAt),
    sourceAsOf: instant(input.sourceAsOf),
    freshness: oneOf(input.freshness, ["Current", "Stale"] as const),
    completeness: oneOf(input.completeness, ["Complete", "Partial"] as const),
    profileReference: ref(input.profileReference),
    profileVersionReference: ref(input.profileVersionReference),
    profileVersion: positive(input.profileVersion),
    profileLabelCode: code(input.profileLabelCode),
    storeReference: ref(input.storeReference),
    storeLabel:
      typeof input.storeLabel === "string" && SAFE.test(input.storeLabel)
        ? input.storeLabel
        : fail(),
    stationReference,
    stationLabel,
    lifecycle: oneOf(input.lifecycle, ["Draft", "Published", "Revoked"] as const),
    browserFamily: oneOf(input.browserFamily, ["ChromiumManaged"] as const),
    minimumLogicalWidth,
    minimumLogicalHeight,
    wakePolicyCode: code(input.wakePolicyCode),
    powerPolicyCode: code(input.powerPolicyCode),
    autoLockSeconds,
    visibilityLossLocks: true,
    handoverPolicy: oneOf(input.handoverPolicy, ["LockThenRotateNamedSession"] as const),
    notificationMode: oneOf(input.notificationMode, ["VisualAndAudible", "VisualOnly"] as const),
    networkProcedureCode: oneOf(input.networkProcedureCode, ["KDS-NETWORK-RECOVERY-V1"] as const),
    replacementProcedureCode: oneOf(input.replacementProcedureCode, [
      "KDS-REPLACEMENT-V1",
    ] as const),
    assignmentReference,
    assignedDeviceReference,
    operatorSessionStatus: oneOf(input.operatorSessionStatus, [
      "SignedOut",
      "NamedLocked",
      "NamedActive",
      "HandoverRequired",
    ] as const),
    uat: Object.freeze({
      runReference,
      checklistVersionCode: code(uatRaw.checklistVersionCode),
      browserVersionCode,
      logicalWidth,
      logicalHeight,
      status: uatStatus,
      dueAt: instant(uatRaw.dueAt),
      completedAt,
      evidenceReference,
      checks,
    }),
    filters: Object.freeze({
      storeReference: nullableRef(filters.storeReference),
      stationReference: nullableRef(filters.stationReference),
      lifecycle:
        filters.lifecycle === null
          ? null
          : oneOf(filters.lifecycle, ["Draft", "Published", "Revoked"] as const),
      uatDue: oneOf(filters.uatDue, ["All", "Due", "Overdue"] as const),
    }),
    permissions: Object.freeze({
      mayCreate: bool(permissions.mayCreate),
      mayAssign: bool(permissions.mayAssign),
      mayRunUat: bool(permissions.mayRunUat),
      mayPublish: bool(permissions.mayPublish),
      mayRevoke: bool(permissions.mayRevoke),
    }),
  });
}
export const unavailableKdsProfileClient: KdsProfileClient = Object.freeze({
  loadProfile: () => Promise.reject(new KdsProfileClientError("Unavailable")),
});
