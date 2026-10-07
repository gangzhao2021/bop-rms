import { parseCanonicalInstant, parseOpaqueUuidV7, readClosedRecord } from "./identity-actor.js";
import {
  parseSelectorHash,
  type SelectorHash,
  type EncryptedSecretEnvelope,
} from "./browser-session.js";
import {
  parsePlatformActorDirectoryConfiguration,
  parsePlatformActorDirectorySubject,
} from "./platform-actor-directory.js";

export const workforceAccountBindingPurpose = "WORKFORCE_ACCOUNT_BINDING" as const;
export interface WorkforceAccountBindingConfiguration {
  readonly environment: string;
  readonly issuer: string;
  readonly clientIds: readonly string[];
}
export interface WorkforceAccountBindingCommand {
  readonly profile: "WorkforceAccountBindingImportV1";
  readonly operationReference: string;
  readonly actorReference: string;
  readonly subject: string;
  readonly invitationReference: string;
  readonly originalMembershipReference: string;
  readonly providerEvidenceReference: string;
  readonly recordedByReference: string;
  readonly approvedByReference: string;
  readonly approvalEvidenceReference: string;
  readonly reasonCode: string;
}
export interface WorkforceAccountBindingAcceptanceCommand extends Omit<
  WorkforceAccountBindingCommand,
  "profile"
> {
  readonly profile: "WorkforceAccountBindingAcceptanceV1";
}
export interface WorkforceAccountBindingAcceptanceOriginal extends Omit<
  WorkforceAccountBindingAcceptanceCommand,
  "subject"
> {
  readonly subjectHash: SelectorHash;
}
export type WorkforceAccountBindingAnyOriginal =
  WorkforceAccountBindingOriginal | WorkforceAccountBindingAcceptanceOriginal;
export interface WorkforceAccountBindingOriginal extends Omit<
  WorkforceAccountBindingCommand,
  "subject"
