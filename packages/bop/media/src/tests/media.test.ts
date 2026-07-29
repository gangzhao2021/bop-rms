import type { AppendAuditRecordInput } from "@bop/audit";
import {
  evaluatePermission,
  parseEvidenceReference,
  parsePolicyReference,
  parsePolicyVersion,
  type PermissionDecision,
} from "@bop/permission";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { describe, expect, it, vi } from "vitest";
import {
  authorizeMediaAccess,
  createMediaAsset,
  createMediaAssetVersion,
  createMediaReference,
  createMediaScope,
  createUpload,
  createUploadSession,
  evaluateMediaReference,
  finalizeAsset,
  MediaContractError,
  MediaServiceError,
  parseAssetReference,
  parseAssetVersionReference,
  parseMediaChecksum,
  parseMediaIdempotencyKey,
  parseMediaOwnerType,
  parseMediaPurposeCode,
  parseMediaReferenceId,
  parseMediaVersion,
  parseObjectEvidenceReference,
  parseUploadGrantReference,
  parseUploadSessionReference,
  type MediaAsset,
  type MediaAssetVersion,
  type MediaAuthorizationRequest,
  type MediaPorts,
  type UploadSession,
} from "../index.js";

const ids = {
  actor: "018f1000-0000-7000-8000-000000000001",
  brand: "018f1000-0000-7000-8000-000000000002",
  otherBrand: "018f1000-0000-7000-8000-000000000003",
  store: "018f1000-0000-7000-8000-000000000004",
  otherStore: "018f1000-0000-7000-8000-000000000005",
  session: "018f1000-0000-7000-8000-000000000006",
  grant: "018f1000-0000-7000-8000-000000000007",
  owner: "018f1000-0000-7000-8000-000000000008",
  asset: "018f1000-0000-7000-8000-000000000009",
  assetVersion: "018f1000-0000-7000-8000-00000000000a",
  objectEvidence: "018f1000-0000-7000-8000-00000000000b",
  providerVersion: "018f1000-0000-7000-8000-00000000000c",
  idempotency: "018f1000-0000-7000-8000-00000000000d",
  audit: "018f1000-0000-7000-8000-00000000000e",
  correlation: "018f1000-0000-7000-8000-00000000000f",
  policy: "018f1000-0000-7000-8000-000000000010",
  evidence: "018f1000-0000-7000-8000-000000000011",
} as const;

const at = "2026-07-29T16:00:00.000Z";
const expires = "2026-07-29T16:15:00.000Z";
const checksum = parseMediaChecksum(`sha256:${"a".repeat(64)}`);

