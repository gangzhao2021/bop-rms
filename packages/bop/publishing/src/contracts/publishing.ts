import {
  parseCanonicalInstant,
  type BrandReference,
  type CanonicalInstant,
  type StoreReference,
  type TenantScopeKind,
} from "@bop/tenant";

export type PublishingReference = string & { readonly __publishingReference: unique symbol };
export type PublishingDigest = string & { readonly __publishingDigest: unique symbol };
export type PublishingCode = string & { readonly __publishingCode: unique symbol };
export type PublishingVersion = number & { readonly __publishingVersion: unique symbol };
export type ReleaseSequence = number & { readonly __releaseSequence: unique symbol };

export interface PublishingScope {
  readonly kind: TenantScopeKind;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference | null;
}

export const publishingLifecycleStates = [
  "Draft",
  "InReview",
  "Approved",
  "Published",
  "Archived",
  "Superseded",
] as const;
export type PublishingLifecycleState = (typeof publishingLifecycleStates)[number];

export interface PublishingLifecycleRecord {
  readonly lifecycleId: PublishingReference;
  readonly familyReference: PublishingReference;
  readonly configurationType: PublishingCode;
  readonly purposeCode: PublishingCode;
  readonly snapshotReference: PublishingReference;
  readonly snapshotDigest: PublishingDigest;
  readonly scope: PublishingScope;
  readonly version: PublishingVersion;
  readonly state: PublishingLifecycleState;
  readonly validationEvidenceReference: PublishingReference | null;
  readonly approvalEvidenceReference: PublishingReference | null;
  readonly createdAt: CanonicalInstant;
  readonly changedAt: CanonicalInstant;
}

export interface PublishingValidationEvidence {
  readonly evidenceReference: PublishingReference;
  readonly snapshotReference: PublishingReference;
  readonly snapshotDigest: PublishingDigest;
  readonly scope: PublishingScope;
  readonly result: "Pass";
  readonly checkedAt: CanonicalInstant;
  readonly validUntil: CanonicalInstant;
  readonly checkCodes: readonly PublishingCode[];
}

export interface PublishingApprovalEvidence {
  readonly evidenceReference: PublishingReference;
  readonly reviewLifecycleId: PublishingReference;
  readonly reviewVersion: PublishingVersion;
  readonly snapshotReference: PublishingReference;
  readonly snapshotDigest: PublishingDigest;
  readonly scope: PublishingScope;
  readonly decision: "Accepted";
  readonly approvedActorReference: PublishingReference;
  readonly approvedAt: CanonicalInstant;
  readonly validUntil: CanonicalInstant;
}

export const publishingReleaseKinds = ["Publish", "Rollback"] as const;
export type PublishingReleaseKind = (typeof publishingReleaseKinds)[number];

export interface PublishingReleaseRecord {
  readonly releaseId: PublishingReference;
  readonly familyReference: PublishingReference;
  readonly configurationType: PublishingCode;
  readonly purposeCode: PublishingCode;
  readonly snapshotReference: PublishingReference;
  readonly snapshotDigest: PublishingDigest;
  readonly scope: PublishingScope;
  readonly sequence: ReleaseSequence;
  readonly sourceLifecycleId: PublishingReference;
  readonly kind: PublishingReleaseKind;
  readonly previousReleaseId: PublishingReference | null;
  readonly createdAt: CanonicalInstant;
}

export const publishingContractErrorCodes = [
  "PUBLISHING_INPUT_INVALID",
  "PUBLISHING_SCOPE_INVALID",
  "PUBLISHING_EVIDENCE_INVALID",
  "PUBLISHING_RELEASE_INVALID",
] as const;
export type PublishingContractErrorCode = (typeof publishingContractErrorCodes)[number];

export class PublishingContractError extends Error {
  readonly code: PublishingContractErrorCode;

  constructor(code: PublishingContractErrorCode) {
    super("publishing contract input is invalid");
    this.name = "PublishingContractError";
    this.code = code;
  }
}

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const digest = /^sha256:[0-9a-f]{64}$/u;
const code = /^[A-Z][A-Z0-9_]{2,63}$/u;

