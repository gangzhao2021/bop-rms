import {
  parseCanonicalInstant,
  type BrandReference,
  type CanonicalInstant,
  type StoreReference,
  type TenantScopeKind,
} from "@bop/tenant";
import {
  deriveEffectiveStatus,
  periodsOverlap,
  resolveEffectiveVersion,
  type EffectiveResolution,
  type EffectiveStatus,
} from "../domain/resolve-effective-version.js";

export type EffectivePeriodReference = string & {
  readonly __effectivePeriodReference: unique symbol;
};
export type EffectivePeriodDigest = string & { readonly __effectivePeriodDigest: unique symbol };
export type EffectivePeriodCode = string & { readonly __effectivePeriodCode: unique symbol };
export type EffectivePeriodVersion = number & { readonly __effectivePeriodVersion: unique symbol };
export type CandidateSetDigest = string & { readonly __candidateSetDigest: unique symbol };

export interface EffectiveScope {
  readonly kind: TenantScopeKind;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference | null;
}

export interface ZonedBoundary {
  readonly instant: CanonicalInstant;
  readonly localDateTime: string;
  readonly utcOffsetMinutes: number;
}

export interface EffectivePeriod {
  readonly timeZone: string;
  readonly effectiveFrom: ZonedBoundary;
  readonly effectiveUntil: ZonedBoundary | null;
}

export interface EffectiveConfigurationVersion {
  readonly timingVersionReference: EffectivePeriodReference;
  readonly familyReference: EffectivePeriodReference;
  readonly configurationReference: EffectivePeriodReference;
  readonly releaseReference: EffectivePeriodReference;
  readonly snapshotReference: EffectivePeriodReference;
  readonly snapshotDigest: EffectivePeriodDigest;
  readonly configurationType: EffectivePeriodCode;
  readonly purposeCode: EffectivePeriodCode;
  readonly scope: EffectiveScope;
  readonly version: EffectivePeriodVersion;
  readonly period: EffectivePeriod;
  readonly periodDigest: EffectivePeriodDigest;
  readonly approvalEvidenceReference: EffectivePeriodReference;
  readonly createdAt: CanonicalInstant;
}

export interface EffectivePeriodApprovalEvidence {
  readonly evidenceReference: EffectivePeriodReference;
  readonly familyReference: EffectivePeriodReference;
  readonly timingVersionReference: EffectivePeriodReference;
  readonly version: EffectivePeriodVersion;
  readonly scope: EffectiveScope;
  readonly periodDigest: EffectivePeriodDigest;
  readonly decision: "Accepted";
  readonly approvedActorReference: EffectivePeriodReference;
  readonly approvedAt: CanonicalInstant;
  readonly validUntil: CanonicalInstant;
}

export interface EffectivePeriodIntent {
  readonly intentReference: EffectivePeriodReference;
  readonly timingVersionReference: EffectivePeriodReference;
  readonly kind: "Activation" | "Expiry";
  readonly dueAt: CanonicalInstant;
  readonly createdAt: CanonicalInstant;
}

export interface EffectiveResolutionRecord {
  readonly familyReference: EffectivePeriodReference;
  readonly scope: EffectiveScope;
  readonly evaluationInstant: CanonicalInstant;
  readonly candidateSetDigest: CandidateSetDigest;
  readonly outcome: EffectiveResolution["outcome"];
  readonly selectedTimingVersionReference: EffectivePeriodReference | null;
  readonly reason: "NO_EFFECTIVE_VERSION" | "MULTIPLE_EFFECTIVE_VERSIONS" | null;
  readonly conflictingTimingVersionReferences: readonly EffectivePeriodReference[];
}

export const effectivePeriodContractErrorCodes = [
  "EFFECTIVE_PERIOD_INPUT_INVALID",
  "EFFECTIVE_PERIOD_SCOPE_INVALID",
  "EFFECTIVE_PERIOD_TIME_INVALID",
  "EFFECTIVE_PERIOD_OVERLAP",
  "EFFECTIVE_PERIOD_CANDIDATES_INVALID",
] as const;
export type EffectivePeriodContractErrorCode = (typeof effectivePeriodContractErrorCodes)[number];

export class EffectivePeriodContractError extends Error {
  readonly code: EffectivePeriodContractErrorCode;