function context(storeReference: string | null = ids.store, brandReference: string = ids.brand) {
  const actor = {
    actorType: "User" as const,
    accountKind: "Workforce" as const,
    actorReference: ids.actor,
    status: "Active" as const,
    authenticationMethod: "Oidc" as const,
    verificationLevel: "SingleFactor" as const,
    authenticatedAt: at,
    recentMfaAt: null,
  };
  const brand = createBrand({
    brandReference,
    code: brandReference === ids.brand ? "BRAND_A" : "BRAND_B",
    displayName: "Synthetic Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const store =
    storeReference === null
      ? null
      : createStore({
          storeReference,
          brandReference,
          code: storeReference === ids.store ? "STORE_A" : "STORE_B",
          displayName: "Synthetic Store",
          timeZone: "America/Toronto",
          locale: "en-CA",
          currencyCode: "CAD",
          lifecycle: "Active",
          version: 1,
          createdAt: at,
          updatedAt: at,
        });
  return createTenantContext(actor as never, brand, store, at);
}

function scope(storeReference: string | null = ids.store, brandReference: string = ids.brand) {
  return createMediaScope({
    kind: storeReference === null ? "Brand" : "Store",
    brandReference: brandReference as never,
    storeReference: storeReference as never,
  });
}

function session(overrides: Partial<UploadSession> = {}): UploadSession {
  return createUploadSession({
    uploadSessionId: parseUploadSessionReference(ids.session),
    grantReference: parseUploadGrantReference(ids.grant),
    actorReference: ids.actor,
    purpose: parseMediaPurposeCode("PRODUCT_IMAGE"),
    scope: scope(),
    mediaKind: "Image",
    declaredContentType: "image/png",
    declaredByteSize: 1024,
    ownerType: parseMediaOwnerType("PRODUCT"),
    ownerReference: parseMediaReferenceId(ids.owner),
    classification: "Internal",
    state: "Pending",
    version: parseMediaVersion(1),
    createdAt: at as never,
    expiresAt: expires as never,
    ...overrides,
  });
}

function asset(overrides: Partial<MediaAsset> = {}, assetScope = scope()): MediaAsset {
  return createMediaAsset({
    assetId: parseAssetReference(ids.asset),
    purpose: parseMediaPurposeCode("PRODUCT_IMAGE"),
    scope: assetScope,
    mediaKind: "Image",
    ownerType: parseMediaOwnerType("PRODUCT"),
    ownerReference: parseMediaReferenceId(ids.owner),
    classification: "Internal",
    currentVersionReference: parseAssetVersionReference(ids.assetVersion),
    version: parseMediaVersion(1),
    ...overrides,
  });
}

function version(overrides: Partial<MediaAssetVersion> = {}): MediaAssetVersion {
  return createMediaAssetVersion({
    assetVersionId: parseAssetVersionReference(ids.assetVersion),
    assetId: parseAssetReference(ids.asset),
    version: parseMediaVersion(1),
    objectEvidenceReference: parseObjectEvidenceReference(ids.objectEvidence),
    providerObjectVersion: parseMediaReferenceId(ids.providerVersion),
    byteSize: 1024,
    checksum,
    contentType: "image/png",
    checkState: "Clean",
    readinessState: "Ready",
    createdAt: at as never,
    ...overrides,
  });
}

function allowDecision(request: MediaAuthorizationRequest): PermissionDecision {
  const actorReference = request.tenantContext.actor.actorReference;
  if (actorReference === null) throw new Error("synthetic actor unavailable");
  return evaluatePermission({
    tenantContext: request.tenantContext,
    action: request.action,
    resourceScope: request.resourceScope,
    policySnapshotReference: parsePolicyReference(ids.policy),
    policyVersion: parsePolicyVersion(1),
    evidence: [
      {
        source: "ExplicitAllow",
        evidenceReference: parseEvidenceReference(ids.evidence),
        action: request.action,
        actorReference,
        roleReference: null,
        brandReference: request.resourceScope.brandReference,
        storeReference: request.resourceScope.storeReference,
        effectiveFrom: at as never,
        effectiveUntil: expires as never,
      },
    ],
  });
}

function ports(options?: {
  decision?: (request: MediaAuthorizationRequest) => PermissionDecision;
  currentAsset?: MediaAsset | null;
  currentVersions?: readonly MediaAssetVersion[];
  failCommit?: boolean;
}) {
  const created: { session: UploadSession; audit: AppendAuditRecordInput }[] = [];
  const finalized: {
    closedSession: UploadSession;
    asset: MediaAsset;
    assetVersion: MediaAssetVersion;
    audit: AppendAuditRecordInput;
  }[] = [];
  const currentAsset = options?.currentAsset ?? asset();
  const currentVersions = options?.currentVersions ?? [version()];
  const value: MediaPorts = {
    authorization: {
      authorize: vi.fn(async (request) => (options?.decision ?? allowDecision)(request)),
    },
    uploadGrant: {
      create: vi.fn(async () => parseUploadGrantReference(ids.grant)),
    },
    uploadEvidence: {
      verify: vi.fn(async () => ({
        objectEvidenceReference: parseObjectEvidenceReference(ids.objectEvidence),
        providerObjectVersion: parseMediaReferenceId(ids.providerVersion),
        byteSize: 1024,
        checksum,
        contentType: "image/png",
      })),
    },
    unitOfWork: {
      commitCreateUpload: vi.fn(async (input) => {
        if (options?.failCommit) throw new Error("synthetic commit failure");
        created.push(input);
      }),
      commitFinalizeAsset: vi.fn(async (input) => {
        if (options?.failCommit) throw new Error("synthetic commit failure");
        finalized.push(input);
      }),
    },
    read: {
      loadAsset: vi.fn(async () => currentAsset),
      loadVersions: vi.fn(async () => currentVersions),
      loadVersion: vi.fn(
        async (reference) =>
          currentVersions.find((item) => item.assetVersionId === reference) ?? null,
      ),
    },
  };
  return { value, created, finalized };
}

function createInput() {
  return {
    tenantContext: context(),
    scope: scope(),
    uploadSessionId: parseUploadSessionReference(ids.session),
    purpose: parseMediaPurposeCode("PRODUCT_IMAGE"),
    mediaKind: "Image" as const,
    declaredContentType: "image/png",
    declaredByteSize: 1024,
    ownerType: parseMediaOwnerType("PRODUCT"),
    ownerReference: parseMediaReferenceId(ids.owner),
    classification: "Internal" as const,
    createdAt: at,
    expiresAt: expires,
    idempotencyKey: parseMediaIdempotencyKey(ids.idempotency),
    auditId: parseMediaReferenceId(ids.audit),
    correlationId: parseMediaReferenceId(ids.correlation),
    sourceChannel: "MERCHANT_WEB",
  };
}

function finalizeInput(uploadSession = session()) {
  return {
    tenantContext: context(),
    session: uploadSession,
    assetId: parseAssetReference(ids.asset),
    assetVersionId: parseAssetVersionReference(ids.assetVersion),
    occurredAt: "2026-07-29T16:05:00.000Z",
    idempotencyKey: parseMediaIdempotencyKey(ids.idempotency),
    auditId: parseMediaReferenceId(ids.audit),
    correlationId: parseMediaReferenceId(ids.correlation),
    sourceChannel: "MERCHANT_WEB",
  };
}

describe("WP-0121 Media contract", () => {
  it("creates strict immutable sessions with a maximum fifteen-minute lifetime", () => {
    const value = session();
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.scope)).toBe(true);
    expect(() => session({ declaredContentType: "text/plain" })).toThrow(MediaContractError);
    expect(() => session({ actorReference: "person@example.test" })).toThrow(MediaContractError);
    expect(() => createUploadSession({ ...session(), filename: "secret.png" } as never)).toThrow(
      MediaContractError,
    );
    expect(() => session({ expiresAt: "2026-07-29T16:15:00.001Z" as never })).toThrow(
      MediaContractError,
    );
  });

  it("keeps Dynamic and Pinned reference shapes mutually exclusive", () => {
    expect(
      createMediaReference({
        kind: "Dynamic",
        assetId: parseAssetReference(ids.asset),
        assetVersionId: null,
      }).assetVersionId,
    ).toBeNull();
    expect(() =>
      createMediaReference({
        kind: "Dynamic",
        assetId: parseAssetReference(ids.asset),
        assetVersionId: parseAssetVersionReference(ids.assetVersion),
      }),
    ).toThrow(MediaContractError);
  });

  it("resolves one clean ready Dynamic version for Draft only", () => {
    const reference = createMediaReference({
      kind: "Dynamic",
      assetId: parseAssetReference(ids.asset),
      assetVersionId: null,
    });
    expect(
      evaluateMediaReference({
        reference,
        asset: asset(),
        versions: [version()],
        context: scope(),
        use: "Draft",
      }),
    ).toEqual({
      allowed: true,
      reason: "REFERENCE_ALLOWED",
      assetVersionId: ids.assetVersion,
    });
    expect(
      evaluateMediaReference({
        reference,
        asset: asset(),
        versions: [version()],
        context: scope(),
        use: "Published",
      }).reason,
    ).toBe("PINNED_REFERENCE_REQUIRED");
  });

  it("fails closed for quarantined, ambiguous, Store-mismatched and cross-Brand media", () => {
    const reference = createMediaReference({
      kind: "Pinned",
      assetId: parseAssetReference(ids.asset),
      assetVersionId: parseAssetVersionReference(ids.assetVersion),
    });
    for (const candidate of [
      {
        versions: [version({ checkState: "Quarantined", readinessState: "Pending" })],
        context: scope(),
      },
      { versions: [version(), version()], context: scope() },
      { versions: [version()], context: scope(ids.otherStore) },
      { versions: [version()], context: scope(ids.store, ids.otherBrand) },
    ])
      expect(
        evaluateMediaReference({
          reference,
          asset: asset(),
          versions: candidate.versions,
          context: candidate.context,
          use: "Published",
        }),
      ).toEqual({ allowed: false, reason: "MEDIA_UNAVAILABLE", assetVersionId: null });
  });

  it("creates a Permission-gated Upload Session and atomically composes Audit", async () => {
    const harness = ports();
    const result = await createUpload(createInput(), harness.value);
    expect(result.state).toBe("Pending");
    expect(harness.created).toHaveLength(1);
    expect(harness.created[0]?.audit.actionCode).toBe("MEDIA_UPLOAD_CREATED");
    expect(harness.created[0]?.audit).not.toHaveProperty("deviceNetworkReference");
  });

  it("denies create on exact Tenant scope mismatch before grant creation", async () => {
    const harness = ports();
    await expect(
      createUpload({ ...createInput(), tenantContext: context(ids.otherStore) }, harness.value),
    ).rejects.toMatchObject({ code: "MEDIA_MUTATION_INVALID" });
    expect(harness.value.uploadGrant.create).not.toHaveBeenCalled();
  });

  it("denies create when Permission returns default deny", async () => {
    const harness = ports({
      decision: (request) =>
        evaluatePermission({
          tenantContext: request.tenantContext,
          action: request.action,
          resourceScope: request.resourceScope,
          policySnapshotReference: parsePolicyReference(ids.policy),
          policyVersion: parsePolicyVersion(1),
          evidence: [],
        }),
    });
    await expect(createUpload(createInput(), harness.value)).rejects.toMatchObject({
      code: "MEDIA_PERMISSION_DENIED",
    });
    expect(harness.created).toHaveLength(0);
  });

  it("finalizes only exact server evidence into one quarantined immutable version", async () => {
    const harness = ports();
    const result = await finalizeAsset(finalizeInput(), harness.value);
    expect(result.session.state).toBe("Finalized");
    expect(result.session.version).toBe(2);
    expect(result.asset.currentVersionReference).toBeNull();
    expect(result.assetVersion).toMatchObject({
      checkState: "Quarantined",
      readinessState: "Pending",
      objectEvidenceReference: ids.objectEvidence,
    });
    expect(harness.finalized[0]?.audit.actionCode).toBe("MEDIA_ASSET_FINALIZED");
  });

  it("rejects verifier mismatch, expiry and session reuse uniformly", async () => {
    const mismatch = ports();
    vi.mocked(mismatch.value.uploadEvidence.verify).mockResolvedValue({
      objectEvidenceReference: parseObjectEvidenceReference(ids.objectEvidence),
      providerObjectVersion: parseMediaReferenceId(ids.providerVersion),
      byteSize: 2048,
      checksum,
      contentType: "image/png",
    });
    await expect(finalizeAsset(finalizeInput(), mismatch.value)).rejects.toMatchObject({
      code: "MEDIA_UPLOAD_UNAVAILABLE",
    });
    for (const unavailable of [
      session({ state: "Finalized" }),
      session({ expiresAt: "2026-07-29T16:04:00.000Z" as never }),
    ])
      await expect(finalizeAsset(finalizeInput(unavailable), ports().value)).rejects.toMatchObject({
        code: "MEDIA_UPLOAD_UNAVAILABLE",
      });
  });

  it("reports commit failure without returning a successful mutation", async () => {
    const harness = ports({ failCommit: true });
    await expect(createUpload(createInput(), harness.value)).rejects.toBeInstanceOf(
      MediaServiceError,
    );
    await expect(finalizeAsset(finalizeInput(), harness.value)).rejects.toMatchObject({
      code: "MEDIA_COMMIT_FAILED",
    });
  });

  it("authorizes Pinned access but returns uniform unavailable on Permission denial", async () => {
    const reference = createMediaReference({
      kind: "Pinned",
      assetId: parseAssetReference(ids.asset),
      assetVersionId: parseAssetVersionReference(ids.assetVersion),
    });
    await expect(
      authorizeMediaAccess(
        { tenantContext: context(), reference, use: "Published" },
        ports().value,
      ),
    ).resolves.toMatchObject({ allowed: true, assetVersionId: ids.assetVersion });
    const denied = ports({
      decision: (request) =>
        Object.freeze({
          ...allowDecision(request),
          effect: "Deny",
          reason: "DEFAULT_DENY",
          source: "DefaultDeny",
          audit: { effect: "Deny", reason: "DEFAULT_DENY", source: "DefaultDeny" },
        }) as PermissionDecision,
    });
    await expect(
      authorizeMediaAccess({ tenantContext: context(), reference, use: "Published" }, denied.value),
    ).resolves.toEqual({ allowed: false, reason: "MEDIA_UNAVAILABLE", assetVersionId: null });
  });

  it("never returns object evidence or a delivery URL from access evaluation", async () => {
    const result = await authorizeMediaAccess(
      {
        tenantContext: context(),
        reference: createMediaReference({
          kind: "Pinned",
          assetId: parseAssetReference(ids.asset),
          assetVersionId: parseAssetVersionReference(ids.assetVersion),
        }),
        use: "Evidence",
      },
      ports().value,
    );
    expect(result).toEqual({
      allowed: true,
      reason: "REFERENCE_ALLOWED",
      assetVersionId: ids.assetVersion,
    });
    expect(result).not.toHaveProperty("objectEvidenceReference");
    expect(result).not.toHaveProperty("url");
  });
});
