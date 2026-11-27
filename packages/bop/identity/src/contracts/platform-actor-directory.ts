import { parseCanonicalInstant, parseOpaqueUuidV7, readClosedRecord } from "./identity-actor.js";
import {
  parseSelectorHash,
  type EncryptedSecretEnvelope,
  type SelectorHash,
} from "./browser-session.js";
export const platformActorDirectoryPurpose = "PLATFORM_ACTOR_DIRECTORY" as const;
export const platformActorDirectoryOperations = [
  "ImportActive",
  "Suspend",
  "Disable",
  "Restore",
] as const;
export type PlatformActorDirectoryOperation = (typeof platformActorDirectoryOperations)[number];
export interface PlatformActorDirectoryConfiguration {
  readonly environment: string;
  readonly issuer: string;
  readonly clientIds: readonly string[];
}
export interface PlatformActorDirectoryHead {
  readonly revisionReference: string;
  readonly version: number;
  readonly sourceDigest: string;
}
export interface PlatformActorDirectoryCommand {
  readonly profile: "PlatformActorDirectoryCommandV1";
  readonly operation: PlatformActorDirectoryOperation;
  readonly operationReference: string;
  readonly actorReference: string;
  readonly expectedHead: PlatformActorDirectoryHead | null;
  readonly subject: string | null;
  readonly recordedByReference: string;
  readonly approvedByReference: string;
  readonly approvalReference: string;
  readonly reasonCode: string;
}
export interface PlatformActorDirectoryOriginal extends Omit<
  PlatformActorDirectoryCommand,
  "subject"
