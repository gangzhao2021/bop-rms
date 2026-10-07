import { parseStoreSetupFeeContexts } from "./store-setup-client.js";
import {
  parseServiceIntervals,
  type ServiceMode,
  type ServiceInterval,
} from "./service-control-client.js";
export type StoreConfigurationFeeContext =
  | Readonly<{ chargeType: "ServiceCharge" | "DeliveryFee" | "Tip"; state: "Disabled" }>
  | Readonly<{
      chargeType: "ServiceCharge" | "DeliveryFee" | "Tip";
      state: "Enabled";
      taxClassificationReference: string;
      orderTypes: readonly ServiceMode[];
    }>;
export interface StoreSetupConfigurationBasis {
  readonly profile: "StoreSetupConfigurationBasisV2";
  readonly tenantReference: string;
  readonly setupDraftReference: string;
  readonly sourceRevision: number;
  readonly sourceSnapshotDigest: string;
  readonly feeContexts: readonly StoreConfigurationFeeContext[];
}
export interface StoreConfigurationSnapshot {
  readonly setupBasis?: StoreSetupConfigurationBasis;
  readonly configurationReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly configurationVersion: number;
  readonly lifecycle:
    "Draft" | "PendingApproval" | "Approved" | "Published" | "Superseded" | "Archived";
  readonly source: "BrandInherited" | "StoreOverride";
  readonly brandBaseVersionReference: string;
  readonly defaultLocale: string;
  readonly currencyCode: "CAD";
  readonly timeZone: string;
  readonly businessDayStartLocalTime: string;
  readonly addressReference: string;
  readonly contactReference: string;
  readonly receiptReference: string;
  readonly taxConfigurationReference: string;
  readonly paymentConfigurationReference: string;
  readonly capacityConfigurationReference: string | null;
  readonly enabledServiceModes: readonly ServiceMode[];
  readonly weeklySchedule: readonly {
    readonly isoWeekday: number;
    readonly intervals: readonly ServiceInterval[];
  }[];
  readonly exceptions: readonly {
    readonly localDate: string;
    readonly kind: "Holiday" | "TemporaryClosure" | "Override";
    readonly intervals: readonly ServiceInterval[];
  }[];
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly supersedesConfigurationReference: string | null;
  readonly reasonCode: string;
  readonly authoredByReference: string;
  readonly approvedByReference: string | null;
  readonly approvalEvidenceReference: string | null;
  readonly publicationReference: string | null;
  readonly liveGateEvidenceReference: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dataClassification: "ConfigurationMetadata";
}

