import {
  parseCanonicalInstant,
  type BrandReference,
  type CanonicalInstant,
  type StoreReference,
  type TenantScopeKind,
} from "@bop/tenant";

export type MediaReferenceId = string & { readonly __mediaReferenceId: unique symbol };
export type AssetReference = string & { readonly __assetReference: unique symbol };
export type AssetVersionReference = string & { readonly __assetVersionReference: unique symbol };
export type UploadSessionReference = string & { readonly __uploadSessionReference: unique symbol };
export type UploadGrantReference = string & { readonly __uploadGrantReference: unique symbol };
export type ObjectEvidenceReference = string & {
  readonly __objectEvidenceReference: unique symbol;
};
export type MediaPurposeCode = string & { readonly __mediaPurposeCode: unique symbol };
export type MediaOwnerType = string & { readonly __mediaOwnerType: unique symbol };
export type MediaChecksum = string & { readonly __mediaChecksum: unique symbol };
export type MediaIdempotencyKey = string & { readonly __mediaIdempotencyKey: unique symbol };
export type MediaVersion = number & { readonly __mediaVersion: unique symbol };

export const mediaKinds = ["Image", "Video"] as const;
export type MediaKind = (typeof mediaKinds)[number];
export const mediaClassifications = ["Public", "Internal", "Confidential", "Restricted"] as const;
export type MediaClassification = (typeof mediaClassifications)[number];
export const uploadSessionStates = ["Pending", "Finalized", "Expired", "Rejected"] as const;
export type UploadSessionState = (typeof uploadSessionStates)[number];
export const mediaCheckStates = ["Quarantined", "Clean", "Rejected", "ProcessingFailed"] as const;
export type MediaCheckState = (typeof mediaCheckStates)[number];
export const mediaReadinessStates = ["Pending", "Ready", "Failed"] as const;
export type MediaReadinessState = (typeof mediaReadinessStates)[number];
export const mediaReferenceKinds = ["Dynamic", "Pinned"] as const;
export type MediaReferenceKind = (typeof mediaReferenceKinds)[number];
export const mediaUseKinds = [
  "Draft",
  "Published",
  "Transaction",
  "Evidence",
  "Compliance",
] as const;
export type MediaUseKind = (typeof mediaUseKinds)[number];

export interface MediaScope {
  readonly kind: TenantScopeKind;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference | null;
}

export interface UploadSession {
  readonly uploadSessionId: UploadSessionReference;
  readonly grantReference: UploadGrantReference;
  readonly actorReference: string;
  readonly purpose: MediaPurposeCode;
  readonly scope: MediaScope;
  readonly mediaKind: MediaKind;
  readonly declaredContentType: string;
  readonly declaredByteSize: number;
  readonly ownerType: MediaOwnerType;
  readonly ownerReference: MediaReferenceId;
  readonly classification: MediaClassification;
  readonly state: UploadSessionState;
  readonly version: MediaVersion;
  readonly createdAt: CanonicalInstant;
  readonly expiresAt: CanonicalInstant;
}

export interface MediaAsset {
  readonly assetId: AssetReference;
  readonly purpose: MediaPurposeCode;
  readonly scope: MediaScope;
  readonly mediaKind: MediaKind;
  readonly ownerType: MediaOwnerType;
  readonly ownerReference: MediaReferenceId;
  readonly classification: MediaClassification;
  readonly currentVersionReference: AssetVersionReference | null;
  readonly version: MediaVersion;
}

export interface MediaAssetVersion {
  readonly assetVersionId: AssetVersionReference;
  readonly assetId: AssetReference;
  readonly version: MediaVersion;
  readonly objectEvidenceReference: ObjectEvidenceReference;
  readonly providerObjectVersion: MediaReferenceId;
  readonly byteSize: number;
  readonly checksum: MediaChecksum;
  readonly contentType: string;
  readonly checkState: MediaCheckState;
  readonly readinessState: MediaReadinessState;
  readonly createdAt: CanonicalInstant;
}

export interface MediaReference {
  readonly kind: MediaReferenceKind;
  readonly assetId: AssetReference;
  readonly assetVersionId: AssetVersionReference | null;
}

export const mediaContractErrorCodes = [
  "MEDIA_INPUT_INVALID",
  "MEDIA_SCOPE_INVALID",
  "MEDIA_SESSION_INVALID",
  "MEDIA_ASSET_INVALID",
  "MEDIA_REFERENCE_INVALID",
] as const;
export type MediaContractErrorCode = (typeof mediaContractErrorCodes)[number];

