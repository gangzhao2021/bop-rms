export const STORE_SETUP_STEPS = [
  "Identity",
  "AddressTimezone",
  "ServiceModes",
  "Hours",
  "TaxPaymentReferences",
  "Capacity",
  "Contacts",
  "Review",
] as const;
export type StoreSetupStep = (typeof STORE_SETUP_STEPS)[number];

export interface StoreListItem {
  readonly storeReference: string;
  readonly code: string;
  readonly name: string;
  readonly lifecycle: "Draft" | "Active" | "Suspended" | "Archived";
  readonly timeZone: string;
  readonly addressSummary: string;
  readonly serviceModes: readonly ("DineIn" | "Pickup" | "Delivery")[];
  readonly todayHours: "Open" | "Closed" | "TemporarilyClosed" | "Unavailable";
  readonly liveGate: "Blocked" | "Ready" | "Unavailable";
  readonly configurationSource: "Store" | "BrandInherited" | "Unavailable";
  readonly version: number;
}

export interface StoreListView {
  readonly screenId: "STORE-LIST";
  readonly projection: ProjectionState;
  readonly items: readonly StoreListItem[];
}

export interface ProjectionState {
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Partial";
}

export interface StoreDetailView {
  readonly screenId: "STORE-DETAIL";
  readonly storeReference: string;
  readonly name: string;
  readonly lifecycle: StoreListItem["lifecycle"];
  readonly version: number;
  readonly projection: ProjectionState;
  readonly sections: Readonly<
    Record<
      | "Summary"
      | "Hours"
      | "ServiceModes"
      | "Capacity"
      | "Payments"
      | "Tax"
      | "Devices"
      | "People"
      | "Evidence"
      | "History",
      "Configured" | "Incomplete" | "Unavailable"
    >
  >;
}

export interface StoreSetupView {
  readonly screenId: "STORE-SETUP";
  readonly storeReference: string;
  readonly name: string;
  readonly version: number;
  readonly projection: ProjectionState;
  readonly evidenceGate: "Required" | "Satisfied";
  readonly steps: readonly {
    readonly step: StoreSetupStep;
    readonly status: "NotStarted" | "InProgress" | "Valid" | "Blocked";
  }[];
}

export interface StoreHoursServiceView {
  readonly screenId: "STORE-HOURS-SERVICE";
  readonly storeReference: string;
  readonly name: string;
  readonly version: number;
  readonly projection: ProjectionState;
  readonly configurationSource: "StoreOverride" | "BrandInherited";
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly businessDayStartLocalTime: string;
  readonly enabledServiceModes: readonly ("DineIn" | "Pickup" | "Delivery")[];
  readonly weeklyDays: readonly {
    readonly isoWeekday: 1 | 2 | 3 | 4 | 5 | 6 | 7;
    readonly hoursSummary: string;
  }[];
  readonly exceptionCount: number;
  readonly pauseState: "Running" | "Paused" | "Unavailable";
  readonly canManageService: boolean;
}

export interface StoreAdminClient {
  listStores(): Promise<unknown>;
  loadStore(storeReference: string): Promise<unknown>;
  loadSetup(storeReference: string): Promise<unknown>;
  loadHoursService(storeReference: string): Promise<unknown>;
}

export type StoreAdminClientErrorCode =
  "PermissionDenied" | "NotFound" | "Offline" | "Conflict" | "CommandFailed" | "Unavailable";

export class StoreAdminClientError extends Error {
  readonly code: StoreAdminClientErrorCode;

  constructor(code: StoreAdminClientErrorCode) {
    super("Store administration is unavailable");
    this.name = "StoreAdminClientError";
    this.code = code;
  }
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_TEXT = /^[^\p{Cc}\p{Cf}]{1,180}$/u;
const CODE = /^[A-Z][A-Z0-9_-]{0,62}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function closed(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("STORE_ADMIN_INVALID");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("STORE_ADMIN_INVALID");
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !UUID_V7.test(value)) throw new Error("STORE_ADMIN_INVALID");
  return value;
}

export function parseStoreRouteReference(value: unknown): string {
  return reference(value);
}

function text(value: unknown, code = false): string {
  if (typeof value !== "string" || !(code ? CODE : SAFE_TEXT).test(value))
    throw new Error("STORE_ADMIN_INVALID");
  return value;
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("STORE_ADMIN_INVALID");
  return value as number;
}