  constructor(code: EffectivePeriodContractErrorCode) {
    super("effective period contract input is invalid");
    this.name = "EffectivePeriodContractError";
    this.code = code;
  }
}

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const digest = /^sha256:[0-9a-f]{64}$/u;
const code = /^[A-Z][A-Z0-9_]{2,63}$/u;
const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/u;

function fail(codeValue: EffectivePeriodContractErrorCode): never {
  throw new EffectivePeriodContractError(codeValue);
}

function exact(
  value: object,
  fields: readonly string[],
  error: EffectivePeriodContractErrorCode,
): void {
  if (Object.getPrototypeOf(value) !== Object.prototype) fail(error);
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(fields);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !keys.includes(field)) ||
    keys.some((field) => typeof field !== "string" || !allowed.has(field)) ||
    keys.some((field) => {
      if (typeof field !== "string") return true;
      const descriptor = descriptors[field];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  )
    fail(error);
}

function canonical(value: unknown, error: EffectivePeriodContractErrorCode): CanonicalInstant {
  try {
    return parseCanonicalInstant(value);
  } catch {
    return fail(error);
  }
}

export function parseEffectivePeriodReference(value: unknown): EffectivePeriodReference {
  if (typeof value !== "string" || !uuidV7.test(value)) fail("EFFECTIVE_PERIOD_INPUT_INVALID");
  return value as EffectivePeriodReference;
}

export function parseEffectivePeriodDigest(value: unknown): EffectivePeriodDigest {
  if (typeof value !== "string" || !digest.test(value)) fail("EFFECTIVE_PERIOD_INPUT_INVALID");
  return value as EffectivePeriodDigest;
}

export function parseCandidateSetDigest(value: unknown): CandidateSetDigest {
  return parseEffectivePeriodDigest(value) as unknown as CandidateSetDigest;
}

export function parseEffectivePeriodCode(value: unknown): EffectivePeriodCode {
  if (typeof value !== "string" || !code.test(value)) fail("EFFECTIVE_PERIOD_INPUT_INVALID");
  return value as EffectivePeriodCode;
}

export function parseEffectivePeriodVersion(value: unknown): EffectivePeriodVersion {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("EFFECTIVE_PERIOD_INPUT_INVALID");
  return value as EffectivePeriodVersion;
}

export function parseEffectivePeriodInstant(value: unknown): CanonicalInstant {
  return canonical(value, "EFFECTIVE_PERIOD_TIME_INVALID");
}

export function createEffectiveScope(input: EffectiveScope): EffectiveScope {
  exact(input, ["kind", "brandReference", "storeReference"], "EFFECTIVE_PERIOD_SCOPE_INVALID");
  const brandReference = parseEffectivePeriodReference(
    input.brandReference,
  ) as unknown as BrandReference;
  const storeReference =
    input.storeReference === null
      ? null
      : (parseEffectivePeriodReference(input.storeReference) as unknown as StoreReference);
  if (
    (input.kind !== "Brand" && input.kind !== "Store") ||
    (input.kind === "Brand" && storeReference !== null) ||
    (input.kind === "Store" && storeReference === null)
  )
    fail("EFFECTIVE_PERIOD_SCOPE_INVALID");
  return Object.freeze({ kind: input.kind, brandReference, storeReference });
}

export function sameEffectiveScope(left: EffectiveScope, right: EffectiveScope): boolean {
  return (
    left.kind === right.kind &&
    left.brandReference === right.brandReference &&
    left.storeReference === right.storeReference
  );
}

