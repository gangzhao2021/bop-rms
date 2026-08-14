export type PrivacyReference = string & { readonly __privacyReference: unique symbol };
export type PrivacyInstant = string & { readonly __privacyInstant: unique symbol };
export type PrivacyRight =
  "AccessPortability" | "Correction" | "ConsentWithdrawal" | "DeletionAnonymization";
export type PrivacyRequestStatus =
  | "Intake"
  | "Verified"
  | "Assigned"
  | "Collecting"
  | "InReview"
  | "Fulfilled"
  | "Denied"
  | "Closed";
export interface PrivacyOwnerWorkItem {
  readonly ownerModule: string;
  readonly scopeReference: PrivacyReference;
  readonly status: "Pending" | "Completed" | "BlockedByHold" | "Failed";
  readonly outcomeReference: PrivacyReference | null;
  readonly reasonCode: string | null;
  readonly completedAt: PrivacyInstant | null;
}
export interface PrivacyRequestDecision {
  readonly action: PrivacyRequestStatus;
  readonly actorReference: PrivacyReference;
  readonly evidenceReference: PrivacyReference;
  readonly reasonCode: string;
  readonly occurredAt: PrivacyInstant;
}
export interface PrivacyRequest {
  readonly requestReference: PrivacyReference;
  readonly tenantReference: PrivacyReference;
  readonly brandReference: PrivacyReference;
  readonly subjectReference: PrivacyReference;
  readonly right: PrivacyRight;
  readonly status: PrivacyRequestStatus;
  readonly verificationReference: PrivacyReference | null;
  readonly ownerReference: PrivacyReference | null;
  readonly dueAt: PrivacyInstant;
  readonly holdReferences: readonly PrivacyReference[];
  readonly workItems: readonly PrivacyOwnerWorkItem[];
  readonly exportEvidence: null | {
    readonly artifactReference: PrivacyReference;
    readonly encrypted: true;
    readonly singleUse: true;
    readonly expiresAt: PrivacyInstant;
  };
  readonly decisions: readonly PrivacyRequestDecision[];
  readonly aggregateVersion: number;
  readonly updatedAt: PrivacyInstant;
}
export interface PrivacyTombstone {
  readonly opaqueSubjectId: PrivacyReference;
  readonly fieldReference: PrivacyReference;
  readonly policyVersion: string;
  readonly completedAt: PrivacyInstant;
  readonly replayStatus: "Pending" | "Applied";
  readonly productSearch: false;
  readonly analytics: false;
}
export class PrivacyRequestError extends Error {
  constructor(readonly code: "INVALID" | "CONFLICT" | "PROOF_REQUIRED" | "HOLD_BLOCKED") {
    super("Privacy request operation unavailable");
    this.name = "PrivacyRequestError";
  }
}
const fail = (code: PrivacyRequestError["code"] = "INVALID"): never => {
  throw new PrivacyRequestError(code);
};
export const privacyReference = (v: unknown) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v)
    ? (v as PrivacyReference)
    : fail();
export const privacyInstant = (v: unknown) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) &&
  new Date(Date.parse(v)).toISOString() === v
    ? (v as PrivacyInstant)
    : fail();
const code = (v: unknown) =>
  typeof v === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(v) ? v : fail();