function projection(value: unknown): ProjectionState {
  const input = closed(value, ["asOfUtc", "freshness"]);
  if (
    typeof input.asOfUtc !== "string" ||
    !INSTANT.test(input.asOfUtc) ||
    new Date(Date.parse(input.asOfUtc)).toISOString() !== input.asOfUtc ||
    !["Current", "Stale", "Partial"].includes(String(input.freshness))
  )
    throw new Error("STORE_ADMIN_INVALID");
  return Object.freeze({
    asOfUtc: input.asOfUtc,
    freshness: input.freshness as ProjectionState["freshness"],
  });
}

const serviceModeOrder = ["DineIn", "Pickup", "Delivery"] as const;
function listItem(value: unknown): StoreListItem {
  const input = closed(value, [
    "storeReference",
    "code",
    "name",
    "lifecycle",
    "timeZone",
    "addressSummary",
    "serviceModes",
    "todayHours",
    "liveGate",
    "configurationSource",
    "version",
  ]);
  const serviceModes = Array.isArray(input.serviceModes) ? input.serviceModes : null;
  if (
    !["Draft", "Active", "Suspended", "Archived"].includes(String(input.lifecycle)) ||
    typeof input.timeZone !== "string" ||
    input.timeZone.length > 64 ||
    serviceModes === null ||
    serviceModes.some((mode) => !serviceModeOrder.includes(mode as never)) ||
    new Set(serviceModes).size !== serviceModes.length ||
    !["Open", "Closed", "TemporarilyClosed", "Unavailable"].includes(String(input.todayHours)) ||
    !["Blocked", "Ready", "Unavailable"].includes(String(input.liveGate)) ||
    !["Store", "BrandInherited", "Unavailable"].includes(String(input.configurationSource))
  )
    throw new Error("STORE_ADMIN_INVALID");
  return Object.freeze({
    storeReference: reference(input.storeReference),
    code: text(input.code, true),
    name: text(input.name),
    lifecycle: input.lifecycle as StoreListItem["lifecycle"],
    timeZone: text(input.timeZone),
    addressSummary: text(input.addressSummary),
    serviceModes: Object.freeze(serviceModeOrder.filter((mode) => serviceModes.includes(mode))),
    todayHours: input.todayHours as StoreListItem["todayHours"],
    liveGate: input.liveGate as StoreListItem["liveGate"],
    configurationSource: input.configurationSource as StoreListItem["configurationSource"],
    version: version(input.version),
  });
}

export function parseStoreListView(value: unknown): StoreListView {
  const input = closed(value, ["screenId", "projection", "items"]);
  if (input.screenId !== "STORE-LIST" || !Array.isArray(input.items) || input.items.length > 100)
    throw new Error("STORE_ADMIN_INVALID");
  const items = Object.freeze(input.items.map(listItem));
  if (new Set(items.map((item) => item.storeReference)).size !== items.length)
    throw new Error("STORE_ADMIN_INVALID");
  return Object.freeze({ screenId: "STORE-LIST", projection: projection(input.projection), items });
}

const sectionNames = [
  "Summary",
  "Hours",
  "ServiceModes",
  "Capacity",
  "Payments",
  "Tax",
  "Devices",
  "People",
  "Evidence",
  "History",
] as const;

export function parseStoreDetailView(value: unknown): StoreDetailView {
  const input = closed(value, [
    "screenId",
    "storeReference",
    "name",
    "lifecycle",
    "version",
    "projection",
    "sections",
  ]);
  if (input.screenId !== "STORE-DETAIL") throw new Error("STORE_ADMIN_INVALID");
  const sections = closed(input.sections, sectionNames);
  if (
    !["Draft", "Active", "Suspended", "Archived"].includes(String(input.lifecycle)) ||
    sectionNames.some(
      (name) => !["Configured", "Incomplete", "Unavailable"].includes(String(sections[name])),
    )
  )
    throw new Error("STORE_ADMIN_INVALID");
  return Object.freeze({
    screenId: "STORE-DETAIL",
    storeReference: reference(input.storeReference),
    name: text(input.name),
    lifecycle: input.lifecycle as StoreDetailView["lifecycle"],
    version: version(input.version),
    projection: projection(input.projection),
    sections: Object.freeze(
      Object.fromEntries(sectionNames.map((name) => [name, sections[name]])),
    ) as StoreDetailView["sections"],
  });
}

