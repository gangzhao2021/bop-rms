import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import {
  parseBusinessAction,
  revalidateTenantContext,
  type BusinessAction,
  type PermissionDecision,
  type PermissionResourceScope,
} from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import {
  createMediaAsset,
  createMediaAssetVersion,
  createMediaReference,
  createUploadSession,
  parseAssetReference,
  parseAssetVersionReference,
  parseMediaChecksum,
  parseMediaIdempotencyKey,
  parseMediaInstant,
  parseMediaOwnerType,
  parseMediaPurposeCode,
  parseMediaReferenceId,
  parseMediaVersion,
  parseObjectEvidenceReference,
  parseUploadSessionReference,
  type AssetReference,
  type AssetVersionReference,
  type MediaAsset,
  type MediaAssetVersion,
  type MediaClassification,
  type MediaIdempotencyKey,
  type MediaKind,
  type MediaOwnerType,
  type MediaPurposeCode,
  type MediaReference,
  type MediaReferenceId,
  type MediaScope,
  type MediaUseKind,
  type UploadSession,
  type UploadSessionReference,
} from "../contracts/media.js";
import {
  evaluateMediaReference,
  type MediaReferenceEvaluation,
} from "../domain/evaluate-media-reference.js";
import type { MediaPorts } from "./ports/media-ports.js";

export const mediaServiceErrorCodes = [
  "MEDIA_MUTATION_INVALID",
  "MEDIA_PERMISSION_DENIED",
  "MEDIA_UPLOAD_UNAVAILABLE",
  "MEDIA_COMMIT_FAILED",
] as const;
export type MediaServiceErrorCode = (typeof mediaServiceErrorCodes)[number];

export class MediaServiceError extends Error {
  readonly code: MediaServiceErrorCode;
  constructor(code: MediaServiceErrorCode) {
    super("media operation is unavailable");
    this.name = "MediaServiceError";
    this.code = code;
  }
}

const actions = {
  createUpload: parseBusinessAction("media.upload.create"),
  finalizeAsset: parseBusinessAction("media.asset.finalize"),
  authorizeAccess: parseBusinessAction("media.asset.access"),
} as const;

function fail(code: MediaServiceErrorCode): never {
  throw new MediaServiceError(code);
}

function exactScope(context: TenantContext, scope: MediaScope): boolean {
  return (
    context.scopeKind === scope.kind &&
    context.brand.brandReference === scope.brandReference &&
    (context.store?.storeReference ?? null) === scope.storeReference
  );
}

function resourceScope(scope: MediaScope): PermissionResourceScope {
  return Object.freeze({
    kind: scope.kind,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  });
}

function accepted(
  decision: PermissionDecision,
  action: BusinessAction,
  scope: MediaScope,
): boolean {
  return (
    Object.isFrozen(decision) &&
    decision.effect === "Allow" &&
    decision.action === action &&
    decision.scopeKind === scope.kind
  );
}

async function authorize(
  ports: MediaPorts,
  tenantContext: TenantContext,
  scope: MediaScope,
  action: BusinessAction,
): Promise<void> {
  const decision = await ports.authorization.authorize({
    tenantContext,
    action,
    resourceScope: resourceScope(scope),
  });
  if (!accepted(decision, action, scope)) fail("MEDIA_PERMISSION_DENIED");
}

function audit(input: {
  auditId: MediaReferenceId;
  correlationId: MediaReferenceId;
  context: TenantContext;
  actionCode: string;
  targetType: string;
  targetId: string;
  occurredAt: string;
  sourceChannel: string;
}): AppendAuditRecordInput {
  const actorReference = input.context.actor.actorReference;
  if (actorReference === null) fail("MEDIA_MUTATION_INVALID");
  try {
    return validateAuditRecord({
      auditId: input.auditId,
      brandId: input.context.brand.brandReference,
      ...(input.context.store === null ? {} : { storeId: input.context.store.storeReference }),
      actor: { type: "User", reference: actorReference },
      actionCode: input.actionCode,
      targetType: input.targetType,
      targetId: input.targetId,
      reasonCode: input.actionCode,
      correlationId: input.correlationId,
      occurredAt: input.occurredAt,
      sourceChannel: input.sourceChannel,
      dataClassification: "Confidential",
      retentionPolicyCode: "MEDIA_OPERATION_AUDIT",
      retentionPolicyVersion: 1,
    });
  } catch {
    return fail("MEDIA_MUTATION_INVALID");
  }
}