function createBoundary(input: ZonedBoundary, timeZone: string): ZonedBoundary {
  exact(input, ["instant", "localDateTime", "utcOffsetMinutes"], "EFFECTIVE_PERIOD_TIME_INVALID");
  const instantValue = canonical(input.instant, "EFFECTIVE_PERIOD_TIME_INVALID");
  const match = typeof input.localDateTime === "string" ? local.exec(input.localDateTime) : null;
  if (
    match === null ||
    !Number.isInteger(input.utcOffsetMinutes) ||
    input.utcOffsetMinutes < -840 ||
    input.utcOffsetMinutes > 840
  )
    fail("EFFECTIVE_PERIOD_TIME_INVALID");
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hourCycle: "h23",
    });
  } catch {
    return fail("EFFECTIVE_PERIOD_TIME_INVALID");
  }
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(instantValue))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const rendered = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}`;
  const localAsUtc = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7]),
  );
  const offset = (localAsUtc - Date.parse(instantValue)) / 60_000;
  if (
    rendered !== input.localDateTime ||
    offset !== input.utcOffsetMinutes ||
    new Date(localAsUtc).toISOString().slice(0, -1) !== input.localDateTime
  )
    fail("EFFECTIVE_PERIOD_TIME_INVALID");
  return Object.freeze({
    instant: instantValue,
    localDateTime: input.localDateTime,
    utcOffsetMinutes: input.utcOffsetMinutes,
  });
}

export function createEffectivePeriod(input: EffectivePeriod): EffectivePeriod {
  exact(input, ["timeZone", "effectiveFrom", "effectiveUntil"], "EFFECTIVE_PERIOD_TIME_INVALID");
  if (typeof input.timeZone !== "string" || input.timeZone.length < 1)
    fail("EFFECTIVE_PERIOD_TIME_INVALID");
  const effectiveFrom = createBoundary(input.effectiveFrom, input.timeZone);
  const effectiveUntil =
    input.effectiveUntil === null ? null : createBoundary(input.effectiveUntil, input.timeZone);
  if (
    effectiveUntil !== null &&
    Date.parse(effectiveUntil.instant) <= Date.parse(effectiveFrom.instant)
  )
    fail("EFFECTIVE_PERIOD_TIME_INVALID");
  return Object.freeze({ timeZone: input.timeZone, effectiveFrom, effectiveUntil });
}

export function createEffectiveConfigurationVersion(
  input: EffectiveConfigurationVersion,
): EffectiveConfigurationVersion {
  exact(
    input,
    [
      "timingVersionReference",
      "familyReference",
      "configurationReference",
      "releaseReference",
      "snapshotReference",
      "snapshotDigest",
      "configurationType",
      "purposeCode",
      "scope",
      "version",
      "period",
      "periodDigest",
      "approvalEvidenceReference",
      "createdAt",
    ],
    "EFFECTIVE_PERIOD_INPUT_INVALID",
  );
  return Object.freeze({
    timingVersionReference: parseEffectivePeriodReference(input.timingVersionReference),
    familyReference: parseEffectivePeriodReference(input.familyReference),
    configurationReference: parseEffectivePeriodReference(input.configurationReference),
    releaseReference: parseEffectivePeriodReference(input.releaseReference),
    snapshotReference: parseEffectivePeriodReference(input.snapshotReference),
    snapshotDigest: parseEffectivePeriodDigest(input.snapshotDigest),
    configurationType: parseEffectivePeriodCode(input.configurationType),
    purposeCode: parseEffectivePeriodCode(input.purposeCode),
    scope: createEffectiveScope(input.scope),
    version: parseEffectivePeriodVersion(input.version),
    period: createEffectivePeriod(input.period),
    periodDigest: parseEffectivePeriodDigest(input.periodDigest),
    approvalEvidenceReference: parseEffectivePeriodReference(input.approvalEvidenceReference),
    createdAt: canonical(input.createdAt, "EFFECTIVE_PERIOD_INPUT_INVALID"),
  });
}

export function createEffectivePeriodApprovalEvidence(
  input: EffectivePeriodApprovalEvidence,
): EffectivePeriodApprovalEvidence {
  exact(
    input,
    [
      "evidenceReference",
      "familyReference",
      "timingVersionReference",
      "version",
      "scope",
      "periodDigest",
      "decision",
      "approvedActorReference",
      "approvedAt",
      "validUntil",
    ],
    "EFFECTIVE_PERIOD_INPUT_INVALID",
  );
  const approvedAt = canonical(input.approvedAt, "EFFECTIVE_PERIOD_INPUT_INVALID");
  const validUntil = canonical(input.validUntil, "EFFECTIVE_PERIOD_INPUT_INVALID");
  if (input.decision !== "Accepted" || Date.parse(validUntil) <= Date.parse(approvedAt))
    fail("EFFECTIVE_PERIOD_INPUT_INVALID");
  return Object.freeze({
    evidenceReference: parseEffectivePeriodReference(input.evidenceReference),
    familyReference: parseEffectivePeriodReference(input.familyReference),
    timingVersionReference: parseEffectivePeriodReference(input.timingVersionReference),
    version: parseEffectivePeriodVersion(input.version),
    scope: createEffectiveScope(input.scope),
    periodDigest: parseEffectivePeriodDigest(input.periodDigest),
    decision: input.decision,
    approvedActorReference: parseEffectivePeriodReference(input.approvedActorReference),
    approvedAt,
    validUntil,
  });
}

export function createEffectivePeriodIntent(input: EffectivePeriodIntent): EffectivePeriodIntent {
  exact(
    input,
    ["intentReference", "timingVersionReference", "kind", "dueAt", "createdAt"],
    "EFFECTIVE_PERIOD_INPUT_INVALID",
  );
  if (input.kind !== "Activation" && input.kind !== "Expiry")
    fail("EFFECTIVE_PERIOD_INPUT_INVALID");
  return Object.freeze({
    intentReference: parseEffectivePeriodReference(input.intentReference),
    timingVersionReference: parseEffectivePeriodReference(input.timingVersionReference),
    kind: input.kind,
    dueAt: canonical(input.dueAt, "EFFECTIVE_PERIOD_INPUT_INVALID"),
    createdAt: canonical(input.createdAt, "EFFECTIVE_PERIOD_INPUT_INVALID"),
  });
}

function periodValue(period: EffectivePeriod) {
  return {
    effectiveFrom: period.effectiveFrom.instant,
    effectiveUntil: period.effectiveUntil?.instant ?? null,
  };
}

export function deriveConfigurationStatus(
  candidate: EffectiveConfigurationVersion,
  evaluationInstant: unknown,
): EffectiveStatus {
  const at = canonical(evaluationInstant, "EFFECTIVE_PERIOD_TIME_INVALID");
  return deriveEffectiveStatus(periodValue(candidate.period), at);
}

export function validateNoEffectiveOverlap(
  candidate: EffectiveConfigurationVersion,
  existing: readonly EffectiveConfigurationVersion[],
): void {
  for (const value of existing) {
    if (
      value.familyReference === candidate.familyReference &&
      sameEffectiveScope(value.scope, candidate.scope) &&
      periodsOverlap(periodValue(value.period), periodValue(candidate.period))
    )
      fail("EFFECTIVE_PERIOD_OVERLAP");
  }
}

export function createEffectiveResolutionRecord(input: {
  readonly familyReference: EffectivePeriodReference;
  readonly scope: EffectiveScope;
  readonly evaluationInstant: unknown;
  readonly candidateSetDigest: CandidateSetDigest;
  readonly candidates: readonly EffectiveConfigurationVersion[];
}): EffectiveResolutionRecord {
  const familyReference = parseEffectivePeriodReference(input.familyReference);
  const scope = createEffectiveScope(input.scope);
  const evaluationInstant = canonical(input.evaluationInstant, "EFFECTIVE_PERIOD_TIME_INVALID");
  const candidateSetDigest = parseCandidateSetDigest(input.candidateSetDigest);
  const candidates = input.candidates.map(createEffectiveConfigurationVersion);
  if (
    candidates.some(
      (candidate) =>
        candidate.familyReference !== familyReference ||
        !sameEffectiveScope(candidate.scope, scope),
    )
  )
    fail("EFFECTIVE_PERIOD_CANDIDATES_INVALID");
  const result = resolveEffectiveVersion(
    candidates.map((candidate) => ({
      timingVersionReference: candidate.timingVersionReference,
      period: periodValue(candidate.period),
    })),
    evaluationInstant,
  );
  return Object.freeze({
    familyReference,
    scope,
    evaluationInstant,
    candidateSetDigest,
    outcome: result.outcome,
    selectedTimingVersionReference:
      result.outcome === "Selected"
        ? parseEffectivePeriodReference(result.timingVersionReference)
        : null,
    reason: result.outcome === "Selected" ? null : result.reason,
    conflictingTimingVersionReferences: Object.freeze(
      result.outcome === "Conflict"
        ? result.timingVersionReferences.map(parseEffectivePeriodReference)
        : [],
    ),
  });
}
