import { parseCanonicalInstant, parseOpaqueUuidV7, readClosedRecord } from "./identity-actor.js";
import {
  parseSelectorHash,
  type EncryptedSecretEnvelope,
  type SelectorHash,
} from "./browser-session.js";
import { parseWorkforceAccountBindingConfiguration } from "./workforce-account-binding.js";

export const workforceOnboardingPurpose = "WORKFORCE_ONBOARDING" as const;
export const workforceOnboardingStates = [
  "Prepared",
  "DispatchClaimed",
  "ProviderUnknown",
  "ProviderObserved",
  "Expired",
  "Rejected",
] as const;
export type WorkforceOnboardingState = (typeof workforceOnboardingStates)[number];
export interface WorkforceOnboardingCodec {
  canonicalize(value: unknown): string;
  hash(value: string): string;
}
export interface WorkforceOnboardingConfiguration {
  readonly environment: string;
  readonly issuer: string;
  readonly clientId: string;
}
export interface WorkforceOnboardingOriginal {
  readonly profile: "WorkforceOnboardingOriginalV1";
  readonly configuration: WorkforceOnboardingConfiguration;
  readonly operationReference: string;
  readonly operatorReference: string;
  readonly actorReference: string;
  readonly brandReference: string;
  readonly membershipReference: string;
  readonly storeAssignmentReferences: readonly string[];
  readonly emailDigest: SelectorHash;
  readonly approvedByReference: string;
  readonly approvalEvidenceReference: string;
  readonly relationshipEvidenceReference: string;
  readonly approvedPlanDigest: string;
  readonly reasonCode: string;
}
export interface WorkforceOnboardingProvider {
  readonly subjectHash: SelectorHash;
  readonly encryptedSubject: EncryptedSecretEnvelope;
  readonly username: string;
  readonly createdAt: string;
  readonly status: "FORCE_CHANGE_PASSWORD" | "CONFIRMED";
  readonly enabled: boolean;
}
export interface WorkforceOnboardingOperation {
  readonly profile: "WorkforceOnboardingOperationV1";
  readonly original: WorkforceOnboardingOriginal;
  readonly intentDigest: string;
  readonly version: number;
  readonly state: WorkforceOnboardingState;
  readonly invitationReference: string;
  readonly selectorHash: SelectorHash;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly dispatchStartedAt: string | null;
  readonly provider: WorkforceOnboardingProvider | null;
  readonly phaseOperationReference: string;
  readonly phaseRequestDigest: string;
  readonly previousSourceDigest: string | null;
  readonly auditReference: string;
  readonly occurredAt: string;
  readonly sourceDigest: string;
}
export class WorkforceOnboardingOperationError extends Error {
  readonly code:
    | "WORKFORCE_ONBOARDING_INVALID"
    | "WORKFORCE_ONBOARDING_DENIED"
    | "WORKFORCE_ONBOARDING_CONFLICT";
  constructor(code: WorkforceOnboardingOperationError["code"] = "WORKFORCE_ONBOARDING_INVALID") {
    super("Workforce onboarding unavailable");
    this.name = "WorkforceOnboardingOperationError";
    this.code = code;
  }
}
export const workforceOnboardingFail = (
  code?: WorkforceOnboardingOperationError["code"],
): never => {
  throw new WorkforceOnboardingOperationError(code);
};
export function workforceOnboardingClosed(v: unknown, keys: readonly string[]) {
  try {
    return readClosedRecord(v, keys);
  } catch {
    return workforceOnboardingFail();
  }
}
export function workforceOnboardingReference(v: unknown): string {
  try {
    return parseOpaqueUuidV7(v, "ACTOR_REFERENCE_INVALID");
  } catch {
    return workforceOnboardingFail();
  }
}
export function workforceOnboardingInstant(v: unknown): string {
  try {
    const at = parseCanonicalInstant(v);
    if (at.startsWith("0000-")) return workforceOnboardingFail();
    return at;
  } catch {
    return workforceOnboardingFail();
  }
}
export function workforceOnboardingDigest(v: unknown): string {
  if (typeof v !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(v)) return workforceOnboardingFail();
  return v;
}
export function workforceOnboardingVersion(v: unknown): number {
  if (!Number.isSafeInteger(v) || typeof v !== "number" || v < 1 || v >= Number.MAX_SAFE_INTEGER)
    return workforceOnboardingFail();
  return v;
}
function references(v: unknown): readonly string[] {
  if (
    !Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Array.prototype ||
    v.length > 100 ||
    Reflect.ownKeys(v).length !== v.length + 1
  )
    return workforceOnboardingFail();
  const values: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const d = Object.getOwnPropertyDescriptor(v, String(i));
    if (!d?.enumerable || !("value" in d)) return workforceOnboardingFail();
    values.push(workforceOnboardingReference(d.value));
  }
  if (new Set(values).size !== values.length) return workforceOnboardingFail();
  return Object.freeze(values);
}
export function parseWorkforceOnboardingConfiguration(
  v: unknown,
): WorkforceOnboardingConfiguration {
  const r = workforceOnboardingClosed(v, ["environment", "issuer", "clientId"]),
    c = parseWorkforceAccountBindingConfiguration({
      environment: r.environment,
      issuer: r.issuer,
      clientIds: [r.clientId],
    });
  const clientId = c.clientIds[0];
  if (!clientId) return workforceOnboardingFail();
  return Object.freeze({ environment: c.environment, issuer: c.issuer, clientId });
}
export function parseWorkforceOnboardingOriginal(v: unknown): WorkforceOnboardingOriginal {
  const r = workforceOnboardingClosed(v, [
    "profile",
    "configuration",
    "operationReference",
    "operatorReference",
    "actorReference",
    "brandReference",
    "membershipReference",
    "storeAssignmentReferences",
    "emailDigest",
    "approvedByReference",
    "approvalEvidenceReference",
    "relationshipEvidenceReference",
    "approvedPlanDigest",
    "reasonCode",
  ]);
  if (
    r.profile !== "WorkforceOnboardingOriginalV1" ||
    typeof r.reasonCode !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,127}$/u.test(r.reasonCode)
  )
    return workforceOnboardingFail();
  const original = Object.freeze({
    profile: r.profile,
    configuration: parseWorkforceOnboardingConfiguration(r.configuration),
    operationReference: workforceOnboardingReference(r.operationReference),
    operatorReference: workforceOnboardingReference(r.operatorReference),
    actorReference: workforceOnboardingReference(r.actorReference),
    brandReference: workforceOnboardingReference(r.brandReference),
    membershipReference: workforceOnboardingReference(r.membershipReference),
    storeAssignmentReferences: references(r.storeAssignmentReferences),
    emailDigest: parseSelectorHash(r.emailDigest),
    approvedByReference: workforceOnboardingReference(r.approvedByReference),
    approvalEvidenceReference: workforceOnboardingReference(r.approvalEvidenceReference),
    relationshipEvidenceReference: workforceOnboardingReference(r.relationshipEvidenceReference),
    approvedPlanDigest: workforceOnboardingDigest(r.approvedPlanDigest),
    reasonCode: r.reasonCode,
  });
  if (
    original.operatorReference === original.approvedByReference ||
    original.actorReference === original.approvedByReference
  )
    return workforceOnboardingFail();
  return original;
}
export function workforceOnboardingIntent(
  v: WorkforceOnboardingOriginal,
  codec: WorkforceOnboardingCodec,
): string {
  return workforceOnboardingDigest(
    `sha256:${codec.hash(codec.canonicalize(parseWorkforceOnboardingOriginal(v)))}`,
  );
}
export function workforceOnboardingSubjectContext(v: WorkforceOnboardingOriginal): string {
  const o = parseWorkforceOnboardingOriginal(v);
  return `${o.configuration.environment}:workforce-onboarding-subject:${o.operatorReference}:${o.operationReference}:${o.actorReference}:${o.configuration.issuer}`;
}
function provider(v: unknown, original: WorkforceOnboardingOriginal): WorkforceOnboardingProvider {
  const r = workforceOnboardingClosed(v, [
      "subjectHash",
      "encryptedSubject",
      "username",
      "createdAt",
      "status",
      "enabled",
    ]),
    e = workforceOnboardingClosed(r.encryptedSubject, [
      "algorithm",
      "keyReference",
      "ciphertext",
      "encryptionContext",
    ]);
  if (
    (e.algorithm !== "SYNTHETIC_AES_256_GCM" && e.algorithm !== "KMS_AES_256_GCM") ||
    typeof e.keyReference !== "string" ||
    e.keyReference.length < 1 ||
    e.keyReference.length > 255 ||
    typeof e.ciphertext !== "string" ||
    !/^[A-Za-z0-9_-]{39,2048}$/u.test(e.ciphertext) ||
    e.encryptionContext !== workforceOnboardingSubjectContext(original) ||
    r.username !== `bop_${original.actorReference}` ||
    (r.status !== "FORCE_CHANGE_PASSWORD" && r.status !== "CONFIRMED") ||
    typeof r.enabled !== "boolean"
  )
    return workforceOnboardingFail();
  return Object.freeze({
    subjectHash: parseSelectorHash(r.subjectHash),
    encryptedSubject: Object.freeze({
      algorithm: e.algorithm,
      keyReference: e.keyReference,
      ciphertext: e.ciphertext,
      encryptionContext: e.encryptionContext,
    }),
    username: r.username,
    createdAt: workforceOnboardingInstant(r.createdAt),
    status: r.status,
    enabled: r.enabled,
  });
}
const recordKeys = [
  "profile",
  "original",
  "intentDigest",
  "version",
  "state",
  "invitationReference",
  "selectorHash",
  "createdAt",
  "expiresAt",
  "dispatchStartedAt",
  "provider",
  "phaseOperationReference",
  "phaseRequestDigest",
  "previousSourceDigest",
  "auditReference",
  "occurredAt",
] as const;
export function buildWorkforceOnboardingOperation(
  value: unknown,
  codec: WorkforceOnboardingCodec,
): WorkforceOnboardingOperation {
  const r = workforceOnboardingClosed(value, recordKeys),
    original = parseWorkforceOnboardingOriginal(r.original);
  if (
    r.profile !== "WorkforceOnboardingOperationV1" ||
    !workforceOnboardingStates.includes(r.state as WorkforceOnboardingState)
  )
    return workforceOnboardingFail();
  const body = Object.freeze({
    profile: "WorkforceOnboardingOperationV1" as const,
    original,
    intentDigest: workforceOnboardingDigest(r.intentDigest),
    version: workforceOnboardingVersion(r.version),
    state: r.state as WorkforceOnboardingState,
    invitationReference: workforceOnboardingReference(r.invitationReference),
    selectorHash: parseSelectorHash(r.selectorHash),
    createdAt: workforceOnboardingInstant(r.createdAt),
    expiresAt: workforceOnboardingInstant(r.expiresAt),
    dispatchStartedAt:
      r.dispatchStartedAt === null ? null : workforceOnboardingInstant(r.dispatchStartedAt),
    provider: r.provider === null ? null : provider(r.provider, original),
    phaseOperationReference: workforceOnboardingReference(r.phaseOperationReference),
    phaseRequestDigest: workforceOnboardingDigest(r.phaseRequestDigest),
    previousSourceDigest:
      r.previousSourceDigest === null ? null : workforceOnboardingDigest(r.previousSourceDigest),
    auditReference: workforceOnboardingReference(r.auditReference),
    occurredAt: workforceOnboardingInstant(r.occurredAt),
  });
  if (
    body.phaseOperationReference === original.operationReference ||
    body.intentDigest !== workforceOnboardingIntent(original, codec) ||
    Date.parse(body.expiresAt) !== Date.parse(body.createdAt) + 86400000 ||
    body.occurredAt < body.createdAt ||
    (body.state === "Expired"
      ? body.occurredAt < body.expiresAt
      : body.state !== "Rejected" && body.occurredAt >= body.expiresAt) ||
    (body.version === 1) !== (body.previousSourceDigest === null) ||
    (body.version === 1 && (body.state !== "Prepared" || body.occurredAt !== body.createdAt)) ||
    (body.state === "Prepared" && (body.version !== 1 || body.dispatchStartedAt !== null)) ||
    (["DispatchClaimed", "ProviderUnknown", "ProviderObserved"].includes(body.state) &&
      body.dispatchStartedAt === null) ||
    (body.dispatchStartedAt !== null &&
      (body.dispatchStartedAt < body.createdAt ||
        body.dispatchStartedAt >= body.expiresAt ||
        body.dispatchStartedAt > body.occurredAt)) ||
    (body.state === "ProviderObserved" && body.provider === null) ||
    (["Prepared", "DispatchClaimed", "ProviderUnknown"].includes(body.state) &&
      body.provider !== null) ||
    (body.provider &&
      (body.dispatchStartedAt === null ||
        body.provider.createdAt < body.dispatchStartedAt ||
        body.provider.createdAt > body.occurredAt))
  )
    return workforceOnboardingFail();
  return Object.freeze({
    ...body,
    sourceDigest: workforceOnboardingDigest(`sha256:${codec.hash(codec.canonicalize(body))}`),
  });
}
export function parseWorkforceOnboardingOperation(
  value: unknown,
  codec: WorkforceOnboardingCodec,
): WorkforceOnboardingOperation {
  const r = workforceOnboardingClosed(value, [...recordKeys, "sourceDigest"]),
    { sourceDigest, ...body } = r,
    result = buildWorkforceOnboardingOperation(body, codec);
  if (sourceDigest !== result.sourceDigest) return workforceOnboardingFail();
  return result;
}
export function assertWorkforceOnboardingTransition(
  previous: WorkforceOnboardingOperation,
  next: WorkforceOnboardingOperation,
  codec: WorkforceOnboardingCodec,
): void {
  const p = parseWorkforceOnboardingOperation(previous, codec),
    n = parseWorkforceOnboardingOperation(next, codec);
  const allowed: Readonly<Record<WorkforceOnboardingState, readonly WorkforceOnboardingState[]>> = {
    Prepared: ["DispatchClaimed", "Expired", "Rejected"],
    DispatchClaimed: ["ProviderUnknown", "ProviderObserved", "Expired", "Rejected"],
    ProviderUnknown: ["ProviderUnknown", "ProviderObserved", "Expired", "Rejected"],
    ProviderObserved: ["Expired", "Rejected"],
    Expired: [],
    Rejected: [],
  };
  if (
    !allowed[p.state].includes(n.state) ||
    n.version !== p.version + 1 ||
    n.previousSourceDigest !== p.sourceDigest ||
    codec.canonicalize(n.original) !== codec.canonicalize(p.original) ||
    n.intentDigest !== p.intentDigest ||
    n.invitationReference !== p.invitationReference ||
    n.selectorHash !== p.selectorHash ||
    n.createdAt !== p.createdAt ||
    n.expiresAt !== p.expiresAt ||
    n.occurredAt < p.occurredAt ||
    (p.state !== "Prepared" && n.dispatchStartedAt !== p.dispatchStartedAt) ||
    (n.state === "DispatchClaimed" && n.dispatchStartedAt !== n.occurredAt) ||
    ((n.state === "Expired" || n.state === "Rejected") &&
      codec.canonicalize(n.provider) !== codec.canonicalize(p.provider)) ||
    n.phaseOperationReference === p.phaseOperationReference ||
    n.auditReference === p.auditReference
  )
    return workforceOnboardingFail("WORKFORCE_ONBOARDING_CONFLICT");
}
