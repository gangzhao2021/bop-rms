export type CapacityPolicyClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";

export class CapacityPolicyClientError extends Error {
  constructor(readonly code: CapacityPolicyClientErrorCode) {
    super("Capacity policy view is unavailable");
    this.name = "CapacityPolicyClientError";
  }
}

export interface CapacityBucketView {
  readonly bucketReference: string;
  readonly dayOfWeek: number;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly capacitySeats: number;
  readonly onlineAllocationSeats: number;
  readonly overbookMode: "Disabled" | "ManagerOnly";
  readonly overbookAllowanceSeats: number;
  readonly turnTimeMinutes: number;
}

export interface CapacityClosureView {
  readonly closureReference: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly reasonCode: string;
}

export interface CapacityIssueView {
  readonly severity: "Blocking" | "Warning";
  readonly code: string;
  readonly sourceSummary: string;
}

export interface CapacitySimulationView {
  readonly scenarioReference: string;
  readonly calculatedAt: string;
  readonly calculationVersion: string;
  readonly effectiveCapacitySeats: number;
  readonly availableSeatsBeforeRequest: number;
  readonly availableSeatsAfterRequest: number;
  readonly blockingCodes: readonly string[];
  readonly warningCodes: readonly string[];
}

export interface CapacityPolicyHistoryView {
  readonly versionReference: string;
  readonly policyVersion: number;
  readonly lifecycle: "Draft" | "Scheduled" | "Published";
  readonly effectiveFrom: string;
  readonly actorSummary: string;
}

export interface CapacityPolicyView {
  readonly screenId: "RES-CAPACITY-CONFIG";
  readonly projectionVersion: string;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale";
  readonly partial: boolean;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly policyReference: string;
  readonly versionReference: string;
  readonly areaReference: string;
  readonly serviceCode: string;
  readonly timeZone: string;
  readonly policyVersion: number;
  readonly aggregateVersion: number;
  readonly lifecycle: "Draft" | "Scheduled" | "Published";
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly buckets: readonly CapacityBucketView[];
  readonly closures: readonly CapacityClosureView[];
  readonly depositPolicyReference: string | null;
  readonly depositPolicyVersion: number | null;
  readonly cancellationPolicyReference: string | null;
  readonly cancellationPolicyVersion: number | null;
  readonly noShowPolicyReference: string | null;
  readonly noShowPolicyVersion: number | null;
  readonly issues: readonly CapacityIssueView[];
  readonly simulation: CapacitySimulationView | null;
  readonly history: readonly CapacityPolicyHistoryView[];
}

export interface CapacityPolicyProjectionClient {
  load(): Promise<unknown>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const code = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const safe = /^[^\p{Cc}\p{Cf}<>{}$]{1,160}$/u;

function object(value: unknown, keys: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new CapacityPolicyClientError("Unavailable");
  return value as Record<string, unknown>;
}

function reference(value: unknown, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !uuid.test(value))
    throw new CapacityPolicyClientError("Unavailable");
  return value;
}

function time(value: unknown, nullable = false) {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    !instant.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    throw new CapacityPolicyClientError("Unavailable");
  return value;
}

function controlled(value: unknown) {
  if (typeof value !== "string" || !code.test(value))
    throw new CapacityPolicyClientError("Unavailable");
  return value;
}

function text(value: unknown) {
  if (
    typeof value !== "string" ||
    !safe.test(value) ||
    value.trim() !== value ||
    /https?:\/\//iu.test(value)
  )
    throw new CapacityPolicyClientError("Unavailable");
  return value;
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    throw new CapacityPolicyClientError("Unavailable");
  return value as number;
}

function optionalInteger(value: unknown) {
  return value === null ? null : integer(value, 1);
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new CapacityPolicyClientError("Unavailable");
  return value as T;
}

