export interface KdsProfileView {
  readonly screenId: "DEV-KDS-PROFILE";
  readonly profileReference: string;
  readonly profileLabel: string;
  readonly storeLabel: string;
  readonly stationLabel: string;
  readonly browserFamily: "ChromiumManaged";
  readonly resolution: "1920x1080" | "1366x768" | "1280x800";
  readonly autoLockSeconds: number;
  readonly visibilityLossLocks: true;
  readonly handoverPolicy: "LockThenRotateNamedSession";
  readonly notificationMode: "VisualAndAudible" | "VisualOnly";
  readonly networkProcedureCode: "KDS-NETWORK-RECOVERY-V1";
  readonly replacementProcedureCode: "KDS-REPLACEMENT-V1";
  readonly operatorSessionStatus: "SignedOut" | "NamedLocked" | "NamedActive" | "HandoverRequired";
  readonly uatStatus: "NotRun" | "Blocked" | "Passed";
  readonly uatEvidenceReference: string | null;
  readonly freshnessStatus: "Fresh" | "Stale";
  readonly projectedAt: string;
}
export interface KdsProfileClient {
  loadProfile(): Promise<unknown>;
}
export class KdsProfileClientError extends Error {
  constructor(
    readonly code: "PermissionDenied" | "Offline" | "Conflict" | "CommandFailed" | "Unavailable",
  ) {
    super("KDS Profile is unavailable");
    this.name = "KdsProfileClientError";
  }
}
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE = /^[^\p{Cc}\p{Cf}]{1,100}$/u;
function closed(value: unknown, keys: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("KDS_PROFILE_INVALID");
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("KDS_PROFILE_INVALID");
    output[key] = descriptor.value;
  }
  return output;
}
export function parseKdsProfileView(value: unknown): KdsProfileView {
  const input = closed(value, [
    "screenId",
    "profileReference",
    "profileLabel",
    "storeLabel",
    "stationLabel",
    "browserFamily",
    "resolution",
    "autoLockSeconds",
    "visibilityLossLocks",
    "handoverPolicy",
    "notificationMode",
    "networkProcedureCode",
    "replacementProcedureCode",
    "operatorSessionStatus",
    "uatStatus",
    "uatEvidenceReference",
    "freshnessStatus",
    "projectedAt",
  ]);
  if (
    input.screenId !== "DEV-KDS-PROFILE" ||
    typeof input.profileReference !== "string" ||
    !UUID_V7.test(input.profileReference) ||
    ![input.profileLabel, input.storeLabel, input.stationLabel].every(
      (entry) => typeof entry === "string" && SAFE.test(entry),
    ) ||
    input.browserFamily !== "ChromiumManaged" ||
    !["1920x1080", "1366x768", "1280x800"].includes(String(input.resolution)) ||
    !Number.isSafeInteger(input.autoLockSeconds) ||
    Number(input.autoLockSeconds) < 60 ||
    Number(input.autoLockSeconds) > 900 ||
    input.visibilityLossLocks !== true ||
    input.handoverPolicy !== "LockThenRotateNamedSession" ||
    !["VisualAndAudible", "VisualOnly"].includes(String(input.notificationMode)) ||
    input.networkProcedureCode !== "KDS-NETWORK-RECOVERY-V1" ||
    input.replacementProcedureCode !== "KDS-REPLACEMENT-V1" ||
    !["SignedOut", "NamedLocked", "NamedActive", "HandoverRequired"].includes(
      String(input.operatorSessionStatus),
    ) ||
    !["NotRun", "Blocked", "Passed"].includes(String(input.uatStatus)) ||
    !["Fresh", "Stale"].includes(String(input.freshnessStatus)) ||
    typeof input.projectedAt !== "string" ||
    !INSTANT.test(input.projectedAt) ||
    new Date(input.projectedAt).toISOString() !== input.projectedAt ||
    (input.uatStatus === "Passed") !==
      (typeof input.uatEvidenceReference === "string" && UUID_V7.test(input.uatEvidenceReference))
  )
    throw new Error("KDS_PROFILE_INVALID");
  return Object.freeze(input) as unknown as KdsProfileView;
}
export const unavailableKdsProfileClient: KdsProfileClient = Object.freeze({
  loadProfile: () => Promise.reject(new KdsProfileClientError("Unavailable")),
});