const invalid = (): never => {
  throw new Error("Configuration response unavailable.");
};
const reference = (v: unknown) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v);
function exact(raw: unknown, fields: readonly string[]) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Object.getPrototypeOf(raw) !== Object.prototype ||
    Reflect.ownKeys(raw).length !== fields.length
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (
    fields.some((key) => {
      const d = descriptors[key];
      return !d || !d.enumerable || !("value" in d);
    })
  )
    return invalid();
  return raw as Record<string, unknown>;
}
function instant(v: unknown): string {
  if (typeof v !== "string" || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v)
    return invalid();
  return v;
}
export function parseStoreSetupConfigurationBasis(raw: unknown): StoreSetupConfigurationBasis {
  const v = exact(raw, [
    "profile",
    "tenantReference",
    "setupDraftReference",
    "sourceRevision",
    "sourceSnapshotDigest",
    "feeContexts",
  ]);
  if (
    v.profile !== "StoreSetupConfigurationBasisV2" ||
    typeof v.tenantReference !== "string" ||
    !reference(v.tenantReference) ||
    typeof v.setupDraftReference !== "string" ||
    !reference(v.setupDraftReference) ||
    typeof v.sourceRevision !== "number" ||
    !Number.isSafeInteger(v.sourceRevision) ||
    v.sourceRevision < 1 ||
    v.sourceRevision > 2147483647 ||
    typeof v.sourceSnapshotDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(v.sourceSnapshotDigest)
  )
    return invalid();
  let fees: ReturnType<typeof parseStoreSetupFeeContexts>;
  try {
    fees = parseStoreSetupFeeContexts(v.feeContexts);
  } catch {
    return invalid();
  }
  const feeContexts = Object.freeze(
    fees.map((entry): StoreConfigurationFeeContext => {
      if (entry.state === "Unconfigured") return invalid();
      if (entry.state === "Disabled")
        return Object.freeze({ chargeType: entry.chargeType, state: "Disabled" });
      if (entry.state !== "Enabled") return invalid();
      return Object.freeze({
        chargeType: entry.chargeType,
        state: "Enabled",
        taxClassificationReference: entry.taxClassificationReference,
        orderTypes: entry.orderTypes,
      });
    }),
  );
  return Object.freeze({
    profile: "StoreSetupConfigurationBasisV2",
    tenantReference: v.tenantReference,
    setupDraftReference: v.setupDraftReference,
    sourceRevision: v.sourceRevision,
    sourceSnapshotDigest: v.sourceSnapshotDigest,
    feeContexts,
  });
}
export function parseStoreConfigurationSnapshot(
  raw: unknown,
  store: string,
): StoreConfigurationSnapshot {
  const hasBasis = raw !== null && typeof raw === "object" && Object.hasOwn(raw, "setupBasis");
  const v = exact(raw, [
    ...(hasBasis ? ["setupBasis"] : []),
    "configurationReference",
    "brandReference",
    "storeReference",
    "configurationVersion",
    "lifecycle",
    "source",
    "brandBaseVersionReference",
    "defaultLocale",
    "currencyCode",
    "timeZone",
    "businessDayStartLocalTime",
    "addressReference",
    "contactReference",
    "receiptReference",
    "taxConfigurationReference",
    "paymentConfigurationReference",
    "capacityConfigurationReference",
    "enabledServiceModes",
    "weeklySchedule",
    "exceptions",
    "effectiveFrom",
    "effectiveUntil",
    "supersedesConfigurationReference",
    "reasonCode",
    "authoredByReference",
    "approvedByReference",
    "approvalEvidenceReference",
    "publicationReference",
    "liveGateEvidenceReference",
    "createdAt",
    "updatedAt",
    "dataClassification",
  ]);
  for (const key of [
    "configurationReference",
    "brandReference",
    "storeReference",
    "brandBaseVersionReference",
    "addressReference",
    "contactReference",
    "receiptReference",
    "taxConfigurationReference",
    "paymentConfigurationReference",
    "authoredByReference",
  ])
    if (!reference(v[key])) return invalid();
  for (const key of [
    "capacityConfigurationReference",
    "supersedesConfigurationReference",
    "approvedByReference",
    "approvalEvidenceReference",
    "publicationReference",
    "liveGateEvidenceReference",
  ])
    if (v[key] !== null && !reference(v[key])) return invalid();
  if (
    v.storeReference !== store ||
    typeof v.configurationVersion !== "number" ||
    !Number.isSafeInteger(v.configurationVersion) ||
    v.configurationVersion < 1 ||
    !["Draft", "PendingApproval", "Approved", "Published", "Superseded", "Archived"].includes(
      String(v.lifecycle),
    ) ||
    !["BrandInherited", "StoreOverride"].includes(String(v.source)) ||
    v.currencyCode !== "CAD" ||
    v.dataClassification !== "ConfigurationMetadata" ||
    typeof v.defaultLocale !== "string" ||
    !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(v.defaultLocale) ||
    typeof v.reasonCode !== "string" ||
    !/^[A-Z][A-Z0-9_.:-]{0,63}$/u.test(v.reasonCode) ||
    typeof v.businessDayStartLocalTime !== "string" ||
    !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/u.test(v.businessDayStartLocalTime)
  )
    return invalid();
  if (typeof v.timeZone !== "string") return invalid();
  try {
    if (
      new Intl.DateTimeFormat("en", { timeZone: v.timeZone }).resolvedOptions().timeZone !==
      v.timeZone
    )
      return invalid();
  } catch {
    return invalid();
  }
  const from = instant(v.effectiveFrom),
    created = instant(v.createdAt),
    updated = instant(v.updatedAt);
  if (updated < created || (v.effectiveUntil !== null && instant(v.effectiveUntil) <= from))
    return invalid();
  if (
    !Array.isArray(v.enabledServiceModes) ||
    v.enabledServiceModes.length < 1 ||
    v.enabledServiceModes.length > 3 ||
    new Set(v.enabledServiceModes).size !== v.enabledServiceModes.length ||
    v.enabledServiceModes.some((mode) => !["DineIn", "Pickup", "Delivery"].includes(mode))
  )
    return invalid();
  if (
    !Array.isArray(v.weeklySchedule) ||
    v.weeklySchedule.length !== 7 ||
    !Array.isArray(v.exceptions) ||
    v.exceptions.length > 366
  )
    return invalid();
  const setupBasis = hasBasis ? parseStoreSetupConfigurationBasis(v.setupBasis) : undefined;
  if (
    setupBasis &&
    setupBasis.feeContexts.some(
      (entry) =>
        entry.state === "Enabled" &&
        entry.orderTypes.some(
          (mode) => !Array.isArray(v.enabledServiceModes) || !v.enabledServiceModes.includes(mode),
        ),
    )
  )
    return invalid();
  const weeklySchedule = v.weeklySchedule.map((day, index) => {
    const d = exact(day, ["isoWeekday", "intervals"]);
    if (d.isoWeekday !== index + 1) return invalid();
    return Object.freeze({ isoWeekday: index + 1, intervals: parseServiceIntervals(d.intervals) });
  });
  const dates = new Set<string>();
  const exceptions = v.exceptions.map((rawException) => {
    const e = exact(rawException, ["localDate", "kind", "intervals"]);
    if (
      typeof e.localDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(e.localDate) ||
      !Number.isFinite(Date.parse(e.localDate + "T00:00:00.000Z")) ||
      new Date(e.localDate + "T00:00:00.000Z").toISOString().slice(0, 10) !== e.localDate ||
      dates.has(e.localDate) ||
      !["Holiday", "TemporaryClosure", "Override"].includes(String(e.kind))
    )
      return invalid();
    dates.add(e.localDate);
    return Object.freeze({ ...e, intervals: parseServiceIntervals(e.intervals) });
  });
  return Object.freeze({
    ...v,
    ...(setupBasis ? { setupBasis } : {}),
    weeklySchedule: Object.freeze(weeklySchedule),
    exceptions: Object.freeze(exceptions),
  }) as unknown as StoreConfigurationSnapshot;
}
export interface StoreConfigurationView {
  readonly screenId: "STORE-HOURS-SERVICE";
  readonly storeReference: string;
  readonly current: StoreConfigurationSnapshot | null;
  readonly latest: StoreConfigurationSnapshot | null;
  readonly expectedVersion: number;
  readonly observedAt: string;
}
export function parseStoreConfigurationView(raw: unknown, store: string): StoreConfigurationView {
  const v = exact(raw, [
    "screenId",
    "storeReference",
    "current",
    "latest",
    "expectedVersion",
    "observedAt",
  ]);
  if (v.screenId !== "STORE-HOURS-SERVICE" || !reference(store) || v.storeReference !== store)
    return invalid();
  const current = v.current === null ? null : parseStoreConfigurationSnapshot(v.current, store);
  const latest = v.latest === null ? null : parseStoreConfigurationSnapshot(v.latest, store);
  const observedAt = instant(v.observedAt);
  if (
    current &&
    (current.lifecycle !== "Published" ||
      current.effectiveFrom > observedAt ||
      (current.effectiveUntil !== null && current.effectiveUntil <= observedAt))
  )
    return invalid();
  if (
    [current, latest].some(
      (c) => c !== null && (c.createdAt > observedAt || c.updatedAt > observedAt),
    ) ||
    v.expectedVersion !== (latest?.configurationVersion ?? current?.configurationVersion ?? 0)
  )
    return invalid();
  return Object.freeze({
    screenId: "STORE-HOURS-SERVICE",
    storeReference: store,
    current,
    latest,
    expectedVersion: v.expectedVersion as number,
    observedAt,
  });
}

