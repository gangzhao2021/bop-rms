import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createMediaAsset,
  createMediaAssetVersion,
  createMediaScope,
  parseAssetReference,
  parseAssetVersionReference,
  parseMediaChecksum,
  parseMediaInstant,
  parseMediaReferenceId,
  parseObjectEvidenceReference,
  type MediaAsset,
  type MediaAssetVersion,
  type MediaScope,
} from "./media.js";
import { copyMediaUploadStorageValue } from "./media-upload-storage.js";

export const mediaPublicationReadFields = Object.freeze([
  "assetIdentity",
  "scope",
  "purpose",
  "owner",
  "classification",
  "pinnedVersion",
  "checkState",
  "readinessState",
  "renditions",
  "processingProvenance",
] as const);
export interface MediaPublicationReference {
  readonly mediaReference: string;
  readonly assetReference: string;
  readonly assetVersionReference: string;
  readonly cropReference: string | null;
  readonly focusReference: string | null;
}
/** The consuming owner verifies its actual full intent. Media binds this exact
 * primitive tuple and never imports or interprets a Catalog command. */
export interface MediaPublicationReadRequest {
  readonly profile: "MediaPublicationReadRequestV1";
  readonly intentKind: "PublicationV2" | "WarningAcknowledgementV1";
  readonly tenantReference: string;
  readonly scope: MediaScope;
  readonly actorReference: string;
  readonly actorKind: "User" | "System";
  readonly operationReference: string;
  readonly originalIntentDigest: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly aggregateSnapshotDigest: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly replacementIntentDigest: string;
  readonly references: readonly MediaPublicationReference[];
  readonly observedAt: string;
  readonly validUntil: string;
}
export type MediaPublicationAsset = Omit<MediaAsset, "version" | "currentVersionReference">;
export interface MediaPublicationRendition {
  readonly contentType: "image/jpeg" | "image/webp";
  readonly width: 320 | 640 | 1280;
  readonly height: number;
  readonly byteSize: number;
  readonly checksum: string;
  readonly objectEvidenceReference: string;
  readonly providerObjectVersion: string;
}
export type MediaPublicationReferenceResult = MediaPublicationReference &
  (
    | {
        readonly status: "Unavailable";
        readonly reason: "NotFound" | "NotReady" | "UnsupportedMedia" | "UnsupportedAdjustment";
      }
    | {
        readonly status: "Ready";
        readonly reason: "Ready";
        readonly asset: MediaPublicationAsset;
        readonly assetVersion: MediaAssetVersion;
        readonly renditions: readonly MediaPublicationRendition[];
        readonly provenanceDigest: string;
      }
  );
export interface MediaPublicationReadSnapshot {
  readonly profile: "MediaPublicationReadSnapshotV1";
  readonly request: MediaPublicationReadRequest;
  readonly references: readonly MediaPublicationReferenceResult[];
  readonly relevantReferenceDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly digest: string;
}
/** Fixed Option Set publication tuple. The consuming Catalog owner proves the
 * complete graph; Media never treats a Product command as an Option Set intent. */