function bucket(value: unknown): CapacityBucketView {
  const raw = object(value, [
    "bucketReference",
    "dayOfWeek",
    "startMinute",
    "endMinute",
    "capacitySeats",
    "onlineAllocationSeats",
    "overbookMode",
    "overbookAllowanceSeats",
    "turnTimeMinutes",
  ]);
  const startMinute = integer(raw.startMinute, 0, 1439);
  const endMinute = integer(raw.endMinute, 1, 1440);
  const capacitySeats = integer(raw.capacitySeats, 1, 10000);
  const onlineAllocationSeats = integer(raw.onlineAllocationSeats, 0, capacitySeats);
  const overbookMode = oneOf(raw.overbookMode, ["Disabled", "ManagerOnly"]);
  const overbookAllowanceSeats = integer(raw.overbookAllowanceSeats, 0, 1000);
  if (
    endMinute <= startMinute ||
    (overbookMode === "Disabled" && overbookAllowanceSeats !== 0) ||
    (overbookMode === "ManagerOnly" && overbookAllowanceSeats < 1)
  )
    throw new CapacityPolicyClientError("Unavailable");
  return Object.freeze({
    bucketReference: reference(raw.bucketReference) as string,
    dayOfWeek: integer(raw.dayOfWeek, 1, 7),
    startMinute,
    endMinute,
    capacitySeats,
    onlineAllocationSeats,
    overbookMode,
    overbookAllowanceSeats,
    turnTimeMinutes: integer(raw.turnTimeMinutes, 1, 1440),
  });
}

function closure(value: unknown): CapacityClosureView {
  const raw = object(value, ["closureReference", "startsAt", "endsAt", "reasonCode"]);
  const startsAt = time(raw.startsAt) as string;
  const endsAt = time(raw.endsAt) as string;
  if (endsAt <= startsAt) throw new CapacityPolicyClientError("Unavailable");
  return Object.freeze({
    closureReference: reference(raw.closureReference) as string,
    startsAt,
    endsAt,
    reasonCode: controlled(raw.reasonCode),
  });
}

function issue(value: unknown): CapacityIssueView {
  const raw = object(value, ["severity", "code", "sourceSummary"]);
  return Object.freeze({
    severity: oneOf(raw.severity, ["Blocking", "Warning"]),
    code: controlled(raw.code),
    sourceSummary: text(raw.sourceSummary),
  });
}

function controlledList(value: unknown) {
  if (!Array.isArray(value) || value.length > 100)
    throw new CapacityPolicyClientError("Unavailable");
  return Object.freeze(value.map(controlled).sort());
}

function simulation(value: unknown): CapacitySimulationView | null {
  if (value === null) return null;
  const raw = object(value, [
    "scenarioReference",
    "calculatedAt",
    "calculationVersion",
    "effectiveCapacitySeats",
    "availableSeatsBeforeRequest",
    "availableSeatsAfterRequest",
    "blockingCodes",
    "warningCodes",
  ]);
  return Object.freeze({
    scenarioReference: reference(raw.scenarioReference) as string,
    calculatedAt: time(raw.calculatedAt) as string,
    calculationVersion: controlled(raw.calculationVersion),
    effectiveCapacitySeats: integer(raw.effectiveCapacitySeats, 0, 11000),
    availableSeatsBeforeRequest: integer(raw.availableSeatsBeforeRequest, -1000000, 11000),
    availableSeatsAfterRequest: integer(raw.availableSeatsAfterRequest, -1000000, 11000),
    blockingCodes: controlledList(raw.blockingCodes),
    warningCodes: controlledList(raw.warningCodes),
  });
}

function history(value: unknown): CapacityPolicyHistoryView {
  const raw = object(value, [
    "versionReference",
    "policyVersion",
    "lifecycle",
    "effectiveFrom",
    "actorSummary",
  ]);
  return Object.freeze({
    versionReference: reference(raw.versionReference) as string,
    policyVersion: integer(raw.policyVersion, 1),
    lifecycle: oneOf(raw.lifecycle, ["Draft", "Scheduled", "Published"]),
    effectiveFrom: time(raw.effectiveFrom) as string,
    actorSummary: text(raw.actorSummary),
  });
}

