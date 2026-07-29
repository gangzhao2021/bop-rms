import type { AppendAuditRecordInput } from "@bop/audit";
import type { BusinessAction, PermissionDecision, PermissionResourceScope } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type {
  AssetReference,
  AssetVersionReference,
  MediaAsset,
  MediaAssetVersion,
  MediaChecksum,
  MediaIdempotencyKey,
  MediaReferenceId,
  ObjectEvidenceReference,
  UploadGrantReference,
  UploadSession,
} from "../../contracts/media.js";

export interface MediaAuthorizationRequest {
  readonly tenantContext: TenantContext;
  readonly action: BusinessAction;
  readonly resourceScope: PermissionResourceScope;
}

export interface MediaAuthorizationPort {
  authorize(request: MediaAuthorizationRequest): Promise<PermissionDecision>;
}

export interface CreateUploadGrantRequest {
  readonly idempotencyKey: MediaIdempotencyKey;
  readonly declaredContentType: string;
  readonly declaredByteSize: number;
}

export interface MediaUploadGrantPort {
  create(request: CreateUploadGrantRequest): Promise<UploadGrantReference>;
}

export interface VerifiedUploadEvidence {
  readonly objectEvidenceReference: ObjectEvidenceReference;
  readonly providerObjectVersion: MediaReferenceId;
  readonly byteSize: number;
  readonly checksum: MediaChecksum;
  readonly contentType: string;
}

export interface MediaUploadEvidencePort {
  verify(session: UploadSession): Promise<VerifiedUploadEvidence>;
}

export interface CommitCreateUploadInput {
  readonly idempotencyKey: MediaIdempotencyKey;
  readonly session: UploadSession;
  readonly audit: AppendAuditRecordInput;
}

export interface CommitFinalizeAssetInput {
  readonly idempotencyKey: MediaIdempotencyKey;
  readonly expectedSessionVersion: number;
  readonly closedSession: UploadSession;
  readonly asset: MediaAsset;
  readonly assetVersion: MediaAssetVersion;
  readonly audit: AppendAuditRecordInput;
}

export interface MediaUnitOfWorkPort {
  commitCreateUpload(input: CommitCreateUploadInput): Promise<void>;
  commitFinalizeAsset(input: CommitFinalizeAssetInput): Promise<void>;
}

export interface MediaReadPort {
  loadAsset(assetId: AssetReference): Promise<MediaAsset | null>;
  loadVersions(assetId: AssetReference): Promise<readonly MediaAssetVersion[]>;
  loadVersion(assetVersionId: AssetVersionReference): Promise<MediaAssetVersion | null>;
}

export interface MediaPorts {
  readonly authorization: MediaAuthorizationPort;
  readonly uploadGrant: MediaUploadGrantPort;
  readonly uploadEvidence: MediaUploadEvidencePort;
  readonly unitOfWork: MediaUnitOfWorkPort;
  readonly read: MediaReadPort;
}
