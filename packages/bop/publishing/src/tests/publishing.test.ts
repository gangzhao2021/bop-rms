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
  createPublishingApprovalEvidence,
  createPublishingLifecycleRecord,
  createPublishingReleaseRecord,
  createPublishingScope,
  createPublishingValidationEvidence,
  evaluatePublishingTransition,
  executePublishingMutation,
  parsePublishingCode,
  parsePublishingDigest,
  parsePublishingInstant,
  parsePublishingReference,
  parsePublishingVersion,
  parseReleaseSequence,
  PublishingContractError,
  PublishingServiceError,
  schedulePublishing,
  type ExecutePublishingMutationInput,
  type PublishingApprovalEvidence,
  type PublishingAuthorizationRequest,
  type PublishingLifecycleRecord,
  type PublishingPorts,
  type PublishingReleaseRecord,
  type PublishingValidationEvidence,
} from "../index.js";

const ids = {
  actor: "018f2000-0000-7000-8000-000000000001",
  otherActor: "018f2000-0000-7000-8000-000000000002",
  brand: "018f2000-0000-7000-8000-000000000003",
  otherBrand: "018f2000-0000-7000-8000-000000000004",
  store: "018f2000-0000-7000-8000-000000000005",
  otherStore: "018f2000-0000-7000-8000-000000000006",
  lifecycle: "018f2000-0000-7000-8000-000000000007",
  family: "018f2000-0000-7000-8000-000000000008",
  snapshotA: "018f2000-0000-7000-8000-000000000009",
  snapshotB: "018f2000-0000-7000-8000-00000000000a",
  validation: "018f2000-0000-7000-8000-00000000000b",
  approval: "018f2000-0000-7000-8000-00000000000c",
  release1: "018f2000-0000-7000-8000-00000000000d",
  release2: "018f2000-0000-7000-8000-00000000000e",
  release3: "018f2000-0000-7000-8000-00000000000f",
  policy: "018f2000-0000-7000-8000-000000000010",
  permissionEvidence: "018f2000-0000-7000-8000-000000000011",
  idempotency: "018f2000-0000-7000-8000-000000000012",
  audit: "018f2000-0000-7000-8000-000000000013",
  correlation: "018f2000-0000-7000-8000-000000000014",
} as const;

const before = parsePublishingInstant("2026-07-29T17:55:00.000Z");
const at = parsePublishingInstant("2026-07-29T18:00:00.000Z");
const until = parsePublishingInstant("2026-07-29T18:30:00.000Z");
const later = parsePublishingInstant("2026-07-29T19:00:00.000Z");
const digestA = parsePublishingDigest(`sha256:${"a".repeat(64)}`);
const digestB = parsePublishingDigest(`sha256:${"b".repeat(64)}`);

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
  return createPublishingScope({
    kind: storeReference === null ? "Brand" : "Store",
    brandReference: brandReference as never,
    storeReference: storeReference as never,
  });
}

function lifecycle(
  state: PublishingLifecycleRecord["state"],
  version: number,
  overrides: Partial<PublishingLifecycleRecord> = {},
): PublishingLifecycleRecord {
  const hasValidation = !["Draft"].includes(state);
  const hasApproval = ["Approved", "Published", "Archived", "Superseded"].includes(state);
  return createPublishingLifecycleRecord({
    lifecycleId: parsePublishingReference(ids.lifecycle),
    familyReference: parsePublishingReference(ids.family),
    configurationType: parsePublishingCode("MENU_CONFIGURATION"),
    purposeCode: parsePublishingCode("MENU_PUBLICATION"),
    snapshotReference: parsePublishingReference(ids.snapshotA),
    snapshotDigest: digestA,
    scope: scope(),
    version: parsePublishingVersion(version),
    state,
    validationEvidenceReference: hasValidation ? parsePublishingReference(ids.validation) : null,
    approvalEvidenceReference: hasApproval ? parsePublishingReference(ids.approval) : null,
    createdAt: before,
    changedAt: at,
    ...overrides,
  });
}