function fail(error: PublishingContractErrorCode = "PUBLISHING_INPUT_INVALID"): never {
  throw new PublishingContractError(error);
}

function exact(value: object, fields: readonly string[], error: PublishingContractErrorCode): void {
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

function instant(value: unknown, error: PublishingContractErrorCode): CanonicalInstant {
  try {
    return parseCanonicalInstant(value);
  } catch {
    return fail(error);
  }
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

export function parsePublishingReference(value: unknown): PublishingReference {
  if (typeof value !== "string" || !uuidV7.test(value)) fail();
  return value as PublishingReference;
}

export function parsePublishingDigest(value: unknown): PublishingDigest {
  if (typeof value !== "string" || !digest.test(value)) fail();
  return value as PublishingDigest;
}

export function parsePublishingCode(value: unknown): PublishingCode {
  if (typeof value !== "string" || !code.test(value)) fail();
  return value as PublishingCode;
}

export function parsePublishingVersion(value: unknown): PublishingVersion {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail();
  return value as PublishingVersion;
}

export function parseReleaseSequence(value: unknown): ReleaseSequence {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("PUBLISHING_RELEASE_INVALID");
  return value as ReleaseSequence;
}

export function parsePublishingInstant(value: unknown): CanonicalInstant {
  return instant(value, "PUBLISHING_INPUT_INVALID");
}

export function createPublishingScope(input: PublishingScope): PublishingScope {
  exact(input, ["kind", "brandReference", "storeReference"], "PUBLISHING_SCOPE_INVALID");
  const brandReference = parsePublishingReference(
    input.brandReference,
  ) as unknown as BrandReference;
  const storeReference =
    input.storeReference === null
      ? null
      : (parsePublishingReference(input.storeReference) as unknown as StoreReference);
  if (
    (input.kind !== "Brand" && input.kind !== "Store") ||
    (input.kind === "Brand" && storeReference !== null) ||
    (input.kind === "Store" && storeReference === null)
  )
    fail("PUBLISHING_SCOPE_INVALID");
  return Object.freeze({ kind: input.kind, brandReference, storeReference });
}

export function createPublishingLifecycleRecord(
  input: PublishingLifecycleRecord,
): PublishingLifecycleRecord {
  exact(
    input,
    [
      "lifecycleId",
      "familyReference",
      "configurationType",
      "purposeCode",
      "snapshotReference",
      "snapshotDigest",
      "scope",
      "version",
      "state",
      "validationEvidenceReference",
      "approvalEvidenceReference",
      "createdAt",
      "changedAt",
    ],
    "PUBLISHING_INPUT_INVALID",
  );
  if (!isOneOf(input.state, publishingLifecycleStates)) fail();
  const createdAt = instant(input.createdAt, "PUBLISHING_INPUT_INVALID");
  const changedAt = instant(input.changedAt, "PUBLISHING_INPUT_INVALID");
  if (Date.parse(changedAt) < Date.parse(createdAt)) fail();
  return Object.freeze({
    lifecycleId: parsePublishingReference(input.lifecycleId),
    familyReference: parsePublishingReference(input.familyReference),
    configurationType: parsePublishingCode(input.configurationType),
    purposeCode: parsePublishingCode(input.purposeCode),
    snapshotReference: parsePublishingReference(input.snapshotReference),
    snapshotDigest: parsePublishingDigest(input.snapshotDigest),
    scope: createPublishingScope(input.scope),
    version: parsePublishingVersion(input.version),
    state: input.state,
    validationEvidenceReference:
      input.validationEvidenceReference === null
        ? null
        : parsePublishingReference(input.validationEvidenceReference),
    approvalEvidenceReference:
      input.approvalEvidenceReference === null
        ? null
        : parsePublishingReference(input.approvalEvidenceReference),
    createdAt,
    changedAt,
  });
}

export function createPublishingValidationEvidence(
  input: PublishingValidationEvidence,
): PublishingValidationEvidence {
  exact(
    input,
    [
      "evidenceReference",
      "snapshotReference",
      "snapshotDigest",
      "scope",
      "result",
      "checkedAt",
      "validUntil",
      "checkCodes",
    ],
    "PUBLISHING_EVIDENCE_INVALID",
  );
  if (
    input.result !== "Pass" ||
    !Array.isArray(input.checkCodes) ||
    input.checkCodes.length < 1 ||
    new Set(input.checkCodes).size !== input.checkCodes.length
  )
    fail("PUBLISHING_EVIDENCE_INVALID");
  const checkedAt = instant(input.checkedAt, "PUBLISHING_EVIDENCE_INVALID");
  const validUntil = instant(input.validUntil, "PUBLISHING_EVIDENCE_INVALID");
  if (Date.parse(checkedAt) >= Date.parse(validUntil)) fail("PUBLISHING_EVIDENCE_INVALID");
  return Object.freeze({
    evidenceReference: parsePublishingReference(input.evidenceReference),
    snapshotReference: parsePublishingReference(input.snapshotReference),
    snapshotDigest: parsePublishingDigest(input.snapshotDigest),
    scope: createPublishingScope(input.scope),
    result: "Pass",
    checkedAt,
    validUntil,
    checkCodes: Object.freeze(input.checkCodes.map(parsePublishingCode)),
  });
}

export function createPublishingApprovalEvidence(
  input: PublishingApprovalEvidence,
): PublishingApprovalEvidence {
  exact(
    input,
    [
      "evidenceReference",
      "reviewLifecycleId",
      "reviewVersion",
      "snapshotReference",
      "snapshotDigest",
      "scope",
      "decision",
      "approvedActorReference",
      "approvedAt",
      "validUntil",
    ],
    "PUBLISHING_EVIDENCE_INVALID",
  );
  if (input.decision !== "Accepted") fail("PUBLISHING_EVIDENCE_INVALID");
  const approvedAt = instant(input.approvedAt, "PUBLISHING_EVIDENCE_INVALID");
  const validUntil = instant(input.validUntil, "PUBLISHING_EVIDENCE_INVALID");
  if (Date.parse(approvedAt) >= Date.parse(validUntil)) fail("PUBLISHING_EVIDENCE_INVALID");
  return Object.freeze({
    evidenceReference: parsePublishingReference(input.evidenceReference),
    reviewLifecycleId: parsePublishingReference(input.reviewLifecycleId),
    reviewVersion: parsePublishingVersion(input.reviewVersion),
    snapshotReference: parsePublishingReference(input.snapshotReference),
    snapshotDigest: parsePublishingDigest(input.snapshotDigest),
    scope: createPublishingScope(input.scope),
    decision: "Accepted",
    approvedActorReference: parsePublishingReference(input.approvedActorReference),
    approvedAt,
    validUntil,
  });
}

export function createPublishingReleaseRecord(
  input: PublishingReleaseRecord,
): PublishingReleaseRecord {
  exact(
    input,
    [
      "releaseId",
      "familyReference",
      "configurationType",
      "purposeCode",
      "snapshotReference",
      "snapshotDigest",
      "scope",
      "sequence",
      "sourceLifecycleId",
      "kind",
      "previousReleaseId",
      "createdAt",
    ],
    "PUBLISHING_RELEASE_INVALID",
  );
  if (!isOneOf(input.kind, publishingReleaseKinds)) fail("PUBLISHING_RELEASE_INVALID");
  return Object.freeze({
    releaseId: parsePublishingReference(input.releaseId),
    familyReference: parsePublishingReference(input.familyReference),
    configurationType: parsePublishingCode(input.configurationType),
    purposeCode: parsePublishingCode(input.purposeCode),
    snapshotReference: parsePublishingReference(input.snapshotReference),
    snapshotDigest: parsePublishingDigest(input.snapshotDigest),
    scope: createPublishingScope(input.scope),
    sequence: parseReleaseSequence(input.sequence),
    sourceLifecycleId: parsePublishingReference(input.sourceLifecycleId),
    kind: input.kind,
    previousReleaseId:
      input.previousReleaseId === null ? null : parsePublishingReference(input.previousReleaseId),
    createdAt: instant(input.createdAt, "PUBLISHING_RELEASE_INVALID"),
  });
}

export function samePublishingScope(left: PublishingScope, right: PublishingScope): boolean {
  return (
    left.kind === right.kind &&
    left.brandReference === right.brandReference &&
    left.storeReference === right.storeReference
  );
}
