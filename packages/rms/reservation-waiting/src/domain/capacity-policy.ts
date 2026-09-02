import {
  parseReservationCode,
  parseReservationInstant,
  parseReservationReference,
  type ReservationCode,
  type ReservationInstant,
  type ReservationReference,
} from "./reservation.js";

export type CapacityPolicyLifecycle = "Draft" | "Scheduled" | "Published";
export type OverbookMode = "Disabled" | "ManagerOnly";

export interface CapacityBucket {
  readonly bucketReference: ReservationReference;
  readonly dayOfWeek: number;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly capacitySeats: number;
  readonly onlineAllocationSeats: number;
  readonly overbookMode: OverbookMode;
  readonly overbookAllowanceSeats: number;
  readonly turnTimeMinutes: number;
}

export interface CapacityClosure {
  readonly closureReference: ReservationReference;
  readonly startsAt: ReservationInstant;
  readonly endsAt: ReservationInstant;
  readonly reasonCode: ReservationCode;
}

export interface CapacityPolicyVersion {
  readonly policyReference: ReservationReference;
  readonly versionReference: ReservationReference;
  readonly tenantReference: ReservationReference;
  readonly brandReference: ReservationReference;
  readonly storeReference: ReservationReference;
  readonly areaReference: ReservationReference;
  readonly serviceCode: ReservationCode;
  readonly timeZone: string;
  readonly policyVersion: number;
  readonly aggregateVersion: number;
  readonly lifecycle: CapacityPolicyLifecycle;
  readonly effectiveFrom: ReservationInstant;
  readonly effectiveUntil: ReservationInstant | null;
  readonly buckets: readonly CapacityBucket[];
  readonly closures: readonly CapacityClosure[];
  readonly depositPolicyReference: ReservationReference | null;
  readonly depositPolicyVersion: number | null;
  readonly cancellationPolicyReference: ReservationReference | null;
  readonly cancellationPolicyVersion: number | null;
  readonly noShowPolicyReference: ReservationReference | null;
  readonly noShowPolicyVersion: number | null;
  readonly createdByActorReference: ReservationReference;
  readonly createdAt: ReservationInstant;
  readonly observedAt: ReservationInstant;
}

export interface CapacityPolicyRevision {
  readonly revisionReference: ReservationReference;
  readonly policyReference: ReservationReference;
  readonly previousVersionReference: ReservationReference;
  readonly revisedVersionReference: ReservationReference;
  readonly reasonCode: ReservationCode;
  readonly revisedByActorReference: ReservationReference;
  readonly revisedAt: ReservationInstant;
  readonly previousSnapshot: CapacityPolicyVersion;
  readonly revisedSnapshot: CapacityPolicyVersion;
}

export interface CapacitySimulationScenario {
  readonly scenarioReference: ReservationReference;
  readonly versionReference: ReservationReference;
  readonly occursAt: ReservationInstant;
  readonly dayOfWeek: number;
  readonly localMinute: number;
  readonly channel: "Staff" | "Customer";
  readonly requestedPartySize: number;
  readonly confirmedSeats: number;
  readonly heldSeats: number;
  readonly diningCompatibleSeats: number;
  readonly storeOpen: boolean;
  readonly pricingPolicyEvidence: "Current" | "NotRequired" | "Indeterminate";
  readonly managerOverrideReference: ReservationReference | null;
}

export interface CapacitySimulationResult {
  readonly scenarioReference: ReservationReference;
  readonly versionReference: ReservationReference;
  readonly calculatedAt: ReservationInstant;
  readonly calculationVersion: "CAPACITY_POLICY_V1";
  readonly bucketReference: ReservationReference | null;
  readonly effectiveCapacitySeats: number;
  readonly availableSeatsBeforeRequest: number;
  readonly availableSeatsAfterRequest: number;
  readonly blockingCodes: readonly ReservationCode[];
  readonly warningCodes: readonly ReservationCode[];
  readonly inputSummary: {
    readonly policyVersion: number;
    readonly channel: CapacitySimulationScenario["channel"];
    readonly requestedPartySize: number;
    readonly confirmedSeats: number;
    readonly heldSeats: number;
    readonly diningCompatibleSeats: number;
    readonly storeOpen: boolean;
    readonly pricingPolicyEvidence: CapacitySimulationScenario["pricingPolicyEvidence"];
    readonly managerOverrideApplied: boolean;
  };
}