export interface CreateUploadInput {
  readonly tenantContext: TenantContext;
  readonly scope: MediaScope;
  readonly uploadSessionId: UploadSessionReference;
  readonly purpose: MediaPurposeCode;
  readonly mediaKind: MediaKind;
  readonly declaredContentType: string;
  readonly declaredByteSize: number;
  readonly ownerType: MediaOwnerType;
  readonly ownerReference: MediaReferenceId;
  readonly classification: MediaClassification;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly idempotencyKey: MediaIdempotencyKey;
  readonly auditId: MediaReferenceId;
  readonly correlationId: MediaReferenceId;
  readonly sourceChannel: string;
}

export async function createUpload(
  input: CreateUploadInput,
  ports: MediaPorts,
): Promise<UploadSession> {
  let context: TenantContext;
  try {
    context = revalidateTenantContext(input.tenantContext);
    parseUploadSessionReference(input.uploadSessionId);
    parseMediaPurposeCode(input.purpose);
    parseMediaOwnerType(input.ownerType);
    parseMediaReferenceId(input.ownerReference);
    parseMediaIdempotencyKey(input.idempotencyKey);
    parseMediaReferenceId(input.auditId);
    parseMediaReferenceId(input.correlationId);
  } catch {
    return fail("MEDIA_MUTATION_INVALID");
  }
  if (!exactScope(context, input.scope)) fail("MEDIA_MUTATION_INVALID");
  await authorize(ports, context, input.scope, actions.createUpload);
  let session: UploadSession;
  try {
    const grantReference = await ports.uploadGrant.create({
      idempotencyKey: input.idempotencyKey,
      declaredContentType: input.declaredContentType,
      declaredByteSize: input.declaredByteSize,
    });
    session = createUploadSession({
      uploadSessionId: input.uploadSessionId,
      grantReference,
      actorReference: context.actor.actorReference as string,
      purpose: input.purpose,
      scope: input.scope,
      mediaKind: input.mediaKind,
      declaredContentType: input.declaredContentType,
      declaredByteSize: input.declaredByteSize,
      ownerType: input.ownerType,
      ownerReference: input.ownerReference,
      classification: input.classification,
      state: "Pending",
      version: parseMediaVersion(1),
      createdAt: parseMediaInstant(input.createdAt),
      expiresAt: parseMediaInstant(input.expiresAt),
    });
  } catch {
    return fail("MEDIA_UPLOAD_UNAVAILABLE");
  }
  try {
    await ports.unitOfWork.commitCreateUpload({
      idempotencyKey: input.idempotencyKey,
      session,
      audit: audit({
        auditId: input.auditId,
        correlationId: input.correlationId,
        context,
        actionCode: "MEDIA_UPLOAD_CREATED",
        targetType: "MediaUploadSession",
        targetId: session.uploadSessionId,
        occurredAt: input.createdAt,
        sourceChannel: input.sourceChannel,
      }),
    });
    return session;
  } catch {
    return fail("MEDIA_COMMIT_FAILED");
  }
}

export interface FinalizeAssetInput {
  readonly tenantContext: TenantContext;
  readonly session: UploadSession;
  readonly assetId: AssetReference;
  readonly assetVersionId: AssetVersionReference;
  readonly occurredAt: string;
  readonly idempotencyKey: MediaIdempotencyKey;
  readonly auditId: MediaReferenceId;
  readonly correlationId: MediaReferenceId;
  readonly sourceChannel: string;
}

export interface FinalizeAssetResult {
  readonly session: UploadSession;
  readonly asset: MediaAsset;
  readonly assetVersion: MediaAssetVersion;
}