export interface MediaOptionSetPublicationReadRequest {
  readonly profile: "MediaOptionSetPublicationReadRequestV1";
  readonly tenantReference: string;
  readonly scope: MediaScope;
  readonly actorReference: string;
  readonly actorKind: "User";
  readonly operationReference: string;
  readonly originalIntentDigest: string;
  readonly optionSetReference: string;
  readonly versionReference: string;
  readonly expectedAggregateVersion: number;
  readonly sourceDigest: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly graphDigest: string;
  readonly activationAt: string;
  readonly references: readonly MediaPublicationReference[];
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface MediaOptionSetPublicationReadSnapshot {
  readonly profile: "MediaOptionSetPublicationReadSnapshotV1";
  readonly request: MediaOptionSetPublicationReadRequest;
  readonly references: readonly MediaPublicationReferenceResult[];
  readonly relevantReferenceDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly digest: string;
}
export class MediaPublicationReadError extends Error {
  readonly code = "MEDIA_PUBLICATION_READ_UNAVAILABLE";
  constructor() {
    super("Media publication read is unavailable");
    this.name = "MediaPublicationReadError";
  }
}
const fail = (): never => {
  throw new MediaPublicationReadError();
};
const hash = (v: unknown): string =>
  typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v) ? v : fail();
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const digest = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const r: Record<string, unknown> = {};
  for (const key of fields) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    r[key] = d.value;
  }
  return r;
}
const referenceFields = [
  "mediaReference",
  "assetReference",
  "assetVersionReference",
  "cropReference",
  "focusReference",
] as const;
function reference(r: Record<string, unknown>): MediaPublicationReference {
  return Object.freeze({
    mediaReference: parseMediaReferenceId(r.mediaReference),
    assetReference: parseAssetReference(r.assetReference),
    assetVersionReference: parseAssetVersionReference(r.assetVersionReference),
    cropReference: r.cropReference === null ? null : parseMediaReferenceId(r.cropReference),
    focusReference: r.focusReference === null ? null : parseMediaReferenceId(r.focusReference),
  });
}
export function parseMediaPublicationReadRequest(value: unknown): MediaPublicationReadRequest {
  try {
    const r = closed(copyMediaUploadStorageValue(value), [
      "profile",
      "intentKind",
      "tenantReference",
      "scope",
      "actorReference",
      "actorKind",
      "operationReference",
      "originalIntentDigest",
      "productReference",
      "versionReference",
      "aggregateSnapshotDigest",
      "contentDigest",
      "configurationDigest",
      "replacementIntentDigest",
      "references",
      "observedAt",
      "validUntil",
    ]);
    if (
      r.profile !== "MediaPublicationReadRequestV1" ||
      (r.intentKind !== "PublicationV2" && r.intentKind !== "WarningAcknowledgementV1") ||
      (r.actorKind !== "User" && r.actorKind !== "System") ||
      (r.intentKind === "WarningAcknowledgementV1" && r.actorKind !== "User") ||
      !Array.isArray(r.references) ||
      r.references.length > 100
    )
      return fail();
    const observedAt = parseMediaInstant(r.observedAt),
      validUntil = parseMediaInstant(r.validUntil);
    if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 5000)
      return fail();
    const references = r.references
      .map((v) => reference(closed(v, referenceFields)))
      .sort((a, b) => a.mediaReference.localeCompare(b.mediaReference));
    if (new Set(references.map((v) => v.mediaReference)).size !== references.length) return fail();
    return Object.freeze({
      profile: "MediaPublicationReadRequestV1",
      intentKind: r.intentKind as MediaPublicationReadRequest["intentKind"],
      tenantReference: parseMediaReferenceId(r.tenantReference),
      scope: createMediaScope(r.scope as MediaScope),
      actorReference: parseMediaReferenceId(r.actorReference),
      actorKind: r.actorKind,
      operationReference: parseMediaReferenceId(r.operationReference),
      originalIntentDigest: hash(r.originalIntentDigest),
      productReference: parseMediaReferenceId(r.productReference),
      versionReference: parseMediaReferenceId(r.versionReference),
      aggregateSnapshotDigest: hash(r.aggregateSnapshotDigest),
      contentDigest: hash(r.contentDigest),
      configurationDigest: hash(r.configurationDigest),
      replacementIntentDigest: hash(r.replacementIntentDigest),
      references: Object.freeze(references),
      observedAt,
      validUntil,
    });
  } catch {
    return fail();
  }
}
function result(
  value: unknown,
  expected: MediaPublicationReference,
  request: Pick<MediaPublicationReadRequest, "scope">,
): MediaPublicationReferenceResult {
  const status = Object.getOwnPropertyDescriptor(value ?? {}, "status")?.value;
  const r = closed(value, [
      ...referenceFields,
      "status",
      "reason",
      ...(status === "Ready" ? ["asset", "assetVersion", "renditions", "provenanceDigest"] : []),
    ]),
    identity = reference(r);
  if (!equal(identity, expected)) return fail();
  if (status === "Unavailable") {
    if (
      !["NotFound", "NotReady", "UnsupportedMedia", "UnsupportedAdjustment"].includes(
        String(r.reason),
      )
    )
      return fail();
    return Object.freeze({
      ...identity,
      status,
      reason: r.reason as "NotFound" | "NotReady" | "UnsupportedMedia" | "UnsupportedAdjustment",
    });
  }
  if (
    status !== "Ready" ||
    r.reason !== "Ready" ||
    identity.cropReference !== null ||
    identity.focusReference !== null
  )
    return fail();
  const a = closed(r.asset, [
      "assetId",
      "purpose",
      "scope",
      "mediaKind",
      "ownerType",
      "ownerReference",
      "classification",
    ]),
    parsed = createMediaAsset({
      ...a,
      version: 1,
      currentVersionReference: null,
    } as unknown as MediaAsset),
    assetVersion = createMediaAssetVersion(r.assetVersion as MediaAssetVersion);
  if (
    parsed.assetId !== identity.assetReference ||
    !equal(parsed.scope, request.scope) ||
    parsed.mediaKind !== "Image" ||
    assetVersion.assetId !== parsed.assetId ||
    assetVersion.assetVersionId !== identity.assetVersionReference ||
    assetVersion.checkState !== "Clean" ||
    assetVersion.readinessState !== "Ready" ||
    !Array.isArray(r.renditions) ||
    r.renditions.length !== 6
  )
    return fail();
  const renditions = r.renditions.map((v, index): MediaPublicationRendition => {
    const row = closed(v, [
        "contentType",
        "width",
        "height",
        "byteSize",
        "checksum",
        "objectEvidenceReference",
        "providerObjectVersion",
      ]),
      width = index < 2 ? 320 : index < 4 ? 640 : 1280,
      contentType = index % 2 === 0 ? "image/jpeg" : "image/webp";
    if (
      row.width !== width ||
      row.contentType !== contentType ||
      typeof row.height !== "number" ||
      !Number.isSafeInteger(row.height) ||
      row.height < 1 ||
      row.height > 16383 ||
      width * row.height > 25000000 ||
      typeof row.byteSize !== "number" ||
      !Number.isSafeInteger(row.byteSize) ||
      row.byteSize < 1 ||
      row.byteSize > 10485760
    )
      return fail();
    return Object.freeze({
      contentType,
      width,
      height: row.height,
      byteSize: row.byteSize,
      checksum: parseMediaChecksum(row.checksum),
      objectEvidenceReference: parseObjectEvidenceReference(row.objectEvidenceReference),
      providerObjectVersion: parseMediaReferenceId(row.providerObjectVersion),
    });
  });
  if (
    renditions.reduce((n, v) => n + v.byteSize, 0) > 31457280 ||
    new Set(renditions.flatMap((v) => [v.objectEvidenceReference, v.providerObjectVersion]))
      .size !== 12
  )
    return fail();
  for (let i = 0; i < renditions.length; i += 2)
    if (renditions[i]?.height !== renditions[i + 1]?.height) return fail();
  const representative = renditions[4];
  if (
    !representative ||
    assetVersion.objectEvidenceReference !== representative.objectEvidenceReference ||
    assetVersion.providerObjectVersion !== representative.providerObjectVersion ||
    assetVersion.checksum !== representative.checksum ||
    assetVersion.contentType !== representative.contentType ||
    assetVersion.byteSize !== representative.byteSize
  )
    return fail();
  const asset: MediaPublicationAsset = Object.freeze({
    assetId: parsed.assetId,
    purpose: parsed.purpose,
    scope: parsed.scope,
    mediaKind: parsed.mediaKind,
    ownerType: parsed.ownerType,
    ownerReference: parsed.ownerReference,
    classification: parsed.classification,
  });
  return Object.freeze({
    ...identity,
    status,
    reason: "Ready",
    asset,
    assetVersion,
    renditions: Object.freeze(renditions),
    provenanceDigest: hash(r.provenanceDigest),
  });
}
export function buildMediaPublicationReadSnapshot(value: {
  readonly request: MediaPublicationReadRequest;
  readonly references: readonly MediaPublicationReferenceResult[];
  readonly observedAt: string;
  readonly validUntil: string;
}): MediaPublicationReadSnapshot {
  try {
    const r = closed(copyMediaUploadStorageValue(value), [
        "request",
        "references",
        "observedAt",
        "validUntil",
      ]),
      request = parseMediaPublicationReadRequest(r.request),
      observedAt = parseMediaInstant(r.observedAt),
      validUntil = parseMediaInstant(r.validUntil);
    if (
      observedAt < request.observedAt ||
      validUntil > request.validUntil ||
      observedAt >= validUntil ||
      !Array.isArray(r.references) ||
      r.references.length !== request.references.length
    )
      return fail();
    const references = Object.freeze(
      r.references.map((v, index) => {
        const expected = request.references[index];
        if (!expected) return fail();
        return result(v, expected, request);
      }),
    );
    const body = Object.freeze({
      profile: "MediaPublicationReadSnapshotV1" as const,
      request,
      references,
      relevantReferenceDigest: digest(references),
      observedAt,
      validUntil,
    });
    return Object.freeze({ ...body, digest: digest(body) });
  } catch {
    return fail();
  }
}
export function parseMediaPublicationReadSnapshot(value: unknown): MediaPublicationReadSnapshot {
  try {
    const r = closed(copyMediaUploadStorageValue(value), [
      "profile",
      "request",
      "references",
      "relevantReferenceDigest",
      "observedAt",
      "validUntil",
      "digest",
    ]);
    const parsed = buildMediaPublicationReadSnapshot({
      request: r.request as MediaPublicationReadRequest,
      references: r.references as readonly MediaPublicationReferenceResult[],
      observedAt: r.observedAt as string,
      validUntil: r.validUntil as string,
    });
    if (
      r.profile !== parsed.profile ||
      r.relevantReferenceDigest !== parsed.relevantReferenceDigest ||
      r.digest !== parsed.digest
    )
      return fail();
    return parsed;
  } catch {
    return fail();
  }
}