export function parseStoreSetupView(value: unknown): StoreSetupView {
  const input = closed(value, [
    "screenId",
    "storeReference",
    "name",
    "version",
    "projection",
    "evidenceGate",
    "steps",
  ]);
  if (
    input.screenId !== "STORE-SETUP" ||
    (input.evidenceGate !== "Required" && input.evidenceGate !== "Satisfied") ||
    !Array.isArray(input.steps) ||
    input.steps.length !== STORE_SETUP_STEPS.length
  )
    throw new Error("STORE_ADMIN_INVALID");
  const steps = Object.freeze(
    input.steps.map((value, index) => {
      const step = closed(value, ["step", "status"]);
      if (
        step.step !== STORE_SETUP_STEPS[index] ||
        !["NotStarted", "InProgress", "Valid", "Blocked"].includes(String(step.status))
      )
        throw new Error("STORE_ADMIN_INVALID");
      return Object.freeze({
        step: step.step as StoreSetupStep,
        status: step.status as StoreSetupView["steps"][number]["status"],
      });
    }),
  );
  return Object.freeze({
    screenId: "STORE-SETUP",
    storeReference: reference(input.storeReference),
    name: text(input.name),
    version: version(input.version),
    projection: projection(input.projection),
    evidenceGate: input.evidenceGate,
    steps,
  });
}

export function parseStoreHoursServiceView(value: unknown): StoreHoursServiceView {
  const input = closed(value, [
    "screenId",
    "storeReference",
    "name",
    "version",
    "projection",
    "configurationSource",
    "effectiveFrom",
    "effectiveUntil",
    "businessDayStartLocalTime",
    "enabledServiceModes",
    "weeklyDays",
    "exceptionCount",
    "pauseState",
    "canManageService",
  ]);
  if (
    input.screenId !== "STORE-HOURS-SERVICE" ||
    !["StoreOverride", "BrandInherited"].includes(String(input.configurationSource)) ||
    typeof input.effectiveFrom !== "string" ||
    !INSTANT.test(input.effectiveFrom) ||
    (input.effectiveUntil !== null &&
      (typeof input.effectiveUntil !== "string" || !INSTANT.test(input.effectiveUntil))) ||
    typeof input.businessDayStartLocalTime !== "string" ||
    !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u.test(input.businessDayStartLocalTime) ||
    !Array.isArray(input.enabledServiceModes) ||
    input.enabledServiceModes.some((mode) => !serviceModeOrder.includes(mode as never)) ||
    new Set(input.enabledServiceModes).size !== input.enabledServiceModes.length ||
    !Array.isArray(input.weeklyDays) ||
    input.weeklyDays.length !== 7 ||
    typeof input.exceptionCount !== "number" ||
    !Number.isSafeInteger(input.exceptionCount) ||
    input.exceptionCount < 0 ||
    !["Running", "Paused", "Unavailable"].includes(String(input.pauseState)) ||
    typeof input.canManageService !== "boolean"
  )
    throw new Error("STORE_ADMIN_INVALID");
  const enabledServiceModes = input.enabledServiceModes as readonly unknown[];
  const weeklyDays = Object.freeze(
    input.weeklyDays.map((value, index) => {
      const day = closed(value, ["isoWeekday", "hoursSummary"]);
      if (day.isoWeekday !== index + 1) throw new Error("STORE_ADMIN_INVALID");
      return Object.freeze({
        isoWeekday: day.isoWeekday as StoreHoursServiceView["weeklyDays"][number]["isoWeekday"],
        hoursSummary: text(day.hoursSummary),
      });
    }),
  );
  return Object.freeze({
    screenId: "STORE-HOURS-SERVICE",
    storeReference: reference(input.storeReference),
    name: text(input.name),
    version: version(input.version),
    projection: projection(input.projection),
    configurationSource: input.configurationSource as StoreHoursServiceView["configurationSource"],
    effectiveFrom: input.effectiveFrom,
    effectiveUntil: input.effectiveUntil as string | null,
    businessDayStartLocalTime: input.businessDayStartLocalTime,
    enabledServiceModes: Object.freeze(
      serviceModeOrder.filter((mode) => enabledServiceModes.includes(mode)),
    ),
    weeklyDays,
    exceptionCount: input.exceptionCount,
    pauseState: input.pauseState as StoreHoursServiceView["pauseState"],
    canManageService: input.canManageService,
  });
}

export const unavailableStoreAdminClient: StoreAdminClient = Object.freeze({
  async listStores() {
    throw new StoreAdminClientError("Unavailable");
  },
  async loadStore() {
    throw new StoreAdminClientError("Unavailable");
  },
  async loadSetup() {
    throw new StoreAdminClientError("Unavailable");
  },
  async loadHoursService() {
    throw new StoreAdminClientError("Unavailable");
  },
});