export async function finalizeAsset(
  input: FinalizeAssetInput,
  ports: MediaPorts,
): Promise<FinalizeAssetResult> {
  let context: TenantContext;
  let session: UploadSession;
  try {
    context = revalidateTenantContext(input.tenantContext);
    session = createUploadSession(input.session);
    parseAssetReference(input.assetId);
    parseAssetVersionReference(input.assetVersionId);
    parseMediaIdempotencyKey(input.idempotencyKey);
    parseMediaReferenceId(input.auditId);
    parseMediaReferenceId(input.correlationId);
  } catch {
    return fail("MEDIA_UPLOAD_UNAVAILABLE");
  }
  const at = Date.parse(input.occurredAt);
  if (
    session.state !== "Pending" ||
    !Number.isFinite(at) ||
    at < Date.parse(session.createdAt) ||
    at >= Date.parse(session.expiresAt) ||
    context.actor.actorReference !== session.actorReference ||
    !exactScope(context, session.scope)
  )
    fail("MEDIA_UPLOAD_UNAVAILABLE");
  await authorize(ports, context, session.scope, actions.finalizeAsset);
  let asset: MediaAsset;
  let assetVersion: MediaAssetVersion;
  let closedSession: UploadSession;
  try {
    const evidence = await ports.uploadEvidence.verify(session);
    parseObjectEvidenceReference(evidence.objectEvidenceReference);
    parseMediaReferenceId(evidence.providerObjectVersion);
    parseMediaChecksum(evidence.checksum);
    if (
      evidence.byteSize !== session.declaredByteSize ||
      evidence.contentType !== session.declaredContentType
    )
      fail("MEDIA_UPLOAD_UNAVAILABLE");
    asset = createMediaAsset({
      assetId: input.assetId,
      purpose: session.purpose,
      scope: session.scope,
      mediaKind: session.mediaKind,
      ownerType: session.ownerType,
      ownerReference: session.ownerReference,
      classification: session.classification,
      currentVersionReference: null,
      version: parseMediaVersion(1),
    });
    assetVersion = createMediaAssetVersion({
      assetVersionId: input.assetVersionId,
      assetId: input.assetId,
      version: parseMediaVersion(1),
      objectEvidenceReference: evidence.objectEvidenceReference,
      providerObjectVersion: evidence.providerObjectVersion,
      byteSize: evidence.byteSize,
      checksum: evidence.checksum,
      contentType: evidence.contentType,
      checkState: "Quarantined",
      readinessState: "Pending",
      createdAt: parseMediaInstant(input.occurredAt),
    });
    closedSession = createUploadSession({
      ...session,
      state: "Finalized",
      version: parseMediaVersion(session.version + 1),
    });
  } catch (error) {
    if (error instanceof MediaServiceError) throw error;
    return fail("MEDIA_UPLOAD_UNAVAILABLE");
  }
  try {
    await ports.unitOfWork.commitFinalizeAsset({
      idempotencyKey: input.idempotencyKey,
      expectedSessionVersion: session.version,
      closedSession,
      asset,
      assetVersion,
      audit: audit({
        auditId: input.auditId,
        correlationId: input.correlationId,
        context,
        actionCode: "MEDIA_ASSET_FINALIZED",
        targetType: "MediaAsset",
        targetId: asset.assetId,
        occurredAt: input.occurredAt,
        sourceChannel: input.sourceChannel,
      }),
    });
    return Object.freeze({ session: closedSession, asset, assetVersion });
  } catch {
    return fail("MEDIA_COMMIT_FAILED");
  }
}

export interface AuthorizeMediaAccessInput {
  readonly tenantContext: TenantContext;
  readonly reference: MediaReference;
  readonly use: MediaUseKind;
}

export async function authorizeMediaAccess(
  input: AuthorizeMediaAccessInput,
  ports: MediaPorts,
): Promise<MediaReferenceEvaluation> {
  let context: TenantContext;
  let reference: MediaReference;
  try {
    context = revalidateTenantContext(input.tenantContext);
    reference = createMediaReference(input.reference);
  } catch {
    return Object.freeze({ allowed: false, reason: "MEDIA_UNAVAILABLE", assetVersionId: null });
  }
  const asset = await ports.read.loadAsset(reference.assetId);
  if (asset === null)
    return Object.freeze({ allowed: false, reason: "MEDIA_UNAVAILABLE", assetVersionId: null });
  try {
    await authorize(ports, context, asset.scope, actions.authorizeAccess);
  } catch {
    return Object.freeze({ allowed: false, reason: "MEDIA_UNAVAILABLE", assetVersionId: null });
  }
  const versions =
    reference.assetVersionId === null
      ? await ports.read.loadVersions(reference.assetId)
      : [await ports.read.loadVersion(reference.assetVersionId)].filter(
          (value): value is MediaAssetVersion => value !== null,
        );
  return evaluateMediaReference({
    reference,
    asset,
    versions,
    context: {
      kind: context.scopeKind,
      brandReference: context.brand.brandReference,
      storeReference: context.store?.storeReference ?? null,
    },
    use: input.use,
  });
}