export class MediaContractError extends Error {
  readonly code: MediaContractErrorCode;
  constructor(code: MediaContractErrorCode) {
    super("media contract input is invalid");
    this.name = "MediaContractError";
    this.code = code;
  }
}

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const code = /^[A-Z][A-Z0-9_]{2,63}$/u;
const ownerType = /^[A-Z][A-Z0-9_]{2,31}$/u;
const contentType = /^(?:image|video)\/[a-z0-9][a-z0-9.+-]{0,63}$/u;
const checksum = /^sha256:[0-9a-f]{64}$/u;

function exactPlainObject(value: object, fields: readonly string[]): void {
  if (Object.getPrototypeOf(value) !== Object.prototype)
    throw new MediaContractError("MEDIA_INPUT_INVALID");
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
    throw new MediaContractError("MEDIA_INPUT_INVALID");
}

function uuid(value: unknown, error: MediaContractErrorCode = "MEDIA_INPUT_INVALID"): string {
  if (typeof value !== "string" || !uuidV7.test(value)) throw new MediaContractError(error);
  return value;
}

export function parseAssetReference(value: unknown): AssetReference {
  return uuid(value) as AssetReference;
}
export function parseAssetVersionReference(value: unknown): AssetVersionReference {
  return uuid(value) as AssetVersionReference;
}
export function parseUploadSessionReference(value: unknown): UploadSessionReference {
  return uuid(value) as UploadSessionReference;
}
export function parseMediaReferenceId(value: unknown): MediaReferenceId {
  return uuid(value) as MediaReferenceId;
}
export function parseUploadGrantReference(value: unknown): UploadGrantReference {
  return uuid(value) as UploadGrantReference;
}
export function parseObjectEvidenceReference(value: unknown): ObjectEvidenceReference {
  return uuid(value) as ObjectEvidenceReference;
}
export function parseMediaIdempotencyKey(value: unknown): MediaIdempotencyKey {
  return uuid(value) as MediaIdempotencyKey;
}
export function parseMediaVersion(value: unknown): MediaVersion {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new MediaContractError("MEDIA_INPUT_INVALID");
  return value as MediaVersion;
}
export function parseMediaPurposeCode(value: unknown): MediaPurposeCode {
  if (typeof value !== "string" || !code.test(value))
    throw new MediaContractError("MEDIA_INPUT_INVALID");
  return value as MediaPurposeCode;
}
export function parseMediaOwnerType(value: unknown): MediaOwnerType {
  if (typeof value !== "string" || !ownerType.test(value))
    throw new MediaContractError("MEDIA_INPUT_INVALID");
  return value as MediaOwnerType;
}
export function parseMediaChecksum(value: unknown): MediaChecksum {
  if (typeof value !== "string" || !checksum.test(value))
    throw new MediaContractError("MEDIA_INPUT_INVALID");
  return value as MediaChecksum;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

export function createMediaScope(input: MediaScope): MediaScope {
  exactPlainObject(input, ["kind", "brandReference", "storeReference"]);
  const brandReference = uuid(input.brandReference, "MEDIA_SCOPE_INVALID") as BrandReference;
  const storeReference =
    input.storeReference === null
      ? null
      : (uuid(input.storeReference, "MEDIA_SCOPE_INVALID") as StoreReference);
  if (
    (input.kind !== "Brand" && input.kind !== "Store") ||
    (input.kind === "Brand" && storeReference !== null) ||
    (input.kind === "Store" && storeReference === null)
  )
    throw new MediaContractError("MEDIA_SCOPE_INVALID");
  return Object.freeze({ kind: input.kind, brandReference, storeReference });
}

function instant(value: unknown): CanonicalInstant {
  try {
    return parseCanonicalInstant(value);
  } catch {
    throw new MediaContractError("MEDIA_INPUT_INVALID");
  }
}

export function parseMediaInstant(value: unknown): CanonicalInstant {
  return instant(value);
}

function metadata(input: {
  mediaKind: unknown;
  declaredContentType: unknown;
  declaredByteSize: unknown;
  classification: unknown;
}): void {
  if (
    !oneOf(input.mediaKind, mediaKinds) ||
    typeof input.declaredContentType !== "string" ||
    !contentType.test(input.declaredContentType) ||
    !input.declaredContentType.startsWith(input.mediaKind === "Image" ? "image/" : "video/") ||
    !Number.isSafeInteger(input.declaredByteSize) ||
    (input.declaredByteSize as number) < 1 ||
    (input.declaredByteSize as number) > 100_000_000 ||
    !oneOf(input.classification, mediaClassifications)
  )
    throw new MediaContractError("MEDIA_INPUT_INVALID");
}

export function createUploadSession(input: UploadSession): UploadSession {
  exactPlainObject(input, [
    "uploadSessionId",
    "grantReference",
    "actorReference",
    "purpose",
    "scope",
    "mediaKind",
    "declaredContentType",
    "declaredByteSize",
    "ownerType",
    "ownerReference",
    "classification",
    "state",
    "version",
    "createdAt",
    "expiresAt",
  ]);
  metadata(input);
  const createdAt = instant(input.createdAt);
  const expiresAt = instant(input.expiresAt);
  const lifetime = Date.parse(expiresAt) - Date.parse(createdAt);
  if (
    !oneOf(input.state, uploadSessionStates) ||
    typeof input.actorReference !== "string" ||
    !uuidV7.test(input.actorReference) ||
    lifetime <= 0 ||
    lifetime > 15 * 60_000
  )
    throw new MediaContractError("MEDIA_SESSION_INVALID");
  return Object.freeze({
    uploadSessionId: parseUploadSessionReference(input.uploadSessionId),
    grantReference: parseUploadGrantReference(input.grantReference),
    actorReference: input.actorReference,
    purpose: parseMediaPurposeCode(input.purpose),
    scope: createMediaScope(input.scope),
    mediaKind: input.mediaKind,
    declaredContentType: input.declaredContentType,
    declaredByteSize: input.declaredByteSize,
    ownerType: parseMediaOwnerType(input.ownerType),
    ownerReference: parseMediaReferenceId(input.ownerReference),
    classification: input.classification,
    state: input.state,
    version: parseMediaVersion(input.version),
    createdAt,
    expiresAt,
  });
}

export function createMediaAsset(input: MediaAsset): MediaAsset {
  exactPlainObject(input, [
    "assetId",
    "purpose",
    "scope",
    "mediaKind",
    "ownerType",
    "ownerReference",
    "classification",
    "currentVersionReference",
    "version",
  ]);
  if (!oneOf(input.mediaKind, mediaKinds) || !oneOf(input.classification, mediaClassifications))
    throw new MediaContractError("MEDIA_ASSET_INVALID");
  return Object.freeze({
    assetId: parseAssetReference(input.assetId),
    purpose: parseMediaPurposeCode(input.purpose),
    scope: createMediaScope(input.scope),
    mediaKind: input.mediaKind,
    ownerType: parseMediaOwnerType(input.ownerType),
    ownerReference: parseMediaReferenceId(input.ownerReference),
    classification: input.classification,
    currentVersionReference:
      input.currentVersionReference === null
        ? null
        : parseAssetVersionReference(input.currentVersionReference),
    version: parseMediaVersion(input.version),
  });
}

export function createMediaAssetVersion(input: MediaAssetVersion): MediaAssetVersion {
  exactPlainObject(input, [
    "assetVersionId",
    "assetId",
    "version",
    "objectEvidenceReference",
    "providerObjectVersion",
    "byteSize",
    "checksum",
    "contentType",
    "checkState",
    "readinessState",
    "createdAt",
  ]);
  if (
    !oneOf(input.checkState, mediaCheckStates) ||
    !oneOf(input.readinessState, mediaReadinessStates) ||
    typeof input.contentType !== "string" ||
    !contentType.test(input.contentType) ||
    !Number.isSafeInteger(input.byteSize) ||
    input.byteSize < 1 ||
    input.byteSize > 100_000_000
  )
    throw new MediaContractError("MEDIA_ASSET_INVALID");
  return Object.freeze({
    assetVersionId: parseAssetVersionReference(input.assetVersionId),
    assetId: parseAssetReference(input.assetId),
    version: parseMediaVersion(input.version),
    objectEvidenceReference: parseObjectEvidenceReference(input.objectEvidenceReference),
    providerObjectVersion: parseMediaReferenceId(input.providerObjectVersion),
    byteSize: input.byteSize,
    checksum: parseMediaChecksum(input.checksum),
    contentType: input.contentType,
    checkState: input.checkState,
    readinessState: input.readinessState,
    createdAt: instant(input.createdAt),
  });
}

export function createMediaReference(input: MediaReference): MediaReference {
  exactPlainObject(input, ["kind", "assetId", "assetVersionId"]);
  const assetId = parseAssetReference(input.assetId);
  if (
    !oneOf(input.kind, mediaReferenceKinds) ||
    (input.kind === "Dynamic" && input.assetVersionId !== null) ||
    (input.kind === "Pinned" && input.assetVersionId === null)
  )
    throw new MediaContractError("MEDIA_REFERENCE_INVALID");
  return Object.freeze({
    kind: input.kind,
    assetId,
    assetVersionId:
      input.assetVersionId === null ? null : parseAssetVersionReference(input.assetVersionId),
  });
}
