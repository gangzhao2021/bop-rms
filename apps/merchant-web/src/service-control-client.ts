export type ServiceMode = "DineIn" | "Pickup" | "Delivery";
export interface ServiceInterval {
  startLocalTime: string;
  endLocalTime: string;
  endsNextDay: boolean;
  serviceModes: readonly ServiceMode[];
  orderCutoffSeconds: number;
  leadTimeSeconds: number;
}
export interface ServiceHours {
  configurationSource: "StoreOverride" | "BrandInherited";
  effectiveFrom: string;
  effectiveUntil: string | null;
  businessDayStartLocalTime: string;
  weeklySchedule: readonly { isoWeekday: number; intervals: readonly ServiceInterval[] }[];
  exceptions: readonly { localDate: string; kind: string; intervals: readonly ServiceInterval[] }[];
}
export interface ServiceControlState {
  hours: ServiceHours;
  screenId: "STORE-HOURS-SERVICE";
  storeReference: string;
  configurationReference: string;
  timeZone: string;
  enabledServiceModes: readonly ServiceMode[];
  observedAt: string;
  expectedVersion: number;
  activePauses: readonly {
    closureReference: string;
    effectiveFrom: string;
    effectiveUntil: string;
    serviceModes: readonly ServiceMode[] | null;
  }[];
}
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const modes = ["DineIn", "Pickup", "Delivery"];
function exact(value: unknown, keys: string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some(
      (key) =>
        !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
        !("value" in (Object.getOwnPropertyDescriptor(value, key) ?? {})),
    )
  )
    throw new Error("Service state unavailable.");
  return value as Record<string, unknown>;
}
function ref(value: unknown): string {
  if (typeof value !== "string" || !reference.test(value))
    throw new Error("Service state unavailable.");
  return value;
}
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("Service state unavailable.");
  return value;
}
function serviceModes(value: unknown): readonly ServiceMode[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 3 ||
    new Set(value).size !== value.length ||
    value.some((mode) => !modes.includes(mode))
  )
    throw new Error("Service state unavailable.");
  return Object.freeze([...value]) as readonly ServiceMode[];
}
function localTime(value: unknown): string {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u.test(value))
    throw new Error("Service state unavailable.");
  return value;
}
function intervals(raw: unknown): readonly ServiceInterval[] {
  if (!Array.isArray(raw) || raw.length > 16) throw new Error("Service state unavailable.");
  return Object.freeze(
    raw.map((entry) => {
      const value = exact(entry, [
        "startLocalTime",
        "endLocalTime",
        "endsNextDay",
        "serviceModes",
        "orderCutoffSeconds",
        "leadTimeSeconds",
      ]);
      const startLocalTime = localTime(value.startLocalTime),
        endLocalTime = localTime(value.endLocalTime);
      if (
        typeof value.endsNextDay !== "boolean" ||
        [value.orderCutoffSeconds, value.leadTimeSeconds].some(
          (n) => !Number.isSafeInteger(n) || (n as number) < 0 || (n as number) > 86400,
        ) ||
        (value.endsNextDay ? endLocalTime >= startLocalTime : endLocalTime <= startLocalTime)
      )
        throw new Error("Service state unavailable.");
      return Object.freeze({
        startLocalTime,
        endLocalTime,
        endsNextDay: value.endsNextDay,
        serviceModes: serviceModes(value.serviceModes),
        orderCutoffSeconds: value.orderCutoffSeconds as number,
        leadTimeSeconds: value.leadTimeSeconds as number,
      });
    }),
  );
}
function hours(raw: unknown, observedAt: string): ServiceHours {
  const value = exact(raw, [
    "configurationSource",
    "effectiveFrom",
    "effectiveUntil",
    "businessDayStartLocalTime",
    "weeklySchedule",
    "exceptions",
  ]);
  if (
    !["StoreOverride", "BrandInherited"].includes(String(value.configurationSource)) ||
    !Array.isArray(value.weeklySchedule) ||
    value.weeklySchedule.length !== 7 ||
    !Array.isArray(value.exceptions) ||
    value.exceptions.length > 366
  )
    throw new Error("Service state unavailable.");
  const effectiveFrom = instant(value.effectiveFrom);
  const effectiveUntil = value.effectiveUntil === null ? null : instant(value.effectiveUntil);
  if (effectiveFrom > observedAt || (effectiveUntil !== null && effectiveUntil <= observedAt))
    throw new Error("Service state unavailable.");
  const exceptions = value.exceptions.map((entry) => {
    const item = exact(entry, ["localDate", "kind", "intervals"]);
    if (
      typeof item.localDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(item.localDate) ||
      !Number.isFinite(Date.parse(item.localDate + "T00:00:00.000Z")) ||
      new Date(item.localDate + "T00:00:00.000Z").toISOString().slice(0, 10) !== item.localDate ||
      !["Holiday", "TemporaryClosure", "Override"].includes(String(item.kind))
    )
      throw new Error("Service state unavailable.");
    return Object.freeze({
      localDate: item.localDate,
      kind: item.kind as string,
      intervals: intervals(item.intervals),
    });
  });
  if (new Set(exceptions.map((entry) => entry.localDate)).size !== exceptions.length)
    throw new Error("Service state unavailable.");
  return Object.freeze({
    configurationSource: value.configurationSource as ServiceHours["configurationSource"],
    effectiveFrom,
    effectiveUntil,
    businessDayStartLocalTime: localTime(value.businessDayStartLocalTime),
    weeklySchedule: Object.freeze(
      value.weeklySchedule.map((entry, index) => {
        const day = exact(entry, ["isoWeekday", "intervals"]);
        if (day.isoWeekday !== index + 1) throw new Error("Service state unavailable.");
        return Object.freeze({ isoWeekday: index + 1, intervals: intervals(day.intervals) });
      }),
    ),
    exceptions: Object.freeze(exceptions),
  });
}
export function parseServiceControlState(raw: unknown, store: string): ServiceControlState {
  const value = exact(raw, [
    "screenId",
    "storeReference",
    "configurationReference",
    "timeZone",
    "enabledServiceModes",
    "observedAt",
    "expectedVersion",
    "activePauses",
    "hours",
  ]);
  if (
    value.screenId !== "STORE-HOURS-SERVICE" ||
    ref(value.storeReference) !== store ||
    typeof value.timeZone !== "string" ||
    value.timeZone.length > 100 ||
    !Number.isSafeInteger(value.expectedVersion) ||
    (value.expectedVersion as number) < 0 ||
    !Array.isArray(value.activePauses) ||
    value.activePauses.length > 100
  )
    throw new Error("Service state unavailable.");
  new Intl.DateTimeFormat("en", { timeZone: value.timeZone });
  const observedAt = instant(value.observedAt);
  const activePauses = value.activePauses.map((rawPause) => {
    const pause = exact(rawPause, [
      "closureReference",
      "effectiveFrom",
      "effectiveUntil",
      "serviceModes",
    ]);
    const effectiveFrom = instant(pause.effectiveFrom),
      effectiveUntil = instant(pause.effectiveUntil);
    if (effectiveFrom > observedAt || effectiveUntil <= observedAt)
      throw new Error("Service state unavailable.");
    return Object.freeze({
      closureReference: ref(pause.closureReference),
      effectiveFrom,
      effectiveUntil,
      serviceModes: pause.serviceModes === null ? null : serviceModes(pause.serviceModes),
    });
  });
  if (new Set(activePauses.map((pause) => pause.closureReference)).size !== activePauses.length)
    throw new Error("Service state unavailable.");
  return Object.freeze({
    screenId: "STORE-HOURS-SERVICE",
    hours: hours(value.hours, observedAt),
    storeReference: store,
    configurationReference: ref(value.configurationReference),
    timeZone: value.timeZone,
    enabledServiceModes: serviceModes(value.enabledServiceModes),
    observedAt,
    expectedVersion: value.expectedVersion as number,
    activePauses: Object.freeze(activePauses),
  });
}
export interface ServiceControlCommand {
  command: "PauseService" | "ResumeService";
  operationReference: string;
  configurationReference: string;
  auditReference: string;
  expectedVersion: number;
  content:
    | { effectiveUntil: string; serviceModes: readonly ServiceMode[] | null }
    | { pauseOperationReference: string };
}
export function serviceOperationReference() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = Date.now();
  for (let index = 5; index >= 0; index--) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 15);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 63);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
export function createServiceControlClient(fetcher: typeof fetch = fetch) {
  async function request(signal: AbortSignal, command?: ServiceControlCommand, csrf?: string) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, 15000);
    try {
      const response = await fetcher("/merchant/service-control", {
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
        throw new Error("Service request unavailable.");
      const text = await response.text();
      if (text.length > 2097152 || controller.signal.aborted)
        throw new Error("Service request unavailable.");
      return JSON.parse(text) as unknown;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  return Object.freeze({
    async load(store: string, signal: AbortSignal) {
      return parseServiceControlState(await request(signal), store);
    },
    async execute(command: ServiceControlCommand, csrf: string, signal: AbortSignal) {
      const result = exact(await request(signal, command, csrf), ["status", "resultingVersion"]);
      if (
        !["Applied", "AlreadyApplied"].includes(String(result.status)) ||
        result.resultingVersion !== command.expectedVersion + 1
      )
        throw new Error("Service request unavailable.");
    },
  });
}

export { intervals as parseServiceIntervals };