function validation(
  record: PublishingLifecycleRecord = lifecycle("InReview", 2),
  overrides: Partial<PublishingValidationEvidence> = {},
): PublishingValidationEvidence {
  return createPublishingValidationEvidence({
    evidenceReference: parsePublishingReference(ids.validation),
    snapshotReference: record.snapshotReference,
    snapshotDigest: record.snapshotDigest,
    scope: record.scope,
    result: "Pass",
    checkedAt: before,
    validUntil: until,
    checkCodes: [parsePublishingCode("SCHEMA_VALID"), parsePublishingCode("REFERENCES_VALID")],
    ...overrides,
  });
}

function approval(
  record: PublishingLifecycleRecord = lifecycle("InReview", 2),
  overrides: Partial<PublishingApprovalEvidence> = {},
): PublishingApprovalEvidence {
  return createPublishingApprovalEvidence({
    evidenceReference: parsePublishingReference(ids.approval),
    reviewLifecycleId: record.lifecycleId,
    reviewVersion: parsePublishingVersion(
      record.state === "Approved" ? record.version - 1 : record.version,
    ),
    snapshotReference: record.snapshotReference,
    snapshotDigest: record.snapshotDigest,
    scope: record.scope,
    decision: "Accepted",
    approvedActorReference: parsePublishingReference(ids.actor),
    approvedAt: before,
    validUntil: until,
    ...overrides,
  });
}

function release(
  record: PublishingLifecycleRecord,
  sequence: number,
  releaseId: string,
  kind: PublishingReleaseRecord["kind"] = "Publish",
  previousReleaseId: string | null = null,
  overrides: Partial<PublishingReleaseRecord> = {},
): PublishingReleaseRecord {
  return createPublishingReleaseRecord({
    releaseId: parsePublishingReference(releaseId),
    familyReference: record.familyReference,
    configurationType: record.configurationType,
    purposeCode: record.purposeCode,
    snapshotReference: record.snapshotReference,
    snapshotDigest: record.snapshotDigest,
    scope: record.scope,
    sequence: parseReleaseSequence(sequence),
    sourceLifecycleId: record.lifecycleId,
    kind,
    previousReleaseId:
      previousReleaseId === null ? null : parsePublishingReference(previousReleaseId),
    createdAt: at,
    ...overrides,
  });
}

function allowDecision(request: PublishingAuthorizationRequest): PermissionDecision {
  const actorReference = request.tenantContext.actor.actorReference;
  if (actorReference === null) throw new Error("synthetic actor missing");
  return evaluatePermission({
    tenantContext: request.tenantContext,
    action: request.action,
    resourceScope: request.resourceScope,
    policySnapshotReference: parsePolicyReference(ids.policy),
    policyVersion: parsePolicyVersion(1),
    evidence: [
      {
        source: "ExplicitAllow",
        evidenceReference: parseEvidenceReference(ids.permissionEvidence),
        action: request.action,
        actorReference,
        roleReference: null,
        brandReference: request.resourceScope.brandReference,
        storeReference: request.resourceScope.storeReference,
        effectiveFrom: before,
        effectiveUntil: until,
      },
    ],
  });
}

function ports(options?: {
  decision?: (request: PublishingAuthorizationRequest) => PermissionDecision;
  failCommit?: boolean;
}) {
  const commits: {
    expectedVersion: number;
    idempotencyKey: string;
    next: PublishingLifecycleRecord;
    release: PublishingReleaseRecord | null;
    audit: AppendAuditRecordInput;
    supersededReleaseId: string | null;
    rollbackTargetReleaseId: string | null;
  }[] = [];
  const value: PublishingPorts = {
    authorization: {
      authorize: vi.fn(async (request) => (options?.decision ?? allowDecision)(request)),
    },
    unitOfWork: {
      commit: vi.fn(async (input) => {
        if (options?.failCommit) throw new Error("synthetic atomic failure");
        commits.push(input);
      }),
    },
  };
  return { value, commits };
}

function mutation(
  operation: ExecutePublishingMutationInput["operation"],
  current: PublishingLifecycleRecord | null,
  next: PublishingLifecycleRecord,
  overrides: Partial<ExecutePublishingMutationInput> = {},
): ExecutePublishingMutationInput {
  return {
    tenantContext: context(next.scope.storeReference),
    operation,
    expectedVersion: parsePublishingVersion(current?.version ?? 1),
    current,
    next,
    idempotencyKey: parsePublishingReference(ids.idempotency),
    auditId: parsePublishingReference(ids.audit),
    correlationId: parsePublishingReference(ids.correlation),
    occurredAt: at,
    sourceChannel: parsePublishingCode("MERCHANT_WEB"),
    ...overrides,
  };
}