> {
  readonly subjectHash: SelectorHash;
}
export interface WorkforceAccountBinding {
  readonly profile: "WorkforceAccountBindingV1";
  readonly actorReference: string;
  readonly configuration: WorkforceAccountBindingConfiguration;
  readonly subjectHash: SelectorHash;
  readonly encryptedSubject: EncryptedSecretEnvelope;
  readonly invitationReference: string;
  readonly originalMembershipReference: string;
  readonly providerEvidenceReference: string;
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly originalCommand: WorkforceAccountBindingAnyOriginal;
  readonly recordedByReference: string;
  readonly approvedByReference: string;
  readonly approvalEvidenceReference: string;
  readonly reasonCode: string;
  readonly auditReference: string;
  readonly recordedAt: string;
  readonly sourceDigest: string;
  readonly classification: "RestrictedSecurity";
}
export interface WorkforceAccountBindingCodec {
  canonicalize(value: unknown): string;
  hash(value: string): string;
}
export class WorkforceAccountBindingError extends Error {
  readonly code:
    | "WORKFORCE_ACCOUNT_BINDING_INVALID"
    | "WORKFORCE_ACCOUNT_BINDING_DENIED"
    | "WORKFORCE_ACCOUNT_BINDING_UNAVAILABLE"
    | "WORKFORCE_ACCOUNT_BINDING_CONFLICT"
    | "WORKFORCE_ACCOUNT_BINDING_INTENT_CONFLICT";
  constructor(code: WorkforceAccountBindingError["code"] = "WORKFORCE_ACCOUNT_BINDING_INVALID") {
    super("Workforce account binding is unavailable");
    this.name = "WorkforceAccountBindingError";
    this.code = code;
  }
}
export const workforceAccountBindingFail = (code?: WorkforceAccountBindingError["code"]): never => {
  throw new WorkforceAccountBindingError(code);
};
export function workforceAccountBindingClosed(value: unknown, keys: readonly string[]) {
  try {
    return readClosedRecord(value, keys);
  } catch {
    return workforceAccountBindingFail();
  }
}
export function parseWorkforceAccountBindingReference(value: unknown): string {
  try {
    return parseOpaqueUuidV7(value, "ACTOR_REFERENCE_INVALID");
  } catch {
    return workforceAccountBindingFail();
  }
}
export function parseWorkforceAccountBindingInstant(value: unknown): string {
  try {
    const at = parseCanonicalInstant(value);
    if (at.startsWith("0000-")) return workforceAccountBindingFail();
    return at;
  } catch {
    return workforceAccountBindingFail();
  }
}
export function parseWorkforceAccountBindingSubject(value: unknown): string {
  try {
    return parsePlatformActorDirectorySubject(value);
  } catch {
    return workforceAccountBindingFail();
  }
}
export function parseWorkforceAccountBindingConfiguration(
  value: unknown,
): WorkforceAccountBindingConfiguration {
  try {
    return parsePlatformActorDirectoryConfiguration(value);
  } catch {
    return workforceAccountBindingFail();
  }
}
const digest = (value: unknown): string => {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value))
    return workforceAccountBindingFail();
  return value;
};
const commandKeys = [
  "profile",
  "operationReference",
  "actorReference",
  "subject",
  "invitationReference",
  "originalMembershipReference",
  "providerEvidenceReference",
  "recordedByReference",
  "approvedByReference",
  "approvalEvidenceReference",
  "reasonCode",
] as const;
function commandBody(r: Readonly<Record<string, unknown>>) {
  if (
    r.profile !== "WorkforceAccountBindingImportV1" ||
    typeof r.reasonCode !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,127}$/u.test(r.reasonCode)
  )
    return workforceAccountBindingFail();
  const recordedByReference = parseWorkforceAccountBindingReference(r.recordedByReference),
    approvedByReference = parseWorkforceAccountBindingReference(r.approvedByReference);
  if (recordedByReference === approvedByReference) return workforceAccountBindingFail();
  return {
    profile: "WorkforceAccountBindingImportV1" as const,
    operationReference: parseWorkforceAccountBindingReference(r.operationReference),
    actorReference: parseWorkforceAccountBindingReference(r.actorReference),
    invitationReference: parseWorkforceAccountBindingReference(r.invitationReference),
    originalMembershipReference: parseWorkforceAccountBindingReference(
      r.originalMembershipReference,
    ),
    providerEvidenceReference: parseWorkforceAccountBindingReference(r.providerEvidenceReference),
    recordedByReference,
    approvedByReference,
    approvalEvidenceReference: parseWorkforceAccountBindingReference(r.approvalEvidenceReference),
    reasonCode: r.reasonCode,
  };
}
export function parseWorkforceAccountBindingCommand(
  value: unknown,
): WorkforceAccountBindingCommand {
  const r = workforceAccountBindingClosed(value, commandKeys);
  return Object.freeze({
    ...commandBody(r),
    subject: parseWorkforceAccountBindingSubject(r.subject),
  });
}
export function parseWorkforceAccountBindingOriginal(
  value: unknown,
): WorkforceAccountBindingOriginal {
  const r = workforceAccountBindingClosed(
    value,
    commandKeys.map((k) => (k === "subject" ? "subjectHash" : k)),
  );
  return Object.freeze({ ...commandBody(r), subjectHash: parseSelectorHash(r.subjectHash) });
}
export function parseWorkforceAccountBindingAcceptanceCommand(
  value: unknown,
): WorkforceAccountBindingAcceptanceCommand {
  const r = workforceAccountBindingClosed(value, commandKeys);
  if (r.profile !== "WorkforceAccountBindingAcceptanceV1") return workforceAccountBindingFail();
  const parsed = parseWorkforceAccountBindingCommand({
    ...r,
    profile: "WorkforceAccountBindingImportV1",
  });
  if (parsed.recordedByReference !== parsed.actorReference) return workforceAccountBindingFail();
  return Object.freeze({ ...parsed, profile: "WorkforceAccountBindingAcceptanceV1" });
}
export function parseWorkforceAccountBindingAcceptanceOriginal(
  value: unknown,
): WorkforceAccountBindingAcceptanceOriginal {
  const r = workforceAccountBindingClosed(
    value,
    commandKeys.map((k) => (k === "subject" ? "subjectHash" : k)),
  );
  if (r.profile !== "WorkforceAccountBindingAcceptanceV1") return workforceAccountBindingFail();
  const parsed = parseWorkforceAccountBindingOriginal({
    ...r,
    profile: "WorkforceAccountBindingImportV1",
  });
  if (parsed.recordedByReference !== parsed.actorReference) return workforceAccountBindingFail();
  return Object.freeze({ ...parsed, profile: "WorkforceAccountBindingAcceptanceV1" });
}
function parseAnyOriginal(value: unknown): WorkforceAccountBindingAnyOriginal {
  const r = workforceAccountBindingClosed(
    value,
    commandKeys.map((k) => (k === "subject" ? "subjectHash" : k)),
  );
  return r.profile === "WorkforceAccountBindingAcceptanceV1"
    ? parseWorkforceAccountBindingAcceptanceOriginal(r)
    : parseWorkforceAccountBindingOriginal(r);
}
export function workforceAccountBindingAcceptanceOriginal(
  command: WorkforceAccountBindingAcceptanceCommand,
  subjectHash: SelectorHash,
): WorkforceAccountBindingAcceptanceOriginal {
  const { subject, ...rest } = parseWorkforceAccountBindingAcceptanceCommand(command);
  void subject;
  return parseWorkforceAccountBindingAcceptanceOriginal({ ...rest, subjectHash });
}
export function workforceAccountBindingOriginal(
  command: WorkforceAccountBindingCommand,
  subjectHash: SelectorHash,
): WorkforceAccountBindingOriginal {
  const parsed = parseWorkforceAccountBindingCommand(command);
  const { subject, ...rest } = parsed;
  void subject;
  return parseWorkforceAccountBindingOriginal({ ...rest, subjectHash });
}
export function workforceAccountBindingIntent(
  configuration: WorkforceAccountBindingConfiguration,
  original: WorkforceAccountBindingAnyOriginal,
  codec: WorkforceAccountBindingCodec,
): string {
  return digest(
    `sha256:${codec.hash(codec.canonicalize({ configuration: parseWorkforceAccountBindingConfiguration(configuration), originalCommand: parseAnyOriginal(original) }))}`,
  );
}
export function workforceAccountSubjectContext(
  config: WorkforceAccountBindingConfiguration,
  actor: string,
): string {
  const c = parseWorkforceAccountBindingConfiguration(config);
  return `${c.environment}:workforce-account-subject:${parseWorkforceAccountBindingReference(actor)}:${c.issuer}`;
}
export function parseWorkforceAccountBinding(
  value: unknown,
  codec: WorkforceAccountBindingCodec,
): WorkforceAccountBinding {
  const r = workforceAccountBindingClosed(value, [
    "profile",
    "actorReference",
    "configuration",
    "subjectHash",
    "encryptedSubject",
    "invitationReference",
    "originalMembershipReference",
    "providerEvidenceReference",
    "operationReference",
    "intentDigest",
    "originalCommand",
    "recordedByReference",
    "approvedByReference",
    "approvalEvidenceReference",
    "reasonCode",
    "auditReference",
    "recordedAt",
    "sourceDigest",
    "classification",
  ]);
  const configuration = parseWorkforceAccountBindingConfiguration(r.configuration),
    original = parseAnyOriginal(r.originalCommand),
    actorReference = parseWorkforceAccountBindingReference(r.actorReference),
    e = workforceAccountBindingClosed(r.encryptedSubject, [
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
    e.encryptionContext !== workforceAccountSubjectContext(configuration, actorReference)
  )
    return workforceAccountBindingFail();
  const body = {
    profile: "WorkforceAccountBindingV1" as const,
    actorReference,
    configuration,
    subjectHash: parseSelectorHash(r.subjectHash),
    encryptedSubject: Object.freeze({
      algorithm: e.algorithm,
      keyReference: e.keyReference,
      ciphertext: e.ciphertext,
      encryptionContext: e.encryptionContext,
    }),
    invitationReference: parseWorkforceAccountBindingReference(r.invitationReference),
    originalMembershipReference: parseWorkforceAccountBindingReference(
      r.originalMembershipReference,
    ),
    providerEvidenceReference: parseWorkforceAccountBindingReference(r.providerEvidenceReference),
    operationReference: parseWorkforceAccountBindingReference(r.operationReference),
    intentDigest: digest(r.intentDigest),
    originalCommand: original,
    recordedByReference: parseWorkforceAccountBindingReference(r.recordedByReference),
    approvedByReference: parseWorkforceAccountBindingReference(r.approvedByReference),
    approvalEvidenceReference: parseWorkforceAccountBindingReference(r.approvalEvidenceReference),
    reasonCode: original.reasonCode,
    auditReference: parseWorkforceAccountBindingReference(r.auditReference),
    recordedAt: parseWorkforceAccountBindingInstant(r.recordedAt),
    classification: "RestrictedSecurity" as const,
  };
  if (
    r.profile !== body.profile ||
    r.classification !== body.classification ||
    r.reasonCode !== body.reasonCode ||
    body.intentDigest !== workforceAccountBindingIntent(configuration, original, codec) ||
    body.subjectHash !== original.subjectHash ||
    [
      "actorReference",
      "invitationReference",
      "originalMembershipReference",
      "providerEvidenceReference",
      "operationReference",
      "recordedByReference",
      "approvedByReference",
      "approvalEvidenceReference",
    ].some((k) => r[k] !== original[k as keyof WorkforceAccountBindingAnyOriginal]) ||
    digest(r.sourceDigest) !== `sha256:${codec.hash(codec.canonicalize(body))}`
  )
    return workforceAccountBindingFail();
  return Object.freeze({ ...body, sourceDigest: digest(r.sourceDigest) });
}
export function buildWorkforceAccountBinding(
  value: Omit<WorkforceAccountBinding, "sourceDigest">,
  codec: WorkforceAccountBindingCodec,
): WorkforceAccountBinding {
  return parseWorkforceAccountBinding(
    { ...value, sourceDigest: `sha256:${codec.hash(codec.canonicalize(value))}` },
    codec,
  );
}