export function parseCapacityPolicyView(value: unknown): CapacityPolicyView {
  const raw = object(value, [
    "screenId",
    "projectionVersion",
    "asOfUtc",
    "freshness",
    "partial",
    "tenantReference",
    "brandReference",
    "storeReference",
    "policyReference",
    "versionReference",
    "areaReference",
    "serviceCode",
    "timeZone",
    "policyVersion",
    "aggregateVersion",
    "lifecycle",
    "effectiveFrom",
    "effectiveUntil",
    "buckets",
    "closures",
    "depositPolicyReference",
    "depositPolicyVersion",
    "cancellationPolicyReference",
    "cancellationPolicyVersion",
    "noShowPolicyReference",
    "noShowPolicyVersion",
    "issues",
    "simulation",
    "history",
  ]);
  if (
    raw.screenId !== "RES-CAPACITY-CONFIG" ||
    typeof raw.partial !== "boolean" ||
    !Array.isArray(raw.buckets) ||
    raw.buckets.length > 168 ||
    !Array.isArray(raw.closures) ||
    raw.closures.length > 500 ||
    !Array.isArray(raw.issues) ||
    raw.issues.length > 200 ||
    !Array.isArray(raw.history) ||
    raw.history.length > 200
  )
    throw new CapacityPolicyClientError("Unavailable");
  const buckets = raw.buckets.map(bucket);
  const closures = raw.closures.map(closure);
  const orderedBuckets = [...buckets].sort(
    (left, right) =>
      left.dayOfWeek - right.dayOfWeek ||
      left.startMinute - right.startMinute ||
      left.endMinute - right.endMinute,
  );
  const effectiveFrom = time(raw.effectiveFrom) as string;
  const effectiveUntil = time(raw.effectiveUntil, true);
  const depositPolicyReference = reference(raw.depositPolicyReference, true);
  const depositPolicyVersion = optionalInteger(raw.depositPolicyVersion);
  const cancellationPolicyReference = reference(raw.cancellationPolicyReference, true);
  const cancellationPolicyVersion = optionalInteger(raw.cancellationPolicyVersion);
  const noShowPolicyReference = reference(raw.noShowPolicyReference, true);
  const noShowPolicyVersion = optionalInteger(raw.noShowPolicyVersion);
  if (
    new Set(buckets.map((item) => item.bucketReference)).size !== buckets.length ||
    new Set(closures.map((item) => item.closureReference)).size !== closures.length ||
    (effectiveUntil !== null && effectiveUntil <= effectiveFrom) ||
    (depositPolicyReference === null) !== (depositPolicyVersion === null) ||
    (cancellationPolicyReference === null) !== (cancellationPolicyVersion === null) ||
    (noShowPolicyReference === null) !== (noShowPolicyVersion === null) ||
    orderedBuckets.some((item, index) => {
      const previous = orderedBuckets[index - 1];
      return (
        previous !== undefined &&
        previous.dayOfWeek === item.dayOfWeek &&
        item.startMinute < previous.endMinute
      );
    })
  )
    throw new CapacityPolicyClientError("Unavailable");
  return Object.freeze({
    screenId: "RES-CAPACITY-CONFIG",
    projectionVersion: controlled(raw.projectionVersion),
    asOfUtc: time(raw.asOfUtc) as string,
    freshness: oneOf(raw.freshness, ["Current", "Stale"]),
    partial: raw.partial,
    tenantReference: reference(raw.tenantReference) as string,
    brandReference: reference(raw.brandReference) as string,
    storeReference: reference(raw.storeReference) as string,
    policyReference: reference(raw.policyReference) as string,
    versionReference: reference(raw.versionReference) as string,
    areaReference: reference(raw.areaReference) as string,
    serviceCode: controlled(raw.serviceCode),
    timeZone: text(raw.timeZone),
    policyVersion: integer(raw.policyVersion, 1),
    aggregateVersion: integer(raw.aggregateVersion, 1),
    lifecycle: oneOf(raw.lifecycle, ["Draft", "Scheduled", "Published"]),
    effectiveFrom,
    effectiveUntil,
    buckets: Object.freeze(orderedBuckets),
    closures: Object.freeze(closures),
    depositPolicyReference,
    depositPolicyVersion,
    cancellationPolicyReference,
    cancellationPolicyVersion,
    noShowPolicyReference,
    noShowPolicyVersion,
    issues: Object.freeze(raw.issues.map(issue)),
    simulation: simulation(raw.simulation),
    history: Object.freeze(raw.history.map(history)),
  });
}

export const unavailableCapacityPolicyProjectionClient: CapacityPolicyProjectionClient = {
  async load() {
    throw new CapacityPolicyClientError("Unavailable");
  },
};