describe("Publishing contracts and transition policy", () => {
  it("accepts only opaque exact metadata and freezes immutable records", () => {
    const record = lifecycle("Draft", 1);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.scope)).toBe(true);
    expect(record).not.toHaveProperty("payload");
    expect(() =>
      createPublishingLifecycleRecord({
        ...record,
        payload: { secret: "not allowed" },
      } as never),
    ).toThrow(PublishingContractError);
    expect(() => parsePublishingDigest(`sha256:${"z".repeat(64)}`)).toThrow(
      PublishingContractError,
    );
  });

  it("allows only sequential versioned lifecycle transitions", () => {
    const draft1 = lifecycle("Draft", 1);
    const draft2 = lifecycle("Draft", 2, {
      snapshotReference: parsePublishingReference(ids.snapshotB),
      snapshotDigest: digestB,
    });
    expect(
      evaluatePublishingTransition({
        operation: "CreateDraft",
        expectedVersion: parsePublishingVersion(1),
        current: draft1,
        next: draft2,
      }).allowed,
    ).toBe(true);
    expect(
      evaluatePublishingTransition({
        operation: "Publish",
        expectedVersion: parsePublishingVersion(1),
        current: draft1,
        next: lifecycle("Published", 2),
      }).allowed,
    ).toBe(false);
    expect(
      evaluatePublishingTransition({
        operation: "Archive",
        expectedVersion: parsePublishingVersion(3),
        current: lifecycle("Published", 4),
        next: lifecycle("Archived", 5),
      }).allowed,
    ).toBe(false);
  });
});