const expected = (r: PrivacyRequest, v: number) => {
  if (!Number.isSafeInteger(v) || r.aggregateVersion !== v) fail("CONFLICT");
};
const evolve = (
  r: PrivacyRequest,
  patch: Partial<PrivacyRequest>,
  action: PrivacyRequestStatus,
  actor: unknown,
  evidence: unknown,
  reason: unknown,
  at: unknown,
) => {
  const occurredAt = privacyInstant(at);
  if (r.updatedAt > occurredAt) fail("CONFLICT");
  const decision = Object.freeze({
    action,
    actorReference: privacyReference(actor),
    evidenceReference: privacyReference(evidence),
    reasonCode: code(reason),
    occurredAt,
  });
  return Object.freeze({
    ...r,
    ...patch,
    decisions: Object.freeze([...r.decisions, decision]),
    aggregateVersion: r.aggregateVersion + 1,
    updatedAt: occurredAt,
  });
};
export function createPrivacyRequest(input: {
  requestReference: unknown;
  tenantReference: unknown;
  brandReference: unknown;
  subjectReference: unknown;
  right: PrivacyRight;
  actorReference: unknown;
  evidenceReference: unknown;
  occurredAt: unknown;
  dueAt: unknown;
}): PrivacyRequest {
  if (
    !["AccessPortability", "Correction", "ConsentWithdrawal", "DeletionAnonymization"].includes(
      input.right,
    )
  )
    fail();
  const occurredAt = privacyInstant(input.occurredAt),
    dueAt = privacyInstant(input.dueAt);
  const target = new Date(Date.parse(occurredAt));
  target.setUTCDate(target.getUTCDate() + 30);
  if (dueAt !== target.toISOString()) fail();
  const base = {
    requestReference: privacyReference(input.requestReference),
    tenantReference: privacyReference(input.tenantReference),
    brandReference: privacyReference(input.brandReference),
    subjectReference: privacyReference(input.subjectReference),
    right: input.right,
    status: "Intake" as const,
    verificationReference: null,
    ownerReference: null,
    dueAt,
    holdReferences: Object.freeze([]),
    workItems: Object.freeze([]),
    exportEvidence: null,
    decisions: Object.freeze([]),
    aggregateVersion: 0,
    updatedAt: occurredAt,
  };
  return evolve(
    base,
    {},
    "Intake",
    input.actorReference,
    input.evidenceReference,
    "INTAKE",
    occurredAt,
  );
}
export function transitionPrivacyRequest(
  r: PrivacyRequest,
  input: {
    expectedVersion: number;
    targetStatus: Exclude<PrivacyRequestStatus, "Intake">;
    actorReference: unknown;
    evidenceReference: unknown;
    reasonCode: unknown;
    occurredAt: unknown;
    verificationReference?: unknown;
    ownerReference?: unknown;
  },
): PrivacyRequest {
  expected(r, input.expectedVersion);
  const allowed: Record<PrivacyRequestStatus, readonly PrivacyRequestStatus[]> = {
    Intake: ["Verified", "Denied"],
    Verified: ["Assigned", "Denied"],
    Assigned: ["Collecting", "Denied"],
    Collecting: ["InReview", "Denied"],
    InReview: ["Fulfilled", "Denied"],
    Fulfilled: ["Closed"],
    Denied: ["Closed"],
    Closed: [],
  };
  if (!allowed[r.status].includes(input.targetStatus)) fail("CONFLICT");
  if (input.targetStatus === "Verified" && input.verificationReference === undefined)
    fail("PROOF_REQUIRED");
  if (input.targetStatus === "Assigned" && input.ownerReference === undefined)
    fail("PROOF_REQUIRED");
  if (
    input.targetStatus === "Fulfilled" &&
    (r.workItems.length === 0 || r.workItems.some((x) => x.status !== "Completed"))
  )
    fail("CONFLICT");
  return evolve(
    r,
    {
      status: input.targetStatus,
      verificationReference:
        input.targetStatus === "Verified"
          ? privacyReference(input.verificationReference)
          : r.verificationReference,
      ownerReference:
        input.targetStatus === "Assigned"
          ? privacyReference(input.ownerReference)
          : r.ownerReference,
    },
    input.targetStatus,
    input.actorReference,
    input.evidenceReference,
    input.reasonCode,
    input.occurredAt,
  );
}
export function addPrivacyOwnerWork(
  r: PrivacyRequest,
  input: {
    expectedVersion: number;
    ownerModule: unknown;
    scopeReference: unknown;
    actorReference: unknown;
    evidenceReference: unknown;
    occurredAt: unknown;
  },
): PrivacyRequest {
  expected(r, input.expectedVersion);
  if (r.status !== "Assigned" && r.status !== "Collecting") fail("CONFLICT");
  const ownerModule =
    typeof input.ownerModule === "string" &&
    /^@(bop|rms)\/[a-z][a-z0-9-]{1,63}$/u.test(input.ownerModule)
      ? input.ownerModule
      : fail();
  const scopeReference = privacyReference(input.scopeReference);
  if (r.workItems.some((x) => x.ownerModule === ownerModule && x.scopeReference === scopeReference))
    fail("CONFLICT");
  return evolve(
    r,
    {
      workItems: Object.freeze([
        ...r.workItems,
        Object.freeze({
          ownerModule,
          scopeReference,
          status: "Pending" as const,
          outcomeReference: null,
          reasonCode: null,
          completedAt: null,
        }),
      ]),
    },
    r.status,
    input.actorReference,
    input.evidenceReference,
    "OWNER_WORK_ADDED",
    input.occurredAt,
  );
}
export function completePrivacyOwnerWork(
  r: PrivacyRequest,
  input: {
    expectedVersion: number;
    scopeReference: unknown;
    status: "Completed" | "BlockedByHold" | "Failed";
    outcomeReference: unknown;
    reasonCode: unknown;
    actorReference: unknown;
    evidenceReference: unknown;
    occurredAt: unknown;
  },
): PrivacyRequest {
  expected(r, input.expectedVersion);
  const scope = privacyReference(input.scopeReference),
    index = r.workItems.findIndex((x) => x.scopeReference === scope && x.status === "Pending");
  if (index < 0) fail("CONFLICT");
  if (input.status === "BlockedByHold" && r.holdReferences.length === 0) fail("HOLD_BLOCKED");
  const work = [...r.workItems],
    occurredAt = privacyInstant(input.occurredAt);
  const prior = work[index];
  if (!prior) fail("CONFLICT");
  const item = prior as NonNullable<typeof prior>;
  work[index] = Object.freeze({
    ...item,
    status: input.status,
    outcomeReference: privacyReference(input.outcomeReference),
    reasonCode: code(input.reasonCode),
    completedAt: occurredAt,
  });
  return evolve(
    r,
    { workItems: Object.freeze(work) },
    r.status,
    input.actorReference,
    input.evidenceReference,
    "OWNER_WORK_RECORDED",
    occurredAt,
  );
}
export function attachPrivacyHold(
  r: PrivacyRequest,
  input: {
    expectedVersion: number;
    holdReference: unknown;
    actorReference: unknown;
    evidenceReference: unknown;
    occurredAt: unknown;
  },
): PrivacyRequest {
  expected(r, input.expectedVersion);
  const hold = privacyReference(input.holdReference);
  if (r.holdReferences.includes(hold)) fail("CONFLICT");
  return evolve(
    r,
    { holdReferences: Object.freeze([...r.holdReferences, hold]) },
    r.status,
    input.actorReference,
    input.evidenceReference,
    "HOLD_ATTACHED",
    input.occurredAt,
  );
}
export function attachPrivacyExport(
  r: PrivacyRequest,
  input: {
    expectedVersion: number;
    artifactReference: unknown;
    encrypted: boolean;
    singleUse: boolean;
    expiresAt: unknown;
    actorReference: unknown;
    evidenceReference: unknown;
    occurredAt: unknown;
  },
): PrivacyRequest {
  expected(r, input.expectedVersion);
  if (
    r.right !== "AccessPortability" ||
    input.encrypted !== true ||
    input.singleUse !== true ||
    r.exportEvidence
  )
    fail("CONFLICT");
  const occurredAt = privacyInstant(input.occurredAt),
    expiresAt = privacyInstant(input.expiresAt),
    ttl = Date.parse(expiresAt) - Date.parse(occurredAt);
  if (ttl <= 0 || ttl > 24 * 60 * 60 * 1000) fail("PROOF_REQUIRED");
  return evolve(
    r,
    {
      exportEvidence: Object.freeze({
        artifactReference: privacyReference(input.artifactReference),
        encrypted: true,
        singleUse: true,
        expiresAt,
      }),
    },
    r.status,
    input.actorReference,
    input.evidenceReference,
    "EXPORT_ATTACHED",
    occurredAt,
  );
}
export function createPrivacyTombstone(input: {
  opaqueSubjectId: unknown;
  fieldReference: unknown;
  policyVersion: unknown;
  completedAt: unknown;
  replayStatus: PrivacyTombstone["replayStatus"];
}): PrivacyTombstone {
  if (
    typeof input.policyVersion !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.policyVersion) ||
    !["Pending", "Applied"].includes(input.replayStatus)
  )
    fail();
  const policyVersion = input.policyVersion as string;
  return Object.freeze({
    opaqueSubjectId: privacyReference(input.opaqueSubjectId),
    fieldReference: privacyReference(input.fieldReference),
    policyVersion,
    completedAt: privacyInstant(input.completedAt),
    replayStatus: input.replayStatus,
    productSearch: false,
    analytics: false,
  });
}