export interface StoreConfigurationCommand {
  readonly command: "SaveDraft" | "Validate" | "Submit" | "Approve" | "Publish";
  readonly operationReference: string;
  readonly auditReference: string;
  readonly expectedVersion: number;
  readonly configuration: StoreConfigurationSnapshot;
}
export function createStoreConfigurationClient(fetcher: typeof fetch = fetch) {
  async function request(signal: AbortSignal, command?: StoreConfigurationCommand, csrf?: string) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, 15000);
    try {
      const response = await fetcher("/merchant/store-configuration", {
        method: command ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(command ? { "Content-Type": "application/json", "X-BOP-CSRF": csrf ?? "" } : {}),
        },
        ...(command ? { body: JSON.stringify(command) } : {}),
      });
      if (response.status === 403)
        throw new Error("Permission denied. Check your session and Store access.");
      if (response.status === 409) throw new Error("Source changed. Refresh before trying again.");
      if (
        !response.ok ||
        response.headers.get("cache-control") !== "no-store" ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      )
        throw new Error("Configuration request unavailable.");
      const text = await response.text();
      if (text.length > 2097152 || controller.signal.aborted)
        throw new Error("Configuration request unavailable.");
      return JSON.parse(text) as unknown;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  return Object.freeze({
    async load(store: string, signal: AbortSignal) {
      return parseStoreConfigurationView(await request(signal), store);
    },
    async execute(command: StoreConfigurationCommand, csrf: string, signal: AbortSignal) {
      const result = exact(await request(signal, command, csrf), ["status", "resultingVersion"]);
      if (
        !["Applied", "AlreadyApplied"].includes(String(result.status)) ||
        result.resultingVersion !==
          command.expectedVersion + (command.command === "SaveDraft" ? 1 : 0)
      )
        throw new Error("Configuration request unavailable.");
    },
  });
}
