import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createMediaAsset,
  createMediaAssetVersion,
  createMediaScope,
  parseAssetReference,
  parseAssetVersionReference,
  parseMediaInstant,
  parseMediaReferenceId,
  type MediaAsset,
  type MediaAssetVersion,
  type MediaScope,
} from "./media.js";
import { copyMediaUploadStorageValue } from "./media-upload-storage.js";
import type { MediaPublicationAsset, MediaPublicationReference } from "./media-publication-read.js";

export const mediaEditorReadFields = Object.freeze([
  "assetIdentity",
  "scope",
  "purpose",
  "owner",
  "classification",
  "pinnedVersion",
  "checkState",
  "readinessState",
  "processingProvenance",
  "editorIntent",
] as const);
/** Catalog binds these primitives to its actual proposed full content and original
 * command. EditorCreate's zero revision denotes absence, never fictional history. */
export interface MediaEditorReadRequest {
  readonly profile: "MediaEditorReadRequestV1";
  readonly intentKind: "EditorCreate" | "DraftReplace";
  readonly tenantReference: string;
  readonly scope: MediaScope;
  readonly actorReference: string;
  readonly actorKind: "User";
  readonly operationReference: string;
  readonly originalIntentDigest: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly expectedAggregateVersion: number;
  readonly aggregateSnapshotDigest: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly references: readonly MediaPublicationReference[];
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface MediaEditorReferenceResult extends MediaPublicationReference {
  readonly status: "Recorded";
  readonly asset: MediaPublicationAsset;
  readonly assetVersion: MediaAssetVersion;
  readonly processingProvenanceDigest: string | null;
}
export interface MediaEditorReadSnapshot {
  readonly profile: "MediaEditorReadSnapshotV1";
  readonly request: MediaEditorReadRequest;
  readonly references: readonly MediaEditorReferenceResult[];
  readonly relevantReferenceDigest: string;
  readonly eligibility: "NotEvaluated";
  readonly observedAt: string;
  readonly validUntil: string;
  readonly digest: string;
}
export class MediaEditorReadError extends Error {
  readonly code = "MEDIA_EDITOR_READ_UNAVAILABLE";
  constructor() {
    super("Media editor read is unavailable");
    this.name = "MediaEditorReadError";
  }
}
const fail = (): never => {
  throw new MediaEditorReadError();
};
const hash = (value: unknown): string =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value) ? value : fail();
const digest = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[key] = d.value;
  }
  return result;
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
export function parseMediaEditorReadRequest(value: unknown): MediaEditorReadRequest {
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
      "expectedAggregateVersion",
      "aggregateSnapshotDigest",
      "contentDigest",
      "configurationDigest",
      "references",
      "observedAt",
      "validUntil",
    ]);
    if (
      r.profile !== "MediaEditorReadRequestV1" ||
      (r.intentKind !== "EditorCreate" && r.intentKind !== "DraftReplace") ||
      r.actorKind !== "User" ||
      typeof r.expectedAggregateVersion !== "number" ||
      !Number.isSafeInteger(r.expectedAggregateVersion) ||
      r.expectedAggregateVersion > 2147483647 ||
      (r.intentKind === "EditorCreate"
        ? r.expectedAggregateVersion !== 0
        : r.expectedAggregateVersion < 1) ||
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
      profile: "MediaEditorReadRequestV1",
      intentKind: r.intentKind,
      tenantReference: parseMediaReferenceId(r.tenantReference),
      scope: createMediaScope(r.scope as MediaScope),
      actorReference: parseMediaReferenceId(r.actorReference),
      actorKind: "User",
      operationReference: parseMediaReferenceId(r.operationReference),
      originalIntentDigest: hash(r.originalIntentDigest),
      productReference: parseMediaReferenceId(r.productReference),
      versionReference: parseMediaReferenceId(r.versionReference),
      expectedAggregateVersion: r.expectedAggregateVersion,
      aggregateSnapshotDigest: hash(r.aggregateSnapshotDigest),
      contentDigest: hash(r.contentDigest),
      configurationDigest: hash(r.configurationDigest),
      references: Object.freeze(references),
      observedAt,
      validUntil,
    });
  } catch {
    return fail();
  }
}
export function buildMediaEditorReadSnapshot(value: {
  readonly request: MediaEditorReadRequest;
  readonly references: readonly MediaEditorReferenceResult[];
  readonly observedAt: string;
  readonly validUntil: string;
}): MediaEditorReadSnapshot {
  try {
    const r = closed(copyMediaUploadStorageValue(value), [
        "request",
        "references",
        "observedAt",
        "validUntil",
      ]),
      request = parseMediaEditorReadRequest(r.request),
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
      r.references.map((value, index): MediaEditorReferenceResult => {
        const v = closed(value, [
            ...referenceFields,
            "status",
            "asset",
            "assetVersion",
            "processingProvenanceDigest",
          ]),
          identity = reference(v),
          expected = request.references[index],
          a = closed(v.asset, [
            "assetId",
            "purpose",
            "scope",
            "mediaKind",
            "ownerType",
            "ownerReference",
            "classification",
          ]),
          asset = createMediaAsset({
            ...a,
            version: 1,
            currentVersionReference: null,
          } as unknown as MediaAsset),
          version = createMediaAssetVersion(v.assetVersion as MediaAssetVersion),
          processingProvenanceDigest =
            v.processingProvenanceDigest === null ? null : hash(v.processingProvenanceDigest);
        if (
          !expected ||
          !equal(identity, expected) ||
          v.status !== "Recorded" ||
          identity.cropReference !== null ||
          identity.focusReference !== null ||
          asset.assetId !== identity.assetReference ||
          !equal(asset.scope, request.scope) ||
          version.assetId !== asset.assetId ||
          version.assetVersionId !== identity.assetVersionReference ||
          version.createdAt > observedAt ||
          (asset.mediaKind === "Image" &&
          version.checkState === "Clean" &&
          version.readinessState === "Ready"
            ? processingProvenanceDigest === null
            : processingProvenanceDigest !== null)
        )
          return fail();
        return Object.freeze({
          ...identity,
          status: "Recorded",
          asset: Object.freeze({
            assetId: asset.assetId,
            purpose: asset.purpose,
            scope: asset.scope,
            mediaKind: asset.mediaKind,
            ownerType: asset.ownerType,
            ownerReference: asset.ownerReference,
            classification: asset.classification,
          }),
          assetVersion: version,
          processingProvenanceDigest,
        });
      }),
    );
    const body = Object.freeze({
      profile: "MediaEditorReadSnapshotV1" as const,
      request,
      references,
      relevantReferenceDigest: digest(references),
      eligibility: "NotEvaluated" as const,
      observedAt,
      validUntil,
    });
    return Object.freeze({ ...body, digest: digest(body) });
  } catch {
    return fail();
  }
}
export function parseMediaEditorReadSnapshot(value: unknown): MediaEditorReadSnapshot {
  try {
    const r = closed(copyMediaUploadStorageValue(value), [
        "profile",
        "request",
        "references",
        "relevantReferenceDigest",
        "eligibility",
        "observedAt",
        "validUntil",
        "digest",
      ]),
      parsed = buildMediaEditorReadSnapshot({
        request: r.request as MediaEditorReadRequest,
        references: r.references as readonly MediaEditorReferenceResult[],
        observedAt: r.observedAt as string,
        validUntil: r.validUntil as string,
      });
    if (
      r.profile !== parsed.profile ||
      r.eligibility !== parsed.eligibility ||
      r.relevantReferenceDigest !== parsed.relevantReferenceDigest ||
      r.digest !== parsed.digest
    )
      return fail();
    return parsed;
  } catch {
    return fail();
  }
}