export function parseMediaOptionSetPublicationReadRequest(
  value: unknown,
): MediaOptionSetPublicationReadRequest {
  try {
    const r = closed(copyMediaUploadStorageValue(value), [
      "profile",
      "tenantReference",
      "scope",
      "actorReference",
      "actorKind",
      "operationReference",
      "originalIntentDigest",
      "optionSetReference",
      "versionReference",
      "expectedAggregateVersion",
      "sourceDigest",
      "contentDigest",
      "configurationDigest",
      "graphDigest",
      "activationAt",
      "references",
      "observedAt",
      "validUntil",
    ]);
    if (
      r.profile !== "MediaOptionSetPublicationReadRequestV1" ||
      r.actorKind !== "User" ||
      typeof r.expectedAggregateVersion !== "number" ||
      !Number.isSafeInteger(r.expectedAggregateVersion) ||
      r.expectedAggregateVersion < 1 ||
      r.expectedAggregateVersion > 2147483647 ||
      !Array.isArray(r.references) ||
      r.references.length > 100
    )
      return fail();
    const observedAt = parseMediaInstant(r.observedAt),
      validUntil = parseMediaInstant(r.validUntil),
      activationAt = parseMediaInstant(r.activationAt);
    if (
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
      activationAt < observedAt
    )
      return fail();
    const references = r.references
      .map((v) => reference(closed(v, referenceFields)))
      .sort((a, b) => a.mediaReference.localeCompare(b.mediaReference));
    if (new Set(references.map((v) => v.mediaReference)).size !== references.length) return fail();
    return Object.freeze({
      profile: "MediaOptionSetPublicationReadRequestV1",
      tenantReference: parseMediaReferenceId(r.tenantReference),
      scope: createMediaScope(r.scope as MediaScope),
      actorReference: parseMediaReferenceId(r.actorReference),
      actorKind: "User",
      operationReference: parseMediaReferenceId(r.operationReference),
      originalIntentDigest: hash(r.originalIntentDigest),
      optionSetReference: parseMediaReferenceId(r.optionSetReference),
      versionReference: parseMediaReferenceId(r.versionReference),
      expectedAggregateVersion: r.expectedAggregateVersion,
      sourceDigest: hash(r.sourceDigest),
      contentDigest: hash(r.contentDigest),
      configurationDigest: hash(r.configurationDigest),
      graphDigest: hash(r.graphDigest),
      activationAt,
      references: Object.freeze(references),
      observedAt,
      validUntil,
    });
  } catch {
    return fail();
  }
}
/** Exact owning readiness facts, not Catalog eligibility or purpose/owner policy. */
export function buildMediaOptionSetPublicationReadSnapshot(value: {
  readonly request: MediaOptionSetPublicationReadRequest;
  readonly references: readonly MediaPublicationReferenceResult[];
  readonly observedAt: string;
  readonly validUntil: string;
}): MediaOptionSetPublicationReadSnapshot {
  try {
    const r = closed(copyMediaUploadStorageValue(value), [
        "request",
        "references",
        "observedAt",
        "validUntil",
      ]),
      request = parseMediaOptionSetPublicationReadRequest(r.request),
      observedAt = parseMediaInstant(r.observedAt),
      validUntil = parseMediaInstant(r.validUntil);
    if (
      observedAt < request.observedAt ||
      validUntil > request.validUntil ||
      observedAt >= validUntil ||
      !Array.isArray(r.references) ||
      r.references.length !== request.references.length
    )
      return fail();
    const references = Object.freeze(
      r.references.map((v, index) => {
        const expected = request.references[index];
        if (!expected) return fail();
        return result(v, expected, request);
      }),
    );
    const body = Object.freeze({
      profile: "MediaOptionSetPublicationReadSnapshotV1" as const,
      request,
      references,
      relevantReferenceDigest: digest(references),
      observedAt,
      validUntil,
    });
    return Object.freeze({ ...body, digest: digest(body) });
  } catch {
    return fail();
  }
}
export function parseMediaOptionSetPublicationReadSnapshot(
  value: unknown,
): MediaOptionSetPublicationReadSnapshot {
  try {
    const r = closed(copyMediaUploadStorageValue(value), [
        "profile",
        "request",
        "references",
        "relevantReferenceDigest",
        "observedAt",
        "validUntil",
        "digest",
      ]),
      parsed = buildMediaOptionSetPublicationReadSnapshot({
        request: parseMediaOptionSetPublicationReadRequest(r.request),
        references: r.references as readonly MediaPublicationReferenceResult[],
        observedAt: parseMediaInstant(r.observedAt),
        validUntil: parseMediaInstant(r.validUntil),
      });
    if (
      r.profile !== parsed.profile ||
      r.relevantReferenceDigest !== parsed.relevantReferenceDigest ||
      r.digest !== parsed.digest
    )
      return fail();
    return parsed;
  } catch {
    return fail();
  }
}
