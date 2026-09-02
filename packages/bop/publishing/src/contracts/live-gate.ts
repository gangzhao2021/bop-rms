import {
  parseBrandReference,
  parseCanonicalInstant,
  parseStoreReference,
  type BrandReference,
  type CanonicalInstant,
  type StoreReference,
} from "@bop/tenant";
import {
  parsePublishingCode,
  parsePublishingReference,
  parsePublishingVersion,
  type PublishingCode,
  type PublishingReference,
  type PublishingVersion,
} from "./publishing.js";
export type LiveGateId = string & { readonly __liveGateId: unique symbol };
export const liveGateStates = [
  "Draft",
  "Blocked",
  "InReview",
  "Approved",
  "Rejected",
  "Reopened",
] as const;
export type LiveGateState = (typeof liveGateStates)[number];
export const liveGateRequirementStatuses = [
  "Missing",
  "Submitted",
  "Accepted",
  "Rejected",
  "Expired",
  "Revoked",
  "NotApplicable",
] as const;
export type LiveGateRequirementStatus = (typeof liveGateRequirementStatuses)[number];
export interface LiveGateScope {
  readonly tenantReference: PublishingReference;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference;
  readonly environment: "Production";
}
export interface LiveGateRequirement {
  readonly requirementId: PublishingReference;
  readonly categoryCode: PublishingCode;
  readonly requirementCode: PublishingCode;
  readonly ownerReference: PublishingReference;
  readonly applicable: boolean;
  readonly status: LiveGateRequirementStatus;
  readonly evidenceReference: PublishingReference | null;
  readonly evidenceVersion: PublishingVersion | null;
  readonly validUntil: CanonicalInstant | null;
  readonly blockingReasonCode: PublishingCode | null;
}
export interface LiveGateRecord {
  readonly gateReference: PublishingReference;
  readonly gateId: LiveGateId;
  readonly version: PublishingVersion;
  readonly scope: LiveGateScope;
  readonly state: LiveGateState;
  readonly ownerReference: PublishingReference;
  readonly requirements: readonly LiveGateRequirement[];
  readonly submittedByReference: PublishingReference | null;
  readonly approvedByReference: PublishingReference | null;
  readonly decisionEvidenceReference: PublishingReference | null;
  readonly lastReviewedAt: CanonicalInstant | null;
  readonly changedAt: CanonicalInstant;
}
export class LiveGateContractError extends Error {
  constructor(readonly code: "LIVE_GATE_INPUT_INVALID" | "LIVE_GATE_BLOCKED") {
    super(
      code === "LIVE_GATE_BLOCKED"
        ? "live gate requirements are blocked"
        : "live gate input is invalid",
    );
    this.name = "LiveGateContractError";
  }
}
const invalid = (): never => {
  throw new LiveGateContractError("LIVE_GATE_INPUT_INVALID");
};
const exact = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((field) => typeof field !== "string" || !fields.includes(field))
  )
    return invalid();
  return value as Record<string, unknown>;
};
export function parseLiveGateId(value: unknown): LiveGateId {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9-]{7,95}$/u.test(value)) return invalid();
  return value as LiveGateId;
}
function scope(value: unknown): LiveGateScope {
  const input = exact(value, [
    "tenantReference",
    "brandReference",
    "storeReference",
    "environment",
  ]);
  if (input.environment !== "Production") return invalid();
  return Object.freeze({
    tenantReference: parsePublishingReference(input.tenantReference),
    brandReference: parseBrandReference(input.brandReference),
    storeReference: parseStoreReference(input.storeReference),
    environment: "Production",
  });
}
function requirement(value: unknown): LiveGateRequirement {
  const input = exact(value, [
    "requirementId",
    "categoryCode",
    "requirementCode",
    "ownerReference",
    "applicable",
    "status",
    "evidenceReference",
    "evidenceVersion",
    "validUntil",
    "blockingReasonCode",
  ]);
  if (
    typeof input.applicable !== "boolean" ||
    !liveGateRequirementStatuses.includes(input.status as LiveGateRequirementStatus)
  )
    return invalid();
  const evidenceReference =
    input.evidenceReference === null ? null : parsePublishingReference(input.evidenceReference);
  const evidenceVersion =
    input.evidenceVersion === null ? null : parsePublishingVersion(input.evidenceVersion);
  const validUntil = input.validUntil === null ? null : parseCanonicalInstant(input.validUntil);
  const blockingReasonCode =
    input.blockingReasonCode === null ? null : parsePublishingCode(input.blockingReasonCode);
  if (
    (evidenceReference === null) !== (evidenceVersion === null) ||
    (!input.applicable && input.status !== "NotApplicable") ||
    (input.applicable && input.status === "NotApplicable") ||
    ["Accepted", "Submitted", "Rejected", "Expired", "Revoked"].includes(String(input.status)) !==
      (evidenceReference !== null) ||
    ["Missing", "Rejected", "Expired", "Revoked"].includes(String(input.status)) !==
      (blockingReasonCode !== null) ||
    (input.status === "Accepted" && validUntil === null)
  )
    return invalid();
  return Object.freeze({
    requirementId: parsePublishingReference(input.requirementId),
    categoryCode: parsePublishingCode(input.categoryCode),
    requirementCode: parsePublishingCode(input.requirementCode),
    ownerReference: parsePublishingReference(input.ownerReference),
    applicable: input.applicable,
    status: input.status,
    evidenceReference,
    evidenceVersion,
    validUntil,
    blockingReasonCode,
  }) as LiveGateRequirement;
}
export function createLiveGateRecord(value: unknown): LiveGateRecord {
  const input = exact(value, [
    "gateReference",
    "gateId",
    "version",
    "scope",
    "state",
    "ownerReference",
    "requirements",
    "submittedByReference",
    "approvedByReference",
    "decisionEvidenceReference",
    "lastReviewedAt",
    "changedAt",
  ]);
  if (
    !liveGateStates.includes(input.state as LiveGateState) ||
    !Array.isArray(input.requirements) ||
    input.requirements.length === 0
  )
    return invalid();
  const requirements = Object.freeze(input.requirements.map(requirement));
  if (
    new Set(requirements.map((item) => item.requirementId)).size !== requirements.length ||
    new Set(requirements.map((item) => item.requirementCode)).size !== requirements.length
  )
    return invalid();
  const submittedByReference =
    input.submittedByReference === null
      ? null
      : parsePublishingReference(input.submittedByReference);
  const approvedByReference =
    input.approvedByReference === null ? null : parsePublishingReference(input.approvedByReference);
  const decisionEvidenceReference =
    input.decisionEvidenceReference === null
      ? null
      : parsePublishingReference(input.decisionEvidenceReference);
  const lastReviewedAt =
    input.lastReviewedAt === null ? null : parseCanonicalInstant(input.lastReviewedAt);
  const changedAt = parseCanonicalInstant(input.changedAt);
  if (
    (submittedByReference === null) !== ["Draft", "Blocked"].includes(String(input.state)) ||
    (approvedByReference !== null && approvedByReference === submittedByReference) ||
    (input.state === "Approved") !== (approvedByReference !== null) ||
    (input.state === "Approved" || input.state === "Rejected") !==
      (decisionEvidenceReference !== null) ||
    (input.state === "Approved" || input.state === "Rejected") !== (lastReviewedAt !== null) ||
    (lastReviewedAt !== null && Date.parse(lastReviewedAt) > Date.parse(changedAt))
  )
    return invalid();
  const record = Object.freeze({
    gateReference: parsePublishingReference(input.gateReference),
    gateId: parseLiveGateId(input.gateId),
    version: parsePublishingVersion(input.version),
    scope: scope(input.scope),
    state: input.state,
    ownerReference: parsePublishingReference(input.ownerReference),
    requirements,
    submittedByReference,
    approvedByReference,
    decisionEvidenceReference,
    lastReviewedAt,
    changedAt,
  }) as LiveGateRecord;
  if (record.state === "Approved") assertLiveGateReady(record, record.changedAt);
  return record;
}
export interface LiveGateEvaluation {
  readonly status: "Ready" | "Blocked";
  readonly blockingRequirementCodes: readonly PublishingCode[];
  readonly nextExpiry: CanonicalInstant | null;
}
export function evaluateLiveGate(record: LiveGateRecord, at: CanonicalInstant): LiveGateEvaluation {
  const when = Date.parse(parseCanonicalInstant(at));
  const blocked = record.requirements.filter(
    (item) =>
      item.applicable &&
      (item.status !== "Accepted" ||
        item.validUntil === null ||
        Date.parse(item.validUntil) <= when),
  );
  const expiries = record.requirements
    .filter((item) => item.applicable && item.status === "Accepted" && item.validUntil !== null)
    .map((item) => item.validUntil as CanonicalInstant)
    .sort();
  return Object.freeze({
    status: blocked.length === 0 ? "Ready" : "Blocked",
    blockingRequirementCodes: Object.freeze(blocked.map((item) => item.requirementCode).sort()),
    nextExpiry: expiries[0] ?? null,
  });
}
export function assertLiveGateReady(record: LiveGateRecord, at: CanonicalInstant): void {
  if (evaluateLiveGate(record, at).status !== "Ready")
    throw new LiveGateContractError("LIVE_GATE_BLOCKED");
}