export type CapacityPolicyErrorCode =
  | "CAPACITY_POLICY_INPUT_INVALID"
  | "CAPACITY_POLICY_REVISION_INVALID"
  | "CAPACITY_POLICY_TRANSITION_INVALID";

export class CapacityPolicyError extends Error {
  constructor(readonly code: CapacityPolicyErrorCode) {
    super("Capacity policy is unavailable");
    this.name = "CapacityPolicyError";
  }
}

const fail = (code: CapacityPolicyErrorCode): never => {
  throw new CapacityPolicyError(code);
};
const ianaZone = /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+.-]+)+$/u;

function validTimeZone(value: string) {
  try {
    void new Intl.DateTimeFormat("en-CA", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function closed(value: unknown, keys: readonly string[]) {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return fail("CAPACITY_POLICY_INPUT_INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        return fail("CAPACITY_POLICY_INPUT_INVALID");
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof CapacityPolicyError) throw error;
    return fail("CAPACITY_POLICY_INPUT_INVALID");
  }
}

function integer(value: unknown, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    return fail("CAPACITY_POLICY_INPUT_INVALID");
  return value as number;
}

function optionalReference(value: unknown) {
  return value === null ? null : parseReservationReference(value);
}

function optionalVersion(value: unknown) {
  return value === null ? null : integer(value, 1, Number.MAX_SAFE_INTEGER);
}

function policyPair(reference: unknown, version: unknown) {
  const parsedReference = optionalReference(reference);
  const parsedVersion = optionalVersion(version);
  if ((parsedReference === null) !== (parsedVersion === null))
    return fail("CAPACITY_POLICY_INPUT_INVALID");
  return Object.freeze({ reference: parsedReference, version: parsedVersion });
}

function bucket(value: unknown): CapacityBucket {
  const raw = closed(value, [
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
  const onlineAllocationSeats = integer(raw.onlineAllocationSeats, 0, 10000);
  const overbookAllowanceSeats = integer(raw.overbookAllowanceSeats, 0, 1000);
  if (
    endMinute <= startMinute ||
    onlineAllocationSeats > capacitySeats ||
    (raw.overbookMode !== "Disabled" && raw.overbookMode !== "ManagerOnly") ||
    (raw.overbookMode === "Disabled" && overbookAllowanceSeats !== 0) ||
    (raw.overbookMode === "ManagerOnly" && overbookAllowanceSeats < 1)
  )
    return fail("CAPACITY_POLICY_INPUT_INVALID");
  return Object.freeze({
    bucketReference: parseReservationReference(raw.bucketReference),
    dayOfWeek: integer(raw.dayOfWeek, 1, 7),
    startMinute,
    endMinute,
    capacitySeats,
    onlineAllocationSeats,
    overbookMode: raw.overbookMode,
    overbookAllowanceSeats,
    turnTimeMinutes: integer(raw.turnTimeMinutes, 1, 1440),
  });
}

function closure(value: unknown): CapacityClosure {
  const raw = closed(value, ["closureReference", "startsAt", "endsAt", "reasonCode"]);
  const startsAt = parseReservationInstant(raw.startsAt);
  const endsAt = parseReservationInstant(raw.endsAt);
  if (Date.parse(endsAt) <= Date.parse(startsAt)) return fail("CAPACITY_POLICY_INPUT_INVALID");
  return Object.freeze({
    closureReference: parseReservationReference(raw.closureReference),
    startsAt,
    endsAt,
    reasonCode: parseReservationCode(raw.reasonCode),
  });
}

function validateBuckets(values: readonly CapacityBucket[]) {
  const references = new Set<string>();
  for (const value of values) {
    if (references.has(value.bucketReference)) return fail("CAPACITY_POLICY_INPUT_INVALID");
    references.add(value.bucketReference);
  }
  const ordered = [...values].sort(
    (left, right) =>
      left.dayOfWeek - right.dayOfWeek ||
      left.startMinute - right.startMinute ||
      left.endMinute - right.endMinute,
  );
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (
      previous &&
      current &&
      previous.dayOfWeek === current.dayOfWeek &&
      current.startMinute < previous.endMinute
    )
      return fail("CAPACITY_POLICY_INPUT_INVALID");
  }
  return Object.freeze(ordered);
}

export function createCapacityPolicy(value: unknown): CapacityPolicyVersion {
  const raw = closed(value, [
    "policyReference",
    "versionReference",
    "tenantReference",
    "brandReference",
    "storeReference",
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
    "createdByActorReference",
    "createdAt",
    "observedAt",
  ]);
  if (
    !["Draft", "Scheduled", "Published"].includes(raw.lifecycle as string) ||
    typeof raw.timeZone !== "string" ||
    raw.timeZone.length > 120 ||
    !ianaZone.test(raw.timeZone) ||
    !validTimeZone(raw.timeZone) ||
    !Array.isArray(raw.buckets) ||
    raw.buckets.length < 1 ||
    raw.buckets.length > 168 ||
    !Array.isArray(raw.closures) ||
    raw.closures.length > 500
  )
    return fail("CAPACITY_POLICY_INPUT_INVALID");
  const effectiveFrom = parseReservationInstant(raw.effectiveFrom);
  const effectiveUntil =
    raw.effectiveUntil === null ? null : parseReservationInstant(raw.effectiveUntil);
  const createdAt = parseReservationInstant(raw.createdAt);
  const observedAt = parseReservationInstant(raw.observedAt);
  const deposit = policyPair(raw.depositPolicyReference, raw.depositPolicyVersion);
  const cancellation = policyPair(raw.cancellationPolicyReference, raw.cancellationPolicyVersion);
  const noShow = policyPair(raw.noShowPolicyReference, raw.noShowPolicyVersion);
  const buckets = validateBuckets(raw.buckets.map(bucket));
  const closures = raw.closures
    .map(closure)
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  if (
    (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) ||
    Date.parse(observedAt) < Date.parse(createdAt) ||
    new Set(closures.map((item) => item.closureReference)).size !== closures.length
  )
    return fail("CAPACITY_POLICY_INPUT_INVALID");
  return Object.freeze({
    policyReference: parseReservationReference(raw.policyReference),
    versionReference: parseReservationReference(raw.versionReference),
    tenantReference: parseReservationReference(raw.tenantReference),
    brandReference: parseReservationReference(raw.brandReference),
    storeReference: parseReservationReference(raw.storeReference),
    areaReference: parseReservationReference(raw.areaReference),
    serviceCode: parseReservationCode(raw.serviceCode),
    timeZone: raw.timeZone,
    policyVersion: integer(raw.policyVersion, 1, Number.MAX_SAFE_INTEGER),
    aggregateVersion: integer(raw.aggregateVersion, 1, Number.MAX_SAFE_INTEGER),
    lifecycle: raw.lifecycle as CapacityPolicyLifecycle,
    effectiveFrom,
    effectiveUntil,
    buckets,
    closures: Object.freeze(closures),
    depositPolicyReference: deposit.reference,
    depositPolicyVersion: deposit.version,
    cancellationPolicyReference: cancellation.reference,
    cancellationPolicyVersion: cancellation.version,
    noShowPolicyReference: noShow.reference,
    noShowPolicyVersion: noShow.version,
    createdByActorReference: parseReservationReference(raw.createdByActorReference),
    createdAt,
    observedAt,
  });
}

export function reviseCapacityPolicy(
  currentInput: CapacityPolicyVersion,
  candidateInput: CapacityPolicyVersion,
  evidence: {
    readonly revisionReference: ReservationReference;
    readonly reasonCode: ReservationCode;
    readonly actorReference: ReservationReference;
    readonly observedAt: ReservationInstant;
  },
) {
  const current = createCapacityPolicy(currentInput);
  const candidate = createCapacityPolicy(candidateInput);
  if (
    candidate.policyReference !== current.policyReference ||
    candidate.tenantReference !== current.tenantReference ||
    candidate.brandReference !== current.brandReference ||
    candidate.storeReference !== current.storeReference ||
    candidate.versionReference === current.versionReference ||
    candidate.policyVersion !== current.policyVersion + 1 ||
    candidate.aggregateVersion !== current.aggregateVersion + 1 ||
    candidate.lifecycle !== "Draft" ||
    candidate.createdByActorReference !== evidence.actorReference ||
    candidate.createdAt !== evidence.observedAt ||
    candidate.observedAt !== evidence.observedAt
  )
    return fail("CAPACITY_POLICY_REVISION_INVALID");
  return Object.freeze({
    policy: candidate,
    revision: Object.freeze({
      revisionReference: parseReservationReference(evidence.revisionReference),
      policyReference: current.policyReference,
      previousVersionReference: current.versionReference,
      revisedVersionReference: candidate.versionReference,
      reasonCode: parseReservationCode(evidence.reasonCode),
      revisedByActorReference: parseReservationReference(evidence.actorReference),
      revisedAt: parseReservationInstant(evidence.observedAt),
      previousSnapshot: current,
      revisedSnapshot: candidate,
    } satisfies CapacityPolicyRevision),
  });
}

export function transitionCapacityPolicy(
  currentInput: CapacityPolicyVersion,
  action: "Publish" | "Schedule",
  observedAtInput: ReservationInstant,
) {
  const current = createCapacityPolicy(currentInput);
  const observedAt = parseReservationInstant(observedAtInput);
  if (
    current.lifecycle !== "Draft" ||
    (action === "Publish" && current.effectiveFrom > observedAt) ||
    (action === "Schedule" && current.effectiveFrom <= observedAt)
  )
    return fail("CAPACITY_POLICY_TRANSITION_INVALID");
  return createCapacityPolicy({
    ...current,
    lifecycle: action === "Publish" ? "Published" : "Scheduled",
    aggregateVersion: current.aggregateVersion + 1,
    observedAt,
  });
}

function parseScenario(value: unknown): CapacitySimulationScenario {
  const raw = closed(value, [
    "scenarioReference",
    "versionReference",
    "occursAt",
    "dayOfWeek",
    "localMinute",
    "channel",
    "requestedPartySize",
    "confirmedSeats",
    "heldSeats",
    "diningCompatibleSeats",
    "storeOpen",
    "pricingPolicyEvidence",
    "managerOverrideReference",
  ]);
  if (
    (raw.channel !== "Staff" && raw.channel !== "Customer") ||
    typeof raw.storeOpen !== "boolean" ||
    !["Current", "NotRequired", "Indeterminate"].includes(raw.pricingPolicyEvidence as string)
  )
    return fail("CAPACITY_POLICY_INPUT_INVALID");
  return Object.freeze({
    scenarioReference: parseReservationReference(raw.scenarioReference),
    versionReference: parseReservationReference(raw.versionReference),
    occursAt: parseReservationInstant(raw.occursAt),
    dayOfWeek: integer(raw.dayOfWeek, 1, 7),
    localMinute: integer(raw.localMinute, 0, 1439),
    channel: raw.channel,
    requestedPartySize: integer(raw.requestedPartySize, 1, 1000),
    confirmedSeats: integer(raw.confirmedSeats, 0, 1000000),
    heldSeats: integer(raw.heldSeats, 0, 1000000),
    diningCompatibleSeats: integer(raw.diningCompatibleSeats, 0, 10000),
    storeOpen: raw.storeOpen,
    pricingPolicyEvidence:
      raw.pricingPolicyEvidence as CapacitySimulationScenario["pricingPolicyEvidence"],
    managerOverrideReference: optionalReference(raw.managerOverrideReference),
  });
}

export function simulateCapacityPolicy(
  policyInput: CapacityPolicyVersion,
  scenarioInput: unknown,
): CapacitySimulationResult {
  const policy = createCapacityPolicy(policyInput);
  const scenario = parseScenario(scenarioInput);
  if (scenario.versionReference !== policy.versionReference)
    return fail("CAPACITY_POLICY_INPUT_INVALID");
  const blocking: ReservationCode[] = [];
  const warnings: ReservationCode[] = [];
  const bucketMatch = policy.buckets.find(
    (item) =>
      item.dayOfWeek === scenario.dayOfWeek &&
      item.startMinute <= scenario.localMinute &&
      scenario.localMinute < item.endMinute,
  );
  const closedNow = policy.closures.some(
    (item) => item.startsAt <= scenario.occursAt && scenario.occursAt < item.endsAt,
  );
  if (!scenario.storeOpen) blocking.push(parseReservationCode("STORE_CLOSED"));
  if (
    scenario.occursAt < policy.effectiveFrom ||
    (policy.effectiveUntil !== null && scenario.occursAt >= policy.effectiveUntil)
  )
    blocking.push(parseReservationCode("POLICY_NOT_EFFECTIVE"));
  if (closedNow) blocking.push(parseReservationCode("CAPACITY_CLOSURE"));
  if (!bucketMatch) blocking.push(parseReservationCode("NO_CAPACITY_BUCKET"));
  const hasPricingPolicy =
    policy.depositPolicyReference !== null ||
    policy.cancellationPolicyReference !== null ||
    policy.noShowPolicyReference !== null;
  if (
    scenario.pricingPolicyEvidence === "Indeterminate" ||
    (scenario.pricingPolicyEvidence === "NotRequired" && hasPricingPolicy)
  )
    blocking.push(parseReservationCode("POLICY_EVIDENCE_UNKNOWN"));
  const configuredCapacity = bucketMatch?.capacitySeats ?? 0;
  const baseCapacity = Math.min(configuredCapacity, scenario.diningCompatibleSeats);
  let effectiveCapacity =
    scenario.channel === "Customer"
      ? Math.min(baseCapacity, bucketMatch?.onlineAllocationSeats ?? 0)
      : baseCapacity;
  if (scenario.channel === "Customer" && configuredCapacity > effectiveCapacity)
    warnings.push(parseReservationCode("ONLINE_ALLOCATION_APPLIED"));
  if (scenario.diningCompatibleSeats < configuredCapacity)
    warnings.push(parseReservationCode("DINING_CAPACITY_LIMITED"));
  const usedSeats = scenario.confirmedSeats + scenario.heldSeats;
  if (
    bucketMatch?.overbookMode === "ManagerOnly" &&
    scenario.channel === "Staff" &&
    scenario.managerOverrideReference !== null
  ) {
    effectiveCapacity += bucketMatch.overbookAllowanceSeats;
    warnings.push(parseReservationCode("MANAGER_OVERBOOK_APPLIED"));
  }
  const before = effectiveCapacity - usedSeats;
  const after = before - scenario.requestedPartySize;
  if (after < 0) blocking.push(parseReservationCode("CAPACITY_EXCEEDED"));
  return Object.freeze({
    scenarioReference: scenario.scenarioReference,
    versionReference: scenario.versionReference,
    calculatedAt: scenario.occursAt,
    calculationVersion: "CAPACITY_POLICY_V1",
    bucketReference: bucketMatch?.bucketReference ?? null,
    effectiveCapacitySeats: effectiveCapacity,
    availableSeatsBeforeRequest: before,
    availableSeatsAfterRequest: after,
    blockingCodes: Object.freeze([...new Set(blocking)].sort()),
    warningCodes: Object.freeze([...new Set(warnings)].sort()),
    inputSummary: Object.freeze({
      policyVersion: policy.policyVersion,
      channel: scenario.channel,
      requestedPartySize: scenario.requestedPartySize,
      confirmedSeats: scenario.confirmedSeats,
      heldSeats: scenario.heldSeats,
      diningCompatibleSeats: scenario.diningCompatibleSeats,
      storeOpen: scenario.storeOpen,
      pricingPolicyEvidence: scenario.pricingPolicyEvidence,
      managerOverrideApplied:
        bucketMatch?.overbookMode === "ManagerOnly" &&
        scenario.channel === "Staff" &&
        scenario.managerOverrideReference !== null,
    }),
  });
}