> {
  readonly subjectHash: SelectorHash;
}
export interface PlatformActorDirectoryRevision {
  readonly profile: "PlatformActorDirectoryRevisionV1";
  readonly actorReference: string;
  readonly configuration: PlatformActorDirectoryConfiguration;
  readonly subjectHash: SelectorHash;
  readonly encryptedSubject: EncryptedSecretEnvelope;
  readonly revisionReference: string;
  readonly version: number;
  readonly supersedesRevisionReference: string | null;
  readonly status: "Active" | "Suspended" | "Disabled";
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly originalCommand: PlatformActorDirectoryOriginal;
  readonly recordedByReference: string;
  readonly approvedByReference: string;
  readonly approvalReference: string;
  readonly reasonCode: string;
  readonly auditReference: string;
  readonly recordedAt: string;
  readonly sourceDigest: string;
  readonly classification: "RestrictedSecurity";
}
export interface PlatformActorDirectoryCodec {
  canonicalize(value: unknown): string;
  hash(value: string): string;
}
export interface PlatformActorDirectoryProviderObservation {
  readonly issuer: string;
  readonly subject: string;
  readonly status: "Enabled" | "Disabled";
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface PlatformActorDirectorySubjectRequest {
  readonly issuer: string;
  readonly clientId: string;
  readonly subject: string;
  readonly authenticatedAt: string;
  readonly observedAt: string;
}
export class PlatformActorDirectoryError extends Error {
  readonly code:
    | "PLATFORM_ACTOR_DIRECTORY_INVALID"
    | "PLATFORM_ACTOR_DIRECTORY_DENIED"
    | "PLATFORM_ACTOR_DIRECTORY_UNAVAILABLE"
    | "PLATFORM_ACTOR_DIRECTORY_VERSION_CONFLICT"
    | "PLATFORM_ACTOR_DIRECTORY_INTENT_CONFLICT";
  constructor(code: PlatformActorDirectoryError["code"] = "PLATFORM_ACTOR_DIRECTORY_INVALID") {
    super("Platform identity directory is unavailable");
    this.name = "PlatformActorDirectoryError";
    this.code = code;
  }
}
export const platformActorDirectoryFail = (code?: PlatformActorDirectoryError["code"]): never => {
  throw new PlatformActorDirectoryError(code);
};
export const platformActorDirectoryClosed = (value: unknown, keys: readonly string[]) => {
  try {
    return readClosedRecord(value, keys);
  } catch {
    return platformActorDirectoryFail();
  }
};
export const parsePlatformActorDirectoryReference = (value: unknown): string => {
  try {
    return parseOpaqueUuidV7(value, "ACTOR_REFERENCE_INVALID");
  } catch {
    return platformActorDirectoryFail();
  }
};
export const parsePlatformActorDirectoryInstant = (value: unknown): string => {
  try {
    const result = parseCanonicalInstant(value);
    if (result.startsWith("0000-")) return platformActorDirectoryFail();
    return result;
  } catch {
    return platformActorDirectoryFail();
  }
};
export const parsePlatformActorDirectorySubject = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    /[^\x21-\x7e]/u.test(value) ||
    value.includes("@")
  )
    return platformActorDirectoryFail();
  return value;
};
const hash = (value: unknown): string => {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value))
    return platformActorDirectoryFail();
  return value;
};
const version = (value: unknown): number => {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 2147483647)
    return platformActorDirectoryFail();
  return value as number;
};
function clients(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > 8 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return platformActorDirectoryFail();
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (
      !d?.enumerable ||
      !("value" in d) ||
      typeof d.value !== "string" ||
      !/^[a-zA-Z0-9]{1,128}$/u.test(d.value) ||
      result.includes(d.value)
    )
      return platformActorDirectoryFail();
    result.push(d.value);
  }
  return Object.freeze(result.sort());
}
export function parsePlatformActorDirectoryConfiguration(
  value: unknown,
): PlatformActorDirectoryConfiguration {
  const r = platformActorDirectoryClosed(value, ["environment", "issuer", "clientIds"]);
  if (
    typeof r.environment !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/u.test(r.environment) ||
    typeof r.issuer !== "string" ||
    !/^https:\/\/cognito-idp\.ca-central-1\.amazonaws\.com\/ca-central-1_[A-Za-z0-9]{1,42}$/u.test(
      r.issuer,
    )
  )
    return platformActorDirectoryFail();
  return Object.freeze({
    environment: r.environment,
    issuer: r.issuer,
    clientIds: clients(r.clientIds),
  });
}
export function platformActorSubjectContext(
  config: PlatformActorDirectoryConfiguration,
  actor: string,
): string {
  return `${config.environment}:platform-actor-subject:${actor}:${config.issuer}`;
}
export function parsePlatformActorDirectoryHead(value: unknown): PlatformActorDirectoryHead {
  const r = platformActorDirectoryClosed(value, ["revisionReference", "version", "sourceDigest"]);
  return Object.freeze({
    revisionReference: parsePlatformActorDirectoryReference(r.revisionReference),
    version: version(r.version),
    sourceDigest: hash(r.sourceDigest),
  });
}
export function parsePlatformActorDirectoryCommand(value: unknown): PlatformActorDirectoryCommand {
  const r = platformActorDirectoryClosed(value, [
    "profile",
    "operation",
    "operationReference",
    "actorReference",
    "expectedHead",
    "subject",
    "recordedByReference",
    "approvedByReference",
    "approvalReference",
    "reasonCode",
  ]);
  if (
    r.profile !== "PlatformActorDirectoryCommandV1" ||
    !platformActorDirectoryOperations.includes(r.operation as PlatformActorDirectoryOperation) ||
    typeof r.reasonCode !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,127}$/u.test(r.reasonCode)
  )
    return platformActorDirectoryFail();
  const operation = r.operation as PlatformActorDirectoryOperation,
    recordedByReference = parsePlatformActorDirectoryReference(r.recordedByReference),
    approvedByReference = parsePlatformActorDirectoryReference(r.approvedByReference);
  if (
    recordedByReference === approvedByReference ||
    (operation === "ImportActive") !== (r.expectedHead === null) ||
    (operation === "ImportActive") !== (r.subject !== null)
  )
    return platformActorDirectoryFail();
  return Object.freeze({
    profile: "PlatformActorDirectoryCommandV1",
    operation,
    operationReference: parsePlatformActorDirectoryReference(r.operationReference),
    actorReference: parsePlatformActorDirectoryReference(r.actorReference),
    expectedHead: r.expectedHead === null ? null : parsePlatformActorDirectoryHead(r.expectedHead),
    subject: r.subject === null ? null : parsePlatformActorDirectorySubject(r.subject),
    recordedByReference,
    approvedByReference,
    approvalReference: parsePlatformActorDirectoryReference(r.approvalReference),
    reasonCode: r.reasonCode,
  });
}
export function parsePlatformActorDirectoryOriginal(
  value: unknown,
): PlatformActorDirectoryOriginal {
  const r = platformActorDirectoryClosed(value, [
    "profile",
    "operation",
    "operationReference",
    "actorReference",
    "expectedHead",
    "subjectHash",
    "recordedByReference",
    "approvedByReference",
    "approvalReference",
    "reasonCode",
  ]);
  if (
    r.profile !== "PlatformActorDirectoryCommandV1" ||
    !platformActorDirectoryOperations.includes(r.operation as PlatformActorDirectoryOperation) ||
    typeof r.reasonCode !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,127}$/u.test(r.reasonCode) ||
    (r.operation === "ImportActive") !== (r.expectedHead === null)
  )
    return platformActorDirectoryFail();
  const recordedByReference = parsePlatformActorDirectoryReference(r.recordedByReference),
    approvedByReference = parsePlatformActorDirectoryReference(r.approvedByReference);
  if (recordedByReference === approvedByReference) return platformActorDirectoryFail();
  return Object.freeze({
    profile: "PlatformActorDirectoryCommandV1",
    operation: r.operation as PlatformActorDirectoryOperation,
    operationReference: parsePlatformActorDirectoryReference(r.operationReference),
    actorReference: parsePlatformActorDirectoryReference(r.actorReference),
    expectedHead: r.expectedHead === null ? null : parsePlatformActorDirectoryHead(r.expectedHead),
    subjectHash: parseSelectorHash(r.subjectHash),
    recordedByReference,
    approvedByReference,
    approvalReference: parsePlatformActorDirectoryReference(r.approvalReference),
    reasonCode: r.reasonCode,
  });
}
export function platformActorDirectoryOriginal(
  command: PlatformActorDirectoryCommand,
  subjectHash: SelectorHash,
): PlatformActorDirectoryOriginal {
  const { subject, ...rest } = command;
  void subject;
  return Object.freeze({ ...rest, subjectHash: parseSelectorHash(subjectHash) });
}
export const platformActorDirectoryIntent = (
  original: PlatformActorDirectoryOriginal,
  codec: PlatformActorDirectoryCodec,
): string => `sha256:${codec.hash(codec.canonicalize(original))}`;
export function parsePlatformActorDirectoryRevision(
  value: unknown,
  codec: PlatformActorDirectoryCodec,
): PlatformActorDirectoryRevision {
  const r = platformActorDirectoryClosed(value, [
    "profile",
    "actorReference",
    "configuration",
    "subjectHash",
    "encryptedSubject",
    "revisionReference",
    "version",
    "supersedesRevisionReference",
    "status",
    "operationReference",
    "intentDigest",
    "originalCommand",
    "recordedByReference",
    "approvedByReference",
    "approvalReference",
    "reasonCode",
    "auditReference",
    "recordedAt",
    "sourceDigest",
    "classification",
  ]);
  const original = parsePlatformActorDirectoryOriginal(r.originalCommand),
    command = original;
  const configuration = parsePlatformActorDirectoryConfiguration(r.configuration),
    actorReference = parsePlatformActorDirectoryReference(r.actorReference),
    e = platformActorDirectoryClosed(r.encryptedSubject, [
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
    !/^[a-zA-Z0-9_-]+$/u.test(e.ciphertext) ||
    e.ciphertext.length < 39 ||
    e.ciphertext.length > 2048 ||
    e.encryptionContext !== platformActorSubjectContext(configuration, actorReference)
  )
    return platformActorDirectoryFail();
  const encryptedSubject: EncryptedSecretEnvelope = Object.freeze({
    algorithm: e.algorithm,
    keyReference: e.keyReference,
    ciphertext: e.ciphertext,
    encryptionContext: e.encryptionContext,
  });
  const parsed = {
    profile: "PlatformActorDirectoryRevisionV1" as const,
    actorReference,
    configuration,
    subjectHash: parseSelectorHash(r.subjectHash),
    encryptedSubject,
    revisionReference: parsePlatformActorDirectoryReference(r.revisionReference),
    version: version(r.version),
    supersedesRevisionReference:
      r.supersedesRevisionReference === null
        ? null
        : parsePlatformActorDirectoryReference(r.supersedesRevisionReference),
    status: r.status as PlatformActorDirectoryRevision["status"],
    operationReference: parsePlatformActorDirectoryReference(r.operationReference),
    intentDigest: hash(r.intentDigest),
    originalCommand: original,
    recordedByReference: parsePlatformActorDirectoryReference(r.recordedByReference),
    approvedByReference: parsePlatformActorDirectoryReference(r.approvedByReference),
    approvalReference: parsePlatformActorDirectoryReference(r.approvalReference),
    reasonCode: command.reasonCode,
    auditReference: parsePlatformActorDirectoryReference(r.auditReference),
    recordedAt: parsePlatformActorDirectoryInstant(r.recordedAt),
    classification: "RestrictedSecurity" as const,
  };
  const expected =
    command.operation === "Suspend"
      ? "Suspended"
      : command.operation === "Disable"
        ? "Disabled"
        : "Active";
  if (
    r.profile !== parsed.profile ||
    r.classification !== parsed.classification ||
    r.status !== expected ||
    r.reasonCode !== parsed.reasonCode ||
    actorReference !== command.actorReference ||
    parsed.subjectHash !== original.subjectHash ||
    parsed.operationReference !== command.operationReference ||
    parsed.recordedByReference !== command.recordedByReference ||
    parsed.approvedByReference !== command.approvedByReference ||
    parsed.approvalReference !== command.approvalReference ||
    parsed.version !== (command.expectedHead?.version ?? 0) + 1 ||
    parsed.supersedesRevisionReference !== (command.expectedHead?.revisionReference ?? null) ||
    parsed.intentDigest !== platformActorDirectoryIntent(original, codec) ||
    hash(r.sourceDigest) !== `sha256:${codec.hash(codec.canonicalize(parsed))}`
  )
    return platformActorDirectoryFail();
  return Object.freeze({ ...parsed, sourceDigest: r.sourceDigest as string });
}
export function buildPlatformActorDirectoryRevision(
  value: Omit<PlatformActorDirectoryRevision, "sourceDigest">,
  codec: PlatformActorDirectoryCodec,
): PlatformActorDirectoryRevision {
  return parsePlatformActorDirectoryRevision(
    { ...value, sourceDigest: `sha256:${codec.hash(codec.canonicalize(value))}` },
    codec,
  );
}