describe("Publishing application service", () => {
  it("creates a Draft with exact Permission and one atomic Audit commit", async () => {
    const next = lifecycle("Draft", 1);
    const harness = ports();
    const result = await executePublishingMutation(
      mutation("CreateDraft", null, next),
      harness.value,
    );
    expect(result.lifecycle).toEqual(next);
    expect(result.release).toBeNull();
    expect(harness.commits).toHaveLength(1);
    expect(harness.commits[0]?.expectedVersion).toBe(1);
    expect(harness.commits[0]?.idempotencyKey).toBe(ids.idempotency);
    expect(harness.commits[0]?.audit.actionCode).toBe("PUBLISHING_DRAFT_CREATED");
    expect(harness.commits[0]?.audit).not.toHaveProperty("snapshotDigest");
  });

  it("binds Submit Review to current successful validation evidence", async () => {
    const current = lifecycle("Draft", 1);
    const next = lifecycle("InReview", 2);
    const harness = ports();
    await executePublishingMutation(
      mutation("SubmitReview", current, next, { validationEvidence: validation(next) }),
      harness.value,
    );
    await expect(
      executePublishingMutation(
        mutation("SubmitReview", current, next, {
          validationEvidence: validation(next, {
            snapshotReference: parsePublishingReference(ids.snapshotB),
          }),
        }),
        ports().value,
      ),
    ).rejects.toMatchObject({ code: "PUBLISHING_VALIDATION_DENIED" });
    await expect(
      executePublishingMutation(
        mutation("SubmitReview", current, next, {
          validationEvidence: validation(next, { validUntil: at }),
        }),
        ports().value,
      ),
    ).rejects.toMatchObject({ code: "PUBLISHING_VALIDATION_DENIED" });
  });

  it("binds Approve to the exact review and approving Actor", async () => {
    const current = lifecycle("InReview", 2);
    const next = lifecycle("Approved", 3);
    const harness = ports();
    await executePublishingMutation(
      mutation("Approve", current, next, { approvalEvidence: approval(current) }),
      harness.value,
    );
    await expect(
      executePublishingMutation(
        mutation("Approve", current, next, {
          approvalEvidence: approval(current, {
            approvedActorReference: parsePublishingReference(ids.otherActor),
          }),
        }),
        ports().value,
      ),
    ).rejects.toMatchObject({ code: "PUBLISHING_APPROVAL_DENIED" });
    await expect(
      executePublishingMutation(
        mutation("Approve", current, next, {
          approvalEvidence: approval(current, {
            reviewVersion: parsePublishingVersion(1),
          }),
        }),
        ports().value,
      ),
    ).rejects.toMatchObject({ code: "PUBLISHING_APPROVAL_DENIED" });
  });

  it("publishes an Approved snapshot as a new immutable Release Record", async () => {
    const current = lifecycle("Approved", 3);
    const next = lifecycle("Published", 4);
    const previous = release(current, 1, ids.release1, "Publish", null, {
      createdAt: before,
    });
    const nextRelease = release(next, 2, ids.release2, "Publish", ids.release1);
    const harness = ports();
    const result = await executePublishingMutation(
      mutation("Publish", current, next, {
        validationEvidence: validation(current),
        approvalEvidence: approval(current),
        previousRelease: previous,
        release: nextRelease,
      }),
      harness.value,
    );
    expect(result.release).toEqual(nextRelease);
    expect(harness.commits[0]?.supersededReleaseId).toBe(ids.release1);
    expect(harness.commits[0]?.release).toEqual(nextRelease);
  });

  it("rejects Publish when evidence, release sequence or exact snapshot is stale", async () => {
    const current = lifecycle("Approved", 3);
    const next = lifecycle("Published", 4);
    const previous = release(current, 1, ids.release1, "Publish", null, {
      createdAt: before,
    });
    await expect(
      executePublishingMutation(
        mutation("Publish", current, next, {
          validationEvidence: validation(current, { validUntil: at }),
          approvalEvidence: approval(current),
          previousRelease: previous,
          release: release(next, 2, ids.release2, "Publish", ids.release1),
        }),
        ports().value,
      ),
    ).rejects.toMatchObject({ code: "PUBLISHING_VALIDATION_DENIED" });
    await expect(
      executePublishingMutation(
        mutation("Publish", current, next, {
          validationEvidence: validation(current),
          approvalEvidence: approval(current),
          previousRelease: previous,
          release: release(next, 3, ids.release2, "Publish", ids.release1),
        }),
        ports().value,
      ),
    ).rejects.toMatchObject({ code: "PUBLISHING_RELEASE_DENIED" });
  });

  it("rolls back only through a new approved Release that targets an eligible prior snapshot", async () => {
    const candidate = lifecycle("Approved", 3);
    const next = lifecycle("Published", 4);
    const target = release(candidate, 1, ids.release1, "Publish", null, {
      sourceLifecycleId: parsePublishingReference(ids.lifecycle),
      createdAt: before,
    });
    const latest = release(
      lifecycle("Published", 7, {
        snapshotReference: parsePublishingReference(ids.snapshotB),
        snapshotDigest: digestB,
      }),
      2,
      ids.release2,
      "Publish",
      ids.release1,
      { createdAt: before },
    );
    const rollbackRelease = release(next, 3, ids.release3, "Rollback", ids.release2);
    const harness = ports();
    await executePublishingMutation(
      mutation("Rollback", candidate, next, {
        validationEvidence: validation(candidate),
        approvalEvidence: approval(candidate),
        previousRelease: latest,
        rollbackTarget: target,
        release: rollbackRelease,
      }),
      harness.value,
    );
    expect(harness.commits[0]?.supersededReleaseId).toBe(ids.release2);
    expect(harness.commits[0]?.rollbackTargetReleaseId).toBe(ids.release1);
    await expect(
      executePublishingMutation(
        mutation("Rollback", candidate, next, {
          validationEvidence: validation(candidate),
          approvalEvidence: approval(candidate),
          previousRelease: latest,
          rollbackTarget: latest,
          release: rollbackRelease,
        }),
        ports().value,
      ),
    ).rejects.toMatchObject({ code: "PUBLISHING_RELEASE_DENIED" });
  });

  it("archives without erasing Release history or creating a new Release", async () => {
    const current = lifecycle("Published", 4);
    const next = lifecycle("Archived", 5);
    const harness = ports();
    await executePublishingMutation(mutation("Archive", current, next), harness.value);
    expect(harness.commits[0]?.release).toBeNull();
    expect(harness.commits[0]?.supersededReleaseId).toBeNull();
  });

  it("fails closed on cross-Tenant scope before authorization", async () => {
    const next = lifecycle("Draft", 1);
    const harness = ports();
    await expect(
      executePublishingMutation(
        mutation("CreateDraft", null, next, {
          tenantContext: context(ids.otherStore, ids.brand),
        }),
        harness.value,
      ),
    ).rejects.toMatchObject({ code: "PUBLISHING_MUTATION_INVALID" });
    expect(harness.value.authorization.authorize).not.toHaveBeenCalled();

    const envelopeHarness = ports();
    await expect(
      executePublishingMutation(
        {
          ...mutation("CreateDraft", null, next),
          payload: { hidden: "not accepted" },
        } as never,
        envelopeHarness.value,
      ),
    ).rejects.toMatchObject({ code: "PUBLISHING_MUTATION_INVALID" });
    expect(envelopeHarness.value.authorization.authorize).not.toHaveBeenCalled();
  });

  it("fails closed on Permission denial and does not commit", async () => {
    const next = lifecycle("Draft", 1);
    const harness = ports({
      decision: (request) =>
        Object.freeze({
          ...allowDecision(request),
          effect: "Deny" as const,
          reason: "DEFAULT_DENY" as const,
        }),
    });
    await expect(
      executePublishingMutation(mutation("CreateDraft", null, next), harness.value),
    ).rejects.toMatchObject({ code: "PUBLISHING_PERMISSION_DENIED" });
    expect(harness.value.unitOfWork.commit).not.toHaveBeenCalled();

    const unavailable = ports();
    vi.mocked(unavailable.value.authorization.authorize).mockRejectedValueOnce(
      new Error(`sensitive adapter detail ${ids.brand}`),
    );
    await expect(
      executePublishingMutation(mutation("CreateDraft", null, next), unavailable.value),
    ).rejects.toMatchObject({
      code: "PUBLISHING_PERMISSION_DENIED",
      message: "publishing operation is unavailable",
    });
  });

  it("rejects stale expected version and exposes no identifier in bounded errors", async () => {
    const current = lifecycle("Published", 4);
    const next = lifecycle("Archived", 5);
    await expect(
      executePublishingMutation(
        mutation("Archive", current, next, {
          expectedVersion: parsePublishingVersion(3),
        }),
        ports().value,
      ),
    ).rejects.toMatchObject({
      code: "PUBLISHING_MUTATION_INVALID",
      message: "publishing operation is unavailable",
    });
  });

  it("reports an atomic commit failure without claiming partial success", async () => {
    await expect(
      executePublishingMutation(
        mutation("CreateDraft", null, lifecycle("Draft", 1)),
        ports({ failCommit: true }).value,
      ),
    ).rejects.toMatchObject({ code: "PUBLISHING_COMMIT_FAILED" });
  });

  it("returns an explicit unsupported capability for Schedule", () => {
    expect(schedulePublishing).toThrow(
      expect.objectContaining<Partial<PublishingServiceError>>({
        code: "PUBLISHING_SCHEDULE_UNSUPPORTED",
      }),
    );
  });

  it("rejects ambiguous release sequence and cross-scope publication", async () => {
    const current = lifecycle("Approved", 3);
    const record = lifecycle("Published", 4);
    expect(() =>
      createPublishingReleaseRecord({
        ...release(record, 1, ids.release1),
        sequence: 0 as never,
      }),
    ).toThrow(PublishingContractError);
    const crossScopeRelease = createPublishingReleaseRecord({
      ...release(record, 1, ids.release1),
      scope: scope(null, ids.otherBrand),
    });
    await expect(
      executePublishingMutation(
        mutation("Publish", current, record, {
          validationEvidence: validation(current),
          approvalEvidence: approval(current),
          release: crossScopeRelease,
        }),
        ports().value,
      ),
    ).rejects.toMatchObject({ code: "PUBLISHING_RELEASE_DENIED" });
  });

  it("parses canonical future instants without treating them as current evidence", () => {
    const record = lifecycle("InReview", 2);
    expect(() =>
      createPublishingValidationEvidence({
        ...validation(record),
        checkedAt: later,
        validUntil: before,
      }),
    ).toThrow(PublishingContractError);
  });
});
