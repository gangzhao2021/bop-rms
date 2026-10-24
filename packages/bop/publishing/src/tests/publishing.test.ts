import {
  parsePublishingOptionSetReviewPolicy,
  parsePublishingOptionSetApprovalWaiver,
} from "../contracts/option-set-approval-waiver.js";
import {
  publishingOptionSetPublicationPolicyDigest,
  optionSetPolicyScopeLevels,
} from "../index.js";
import { publishingProductPublicationPolicyDigest, productPolicyScopeLevels } from "../index.js";
import {
  evaluatePermission,
  evaluateBrandAdministrationPermission,
  parseEvidenceReference,
  parsePolicyReference,
  parsePolicyVersion,
  type PermissionDecision,
} from "@bop/permission";
import {
  createBrand,
  createStore,
  createTenantContext,
  createBrandAdministrationContext,
} from "@bop/tenant";
import { describe, expect, it, vi } from "vitest";
import { executeBrandAdministrationPublishingMutation } from "../application/publishing-service.js";
import {
  createPostgresPublishingMutationStore,
  parseRecordedPublishingMutation,
  publishingRecordedMutationDigest,
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
  type CommitPublishingMutationInput,
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

function context(
  storeReference: string | null = ids.store,
  brandReference: string = ids.brand,
  actorReference: string = ids.actor,
) {
  const actor = {
    actorType: "User" as const,
    accountKind: "Workforce" as const,
    actorReference,
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
  const commits: CommitPublishingMutationInput[] = [];
  const value: PublishingPorts = {
    authorization: {
      authorize: vi.fn(async (request) => (options?.decision ?? allowDecision)(request)),
    },
    unitOfWork: {
      commit: vi.fn(async (input) => {
        if (options?.failCommit) throw new Error("synthetic atomic failure");
        commits.push(input);
        return { auditReference: parsePublishingReference(input.audit.auditId) };
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
  it("binds and detaches a typed Product policy before committing through current authorization", async () => {
    const body = {
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: ids.policy,
      brandReference: ids.brand,
      familyReference: ids.family,
      policyReference: ids.snapshotA,
      policyVersion: 1,
      scopeOrder: [...productPolicyScopeLevels],
      approvalPolicy: "Required",
      warningOverrideAllowed: false,
      requiredLocales: ["en-CA"],
      mediaRequirement: "Required",
      effectiveFrom: at,
      effectiveUntil: null,
    };
    const next = createPublishingLifecycleRecord({
      ...lifecycle("Draft", 1),
      scope: createPublishingScope({
        kind: "Brand",
        brandReference: ids.brand,
        storeReference: null,
      }),
      configurationType: parsePublishingCode("PRODUCT_PUBLICATION_POLICY"),
      purposeCode: parsePublishingCode("PRODUCT_PUBLICATION_POLICY"),
      snapshotDigest: parsePublishingDigest(publishingProductPublicationPolicyDigest(body)),
    });
    const harness = ports();
    await executePublishingMutation(
      mutation("CreateDraft", null, next, { productPolicyContent: body }),
      harness.value,
    );
    body.requiredLocales.push("fr-CA");
    expect(harness.commits[0]?.productPolicyContent?.requiredLocales).toEqual(["en-CA"]);
    await expect(
      executePublishingMutation(
        mutation("CreateDraft", null, next, { productPolicyContent: body }),
        harness.value,
      ),
    ).rejects.toMatchObject({ code: "PUBLISHING_MUTATION_INVALID" });
    expect(harness.commits).toHaveLength(1);
  });

  it("returns the original persisted Audit receipt on replay", async () => {
    const harness = ports();
    const original = parsePublishingReference(ids.otherActor);
    harness.value.unitOfWork.commit = vi.fn(async () => ({ auditReference: original }));
    const result = await executePublishingMutation(
      mutation("CreateDraft", null, lifecycle("Draft", 1)),
      harness.value,
    );
    expect(result.auditReference).toBe(original);
  });

  it("retains detached validated review and approval facts for the atomic store", async () => {
    const draft = lifecycle("Draft", 1),
      review = lifecycle("InReview", 2),
      approved = lifecycle("Approved", 3),
      published = lifecycle("Published", 4);
    const harness = ports();
    const rawValidation = { ...validation(), checkCodes: [...validation().checkCodes] };
    const rawApproval = { ...approval() };
    await executePublishingMutation(
      mutation("SubmitReview", draft, review, { validationEvidence: rawValidation }),
      harness.value,
    );
    await executePublishingMutation(
      mutation("Approve", review, approved, { approvalEvidence: rawApproval }),
      harness.value,
    );
    await executePublishingMutation(
      mutation("Publish", approved, published, {
        validationEvidence: rawValidation,
        approvalEvidence: rawApproval,
        release: release(published, 1, ids.release1),
      }),
      harness.value,
    );
    const [submitted, accepted, released] = harness.commits;
    expect(submitted?.operation).toBe("SubmitReview");
    expect(submitted?.validationEvidence).toEqual(rawValidation);
    expect(submitted?.approvalEvidence).toBeNull();
    expect(accepted?.approvalEvidence).toEqual(rawApproval);
    expect(accepted?.validationEvidence).toBeNull();
    expect(released?.validationEvidence).toEqual(rawValidation);
    expect(released?.approvalEvidence).toEqual(rawApproval);
    rawValidation.checkCodes.length = 0;
    rawApproval.approvedActorReference = parsePublishingReference(ids.otherActor);
    expect(released?.validationEvidence?.checkCodes).toHaveLength(2);
    expect(released?.approvalEvidence?.approvedActorReference).toBe(ids.actor);
    expect(Object.isFrozen(released?.validationEvidence?.checkCodes)).toBe(true);
  });

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

describe("Option policy authorized application entry", () => {
  it("binds and detaches a typed Option policy before committing through current authorization", async () => {
    const body = {
      profile: "PublishingOptionSetPublicationPolicyV1",
      tenantReference: ids.policy,
      brandReference: ids.brand,
      familyReference: ids.family,
      policyReference: ids.snapshotA,
      policyVersion: 1,
      scopeOrder: [...optionSetPolicyScopeLevels],
      approvalPolicy: "Required",
      warningOverrideAllowed: false,
      requiredLocales: ["en-CA"],
      mediaRequirement: "Required",
      effectiveFrom: at,
      effectiveUntil: null,
    };
    const next = createPublishingLifecycleRecord({
      ...lifecycle("Draft", 1),
      scope: createPublishingScope({
        kind: "Brand",
        brandReference: ids.brand,
        storeReference: null,
      }),
      configurationType: parsePublishingCode("OPTION_SET_PUBLICATION_POLICY"),
      purposeCode: parsePublishingCode("OPTION_SET_PUBLICATION_POLICY"),
      snapshotDigest: parsePublishingDigest(publishingOptionSetPublicationPolicyDigest(body)),
    });
    const harness = ports();
    await executePublishingMutation(
      mutation("CreateDraft", null, next, { optionSetPolicyContent: body }),
      harness.value,
    );
    body.requiredLocales.push("fr-CA");
    expect(harness.commits[0]?.optionSetPolicyContent?.requiredLocales).toEqual(["en-CA"]);
    await expect(
      executePublishingMutation(
        mutation("CreateDraft", null, next, { optionSetPolicyContent: body }),
        harness.value,
      ),
    ).rejects.toMatchObject({ code: "PUBLISHING_MUTATION_INVALID" });
    expect(harness.commits).toHaveLength(1);
  });
});

describe("Option content policy waiver command compatibility", () => {
  function optionReview() {
    return lifecycle("InReview", 2, {
      configurationType: parsePublishingCode("CATALOG_OPTION_SET"),
      purposeCode: parsePublishingCode("CATALOG_OPTION_SET_PUBLICATION"),
      scope: scope(null),
      approvalEvidenceReference: null,
    });
  }
  function policyBinding(review: PublishingLifecycleRecord) {
    const policyContent = {
      profile: "PublishingOptionSetPublicationPolicyV1",
      tenantReference: ids.otherBrand,
      brandReference: ids.brand,
      familyReference: ids.policy,
      policyReference: ids.snapshotB,
      policyVersion: 1,
      scopeOrder: [...optionSetPolicyScopeLevels],
      approvalPolicy: "NotRequired",
      warningOverrideAllowed: false,
      requiredLocales: ["en-CA"],
      mediaRequirement: "Optional",
      effectiveFrom: before,
      effectiveUntil: until,
    };
    return parsePublishingOptionSetReviewPolicy({
      profile: "PublishingOptionSetReviewPolicyV1",
      tenantReference: ids.otherBrand,
      policyContent,
      policyReleaseReference: ids.release2,
      policyReleaseSequence: 1,
      policySnapshotDigest: publishingOptionSetPublicationPolicyDigest(policyContent),
      reviewOperationReference: ids.idempotency,
      reviewLifecycle: review,
      validationEvidence: validation(review),
      submittedActorReference: ids.actor,
      submittedAt: at,
    });
  }
  it("passes the immutable waiver with null Approval to the owning commit, without an Approve mutation", async () => {
    const current = optionReview(),
      next = createPublishingLifecycleRecord({
        ...current,
        state: "Published",
        version: parsePublishingVersion(3),
      });
    const waiver = parsePublishingOptionSetApprovalWaiver({
      profile: "PublishingOptionSetApprovalWaiverV1",
      reviewPolicy: policyBinding(current),
      recordedAt: at,
    });
    const harness = ports();
    await executePublishingMutation(
      mutation("Publish", current, next, {
        validationEvidence: validation(current),
        release: release(next, 1, ids.release1),
        optionSetApprovalWaiver: waiver,
      }),
      harness.value,
    );
    expect(harness.commits).toHaveLength(1);
    expect(harness.commits[0]?.approvalEvidence).toBeNull();
    expect(harness.commits[0]?.optionSetApprovalWaiver).toEqual(waiver);
  });
  it("refuses missing waiver or caller Approval on an InReview direct Publish", async () => {
    const current = optionReview(),
      next = createPublishingLifecycleRecord({
        ...current,
        state: "Published",
        version: parsePublishingVersion(3),
      }),
      harness = ports();
    const payload = mutation("Publish", current, next, {
      validationEvidence: validation(current),
      release: release(next, 1, ids.release1),
    });
    await expect(executePublishingMutation(payload, harness.value)).rejects.toMatchObject({
      code: "PUBLISHING_MUTATION_INVALID",
    });
    await expect(
      executePublishingMutation(
        {
          ...payload,
          optionSetApprovalWaiver: parsePublishingOptionSetApprovalWaiver({
            profile: "PublishingOptionSetApprovalWaiverV1",
            reviewPolicy: policyBinding(current),
            recordedAt: at,
          }),
          approvalEvidence: approval(current),
        },
        harness.value,
      ),
    ).rejects.toMatchObject({ code: "PUBLISHING_APPROVAL_DENIED" });
    expect(harness.commits).toHaveLength(0);
  });
  it("does not extend the waiver transition to policy governance, Menu, Store or Rollback", () => {
    const current = optionReview(),
      next = createPublishingLifecycleRecord({
        ...current,
        state: "Published",
        version: parsePublishingVersion(3),
      });
    for (const configurationType of [
      "OPTION_SET_PUBLICATION_POLICY",
      "MENU_CONFIGURATION",
      "PRODUCT_PUBLICATION_POLICY",
      "BRAND_CONFIGURATION",
      "WORKFLOW_DEFINITION",
    ]) {
      const prior = createPublishingLifecycleRecord({
          ...current,
          configurationType: parsePublishingCode(configurationType),
        }),
        after = createPublishingLifecycleRecord({
          ...next,
          configurationType: prior.configurationType,
        });
      expect(
        evaluatePublishingTransition({
          operation: "Publish",
          current: prior,
          next: after,
          expectedVersion: prior.version,
          optionSetApprovalWaived: true,
        }).allowed,
      ).toBe(false);
    }
    expect(
      evaluatePublishingTransition({
        operation: "Rollback",
        current,
        next,
        expectedVersion: current.version,
        optionSetApprovalWaived: true,
      }).allowed,
    ).toBe(false);
  });
});

function delayedOptionPublish() {
  const current = lifecycle("Approved", 3, {
    scope: scope(null),
    configurationType: parsePublishingCode("CATALOG_OPTION_SET"),
    purposeCode: parsePublishingCode("CATALOG_OPTION_SET_PUBLICATION"),
  });
  const next = lifecycle("Published", 4, {
    ...current,
    version: parsePublishingVersion(4),
    state: "Published",
  });
  const oldEnd = parsePublishingInstant("2026-07-29T17:55:05.000Z");
  const originalValidation = validation(current, {
    checkedAt: before,
    validUntil: oldEnd,
    checkCodes: [
      "CURRENT_REFERENCES",
      "PUBLISHING_POLICY",
      "RULE_SATISFIABILITY",
      "SCOPE_TOPOLOGY",
    ].map(parsePublishingCode),
  });
  const originalApproval = approval(current, { approvedAt: before, validUntil: oldEnd });
  const optionSetCurrentQualification = {
    profile: "PublishingOptionSetCurrentQualificationV1",
    tenantReference: ids.otherBrand,
    operationReference: ids.idempotency,
    actorReference: ids.actor,
    scope: current.scope,
    familyReference: current.familyReference,
    lifecycleReference: current.lifecycleId,
    expectedLifecycleVersion: current.version,
    latestMutationOperationReference: ids.release2,
    snapshotReference: current.snapshotReference,
    snapshotDigest: current.snapshotDigest,
    reviewOperationReference: ids.release3,
    validationEvidenceReference: ids.validation,
    approvalOperationReference: ids.release2,
    approvalEvidenceReference: ids.approval,
    policyReference: ids.policy,
    policyVersion: 1,
    policyContentDigest: digestA,
    policyPublicationReference: ids.release1,
    qualificationEvidenceReference: ids.permissionEvidence,
    qualificationReportDigest: digestA,
    result: "Pass",
    originalObservedAt: at,
    checkedAt: at,
    validUntil: "2026-07-29T18:00:05.000Z",
    checkCodes: [
      "CURRENT_REFERENCES",
      "PUBLISHING_POLICY",
      "RULE_SATISFIABILITY",
      "SCOPE_TOPOLOGY",
    ],
    sourceAssessmentDigests: [digestA],
  };
  return mutation("Publish", current, next, {
    validationEvidence: originalValidation,
    approvalEvidence: originalApproval,
    release: release(next, 1, ids.release1),
    optionSetCurrentQualification,
  });
}
it("retains expired original Option decisions while consuming distinct current qualification", async () => {
  const input = delayedOptionPublish(),
    p = ports();
  await executePublishingMutation(input, p.value);
  expect(p.commits[0]?.validationEvidence).toEqual(input.validationEvidence);
  expect(p.commits[0]?.approvalEvidence).toEqual(input.approvalEvidence);
  expect(p.commits[0]?.optionSetCurrentQualification?.validUntil).toBe("2026-07-29T18:00:05.000Z");
});
it.each([
  "operationReference",
  "actorReference",
  "snapshotDigest",
  "expectedLifecycleVersion",
  "validUntil",
])("rejects a stale or retargeted current Option %s before commit", async (field) => {
  const original = delayedOptionPublish(),
    q = original.optionSetCurrentQualification;
  if (!q || typeof q !== "object") throw Error("fixture qualification missing");
  const patch =
    field === "expectedLifecycleVersion"
      ? 2
      : field === "validUntil"
        ? at
        : field === "snapshotDigest"
          ? digestB
          : ids.otherActor;
  const p = ports();
  await expect(
    executePublishingMutation(
      { ...original, optionSetCurrentQualification: { ...q, [field]: patch } },
      p.value,
    ),
  ).rejects.toThrow();
  expect(p.commits).toHaveLength(0);
});
it("does not apply the Option-specific qualification branch to a Menu or ordinary stale legacy publication", async () => {
  const original = delayedOptionPublish(),
    p = ports();
  const legacy = { ...original };
  Reflect.deleteProperty(legacy, "optionSetCurrentQualification");
  await expect(executePublishingMutation(legacy, p.value)).rejects.toThrow();
  const menu = lifecycle("Approved", 3, { scope: scope(null) });
  await expect(
    executePublishingMutation(
      {
        ...original,
        current: menu,
        next: lifecycle("Published", 4, {
          ...menu,
          version: parsePublishingVersion(4),
          state: "Published",
        }),
        release: release(
          lifecycle("Published", 4, {
            ...menu,
            version: parsePublishingVersion(4),
            state: "Published",
          }),
          1,
          ids.release1,
        ),
      },
      p.value,
    ),
  ).rejects.toThrow();
  expect(p.commits).toHaveLength(0);
});

it("owner commit refuses a valid-shaped current proof without actual original review/approval history", async () => {
  const p = ports(),
    input = delayedOptionPublish();
  await executePublishingMutation(input, p.value);
  const committed = p.commits[0];
  if (!committed?.optionSetCurrentQualification) throw Error("fixture commit missing");
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    void sql;
    void values;
    return { rows: [] };
  });
  const owner = createPostgresPublishingMutationStore(
    { run: (work) => work({ query }) },
    committed.optionSetCurrentQualification.tenantReference,
    committed.next.scope,
  );
  await expect(owner.commit(committed)).rejects.toThrow();
  expect(query.mock.calls.some(([sql]) => sql.includes("ORDER BY lifecycle_version DESC"))).toBe(
    true,
  );
  expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
});

it("actual independent approval remains a valid recorded decision under NotRequired policy", async () => {
  const { canonicalizeRfc8785, sha256Hex } = await import("@bop/audit");
  const id = (n: number) => "01902421-7100-7000-8000-" + n.toString(16).padStart(12, "0");
  const other = context(null, ids.brand, ids.otherActor);
  const history: CommitPublishingMutationInput[] = [];
  let sequence = 100;
  const apply = async (
    operation: ExecutePublishingMutationInput["operation"],
    current: PublishingLifecycleRecord | null,
    next: PublishingLifecycleRecord,
    extra: Partial<ExecutePublishingMutationInput> = {},
  ) => {
    const p = ports();
    await executePublishingMutation(
      mutation(operation, current, next, {
        idempotencyKey: parsePublishingReference(id(sequence++)),
        auditId: parsePublishingReference(id(sequence++)),
        ...extra,
      }),
      p.value,
    );
    const record = p.commits[0];
    if (!record) throw Error("fixture mutation missing");
    history.push(record);
    return record;
  };
  const policy = {
    profile: "PublishingOptionSetPublicationPolicyV1",
    tenantReference: ids.otherBrand,
    brandReference: ids.brand,
    familyReference: ids.policy,
    policyReference: ids.snapshotB,
    policyVersion: 1,
    scopeOrder: [...optionSetPolicyScopeLevels],
    approvalPolicy: "NotRequired",
    warningOverrideAllowed: false,
    requiredLocales: ["en-CA"],
    mediaRequirement: "Optional",
    effectiveFrom: before,
    effectiveUntil: until,
  };
  const base = {
    scope: scope(null),
    lifecycleId: parsePublishingReference(id(90)),
    familyReference: parsePublishingReference(ids.policy),
    configurationType: parsePublishingCode("OPTION_SET_PUBLICATION_POLICY"),
    purposeCode: parsePublishingCode("OPTION_SET_PUBLICATION_POLICY"),
    snapshotReference: parsePublishingReference(ids.snapshotB),
    snapshotDigest: parsePublishingDigest(publishingOptionSetPublicationPolicyDigest(policy)),
  };
  const pd = lifecycle("Draft", 1, base),
    pr = lifecycle("InReview", 2, base),
    pa = lifecycle("Approved", 3, base),
    pp = lifecycle("Published", 4, base);
  await apply("CreateDraft", null, pd, { optionSetPolicyContent: policy });
  const pv = validation(pr);
  await apply("SubmitReview", pd, pr, { tenantContext: other, validationEvidence: pv });
  const pe = approval(pr);
  await apply("Approve", pr, pa, { approvalEvidence: pe });
  const policyRelease = release(pp, 1, id(91));
  await apply("Publish", pa, pp, {
    validationEvidence: pv,
    approvalEvidence: pe,
    release: policyRelease,
  });
  const optionBase = {
    scope: scope(null),
    configurationType: parsePublishingCode("CATALOG_OPTION_SET"),
    purposeCode: parsePublishingCode("CATALOG_OPTION_SET_PUBLICATION"),
  };
  const draft = lifecycle("Draft", 1, optionBase),
    review = lifecycle("InReview", 2, optionBase),
    approved = lifecycle("Approved", 3, optionBase);
  await apply("CreateDraft", null, draft);
  const validationEvidence = validation(review, {
    validUntil: parsePublishingInstant("2026-07-29T18:00:05.000Z"),
    checkCodes: [
      "CURRENT_REFERENCES",
      "PUBLISHING_POLICY",
      "RULE_SATISFIABILITY",
      "SCOPE_TOPOLOGY",
    ].map(parsePublishingCode),
  });
  const reviewOperation = parsePublishingReference(id(sequence));
  const reviewPolicy = parsePublishingOptionSetReviewPolicy({
    profile: "PublishingOptionSetReviewPolicyV1",
    tenantReference: ids.otherBrand,
    policyContent: policy,
    policyReleaseReference: policyRelease.releaseId,
    policyReleaseSequence: policyRelease.sequence,
    policySnapshotDigest: policyRelease.snapshotDigest,
    reviewOperationReference: reviewOperation,
    reviewLifecycle: review,
    validationEvidence,
    submittedActorReference: ids.otherActor,
    submittedAt: at,
  });
  await apply("SubmitReview", draft, review, {
    tenantContext: other,
    validationEvidence,
    optionSetReviewPolicy: reviewPolicy,
  });
  const originalApproval = approval(review, {
    approvedAt: at,
    validUntil: parsePublishingInstant("2026-07-29T18:00:05.000Z"),
  });
  const approvedRecord = await apply("Approve", review, approved, {
    approvalEvidence: originalApproval,
  });
  const row = (record: CommitPublishingMutationInput) => ({
    mutation_json: record,
    intent_hash:
      "sha256:" +
      sha256Hex(canonicalizeRfc8785({ ...record, audit: { ...record.audit, auditId: null } })),
  });
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    if (sql === "SELECT current_setting('transaction_isolation') AS isolation")
      return { rows: [{ isolation: "read committed" }] };
    if (sql.startsWith("SELECT set_config") || sql.startsWith("LOCK TABLE")) return { rows: [] };
    if (sql.includes("operation_code='CreateDraft'"))
      return { rows: history.filter((m) => m.optionSetPolicyContent).map(row) };
    if (sql.includes("release_id=$3"))
      return { rows: history.filter((m) => m.release?.releaseId === values[2]).map(row) };
    if (sql.includes("family_id=$4") && sql.includes("release_id IS NOT NULL"))
      return {
        rows: history
          .filter((m) => m.next.familyReference === values[3] && m.release !== null)
          .map(row),
      };
    if (sql.includes("family_id=$3") && sql.includes("release_id IS NOT NULL"))
      return {
        rows: history
          .filter((m) => m.next.familyReference === values[2] && m.release !== null)
          .map(row),
      };
    if (sql.includes("lifecycle_id=$4"))
      return {
        rows: history
          .filter((m) => m.next.lifecycleId === values[3])
          .sort((a, b) =>
            sql.includes("DESC")
              ? b.next.version - a.next.version
              : a.next.version - b.next.version,
          )
          .map(row),
      };
    if (sql.includes("lifecycle_id=$3"))
      return {
        rows: history
          .filter((m) => m.next.lifecycleId === values[2])
          .sort((a, b) => b.next.version - a.next.version)
          .map(row),
      };
    throw Error("unexpected fixture owner query");
  });
  const owner = createPostgresPublishingMutationStore(
    { run: (work) => work({ query }) },
    ids.otherBrand,
    scope(null),
    { optionSetPolicyFamilyReference: ids.policy },
  );
  const result = await owner.resolveCurrentOptionSetPublicationCandidate({
    familyReference: ids.family,
    lifecycleReference: ids.lifecycle,
    observedAt: "2026-07-29T18:10:00.000Z",
  });
  expect(result.originalApprovalEvidence).toEqual(originalApproval);
  expect(result.originalValidationEvidence.validUntil).toBe("2026-07-29T18:00:05.000Z");
  expect(result.reviewPolicy.policyContent.approvalPolicy).toBe("NotRequired");
  expect(result.approvalOperationReference).toBe(approvedRecord.idempotencyKey);
  expect(result.lifecycle.state).toBe("Approved");
});

describe("original operation detached owning mutation identity", () => {
  it("uses the existing canonical intent with Audit allocation excluded", async () => {
    const harness = ports();
    await executePublishingMutation(
      mutation("CreateDraft", null, lifecycle("Draft", 1)),
      harness.value,
    );
    const original = harness.commits[0];
    if (!original) throw new Error("missing owning commit");
    const detached = parseRecordedPublishingMutation(original);
    expect(detached).toEqual(original);
    expect(
      publishingRecordedMutationDigest({
        ...original,
        audit: { ...original.audit, auditId: parsePublishingReference(ids.otherActor) },
      }),
    ).toBe(publishingRecordedMutationDigest(original));
    expect(
      publishingRecordedMutationDigest({
        ...original,
        idempotencyKey: parsePublishingReference(ids.otherActor),
      }),
    ).not.toBe(publishingRecordedMutationDigest(original));
  });
  it("rejects nested accessor and extension without acquiring caller facts", async () => {
    const harness = ports();
    await executePublishingMutation(
      mutation("CreateDraft", null, lifecycle("Draft", 1)),
      harness.value,
    );
    const original = harness.commits[0];
    if (!original) throw new Error("missing owning commit");
    const get = vi.fn(() => original.audit.occurredAt),
      raw = { ...original, audit: { ...original.audit } };
    Object.defineProperty(raw.audit, "occurredAt", { get, enumerable: true });
    expect(() => parseRecordedPublishingMutation(raw)).toThrow();
    expect(get).not.toHaveBeenCalled();
    expect(() => parseRecordedPublishingMutation({ ...original, callerPass: true })).toThrow();
  });
});

describe("recorded Option Review two-owner reference source", () => {
  async function source(approvalPolicy: "Required" | null = "Required", approved = false) {
    const base = {
        scope: scope(null),
        configurationType: parsePublishingCode("CATALOG_OPTION_SET"),
        purposeCode: parsePublishingCode("CATALOG_OPTION_SET_PUBLICATION"),
      },
      draft = lifecycle("Draft", 1, base),
      review = lifecycle("InReview", 2, base),
      accepted = lifecycle("Approved", 3, base);
    const history: CommitPublishingMutationInput[] = [];
    const apply = async (input: ExecutePublishingMutationInput) => {
      const p = ports();
      await executePublishingMutation(input, p.value);
      const record = p.commits[0];
      if (!record) throw new Error("missing real service record");
      history.push(record);
    };
    await apply(
      mutation("CreateDraft", null, draft, {
        idempotencyKey: parsePublishingReference(ids.snapshotB),
      }),
    );
    const valid = validation(review, {
      checkedAt: at,
      validUntil: parsePublishingInstant("2026-07-29T18:00:05.000Z"),
    });
    const content = {
      profile: "PublishingOptionSetPublicationPolicyV1",
      tenantReference: ids.otherBrand,
      brandReference: ids.brand,
      familyReference: ids.policy,
      policyReference: ids.snapshotB,
      policyVersion: 1,
      scopeOrder: [...optionSetPolicyScopeLevels],
      approvalPolicy: "Required",
      warningOverrideAllowed: false,
      requiredLocales: ["en-CA"],
      mediaRequirement: "Optional",
      effectiveFrom: before,
      effectiveUntil: until,
    };
    const binding =
      approvalPolicy === null
        ? undefined
        : parsePublishingOptionSetReviewPolicy({
            profile: "PublishingOptionSetReviewPolicyV1",
            tenantReference: ids.otherBrand,
            policyContent: content,
            policyReleaseReference: ids.release1,
            policyReleaseSequence: 1,
            policySnapshotDigest: publishingOptionSetPublicationPolicyDigest(content),
            reviewOperationReference: ids.idempotency,
            reviewLifecycle: review,
            validationEvidence: valid,
            submittedActorReference: ids.actor,
            submittedAt: at,
          });
    await apply(
      mutation("SubmitReview", draft, review, {
        validationEvidence: valid,
        ...(binding ? { optionSetReviewPolicy: binding } : {}),
      }),
    );
    if (approved)
      await apply(
        mutation("Approve", review, accepted, {
          tenantContext: context(null, ids.brand, ids.otherActor),
          idempotencyKey: parsePublishingReference(ids.otherActor),
          approvalEvidence: approval(review, {
            approvedActorReference: parsePublishingReference(ids.otherActor),
            approvedAt: at,
            validUntil: parsePublishingInstant("2026-07-29T18:00:05.000Z"),
          }),
        }),
      );
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT mutation_json,intent_hash"))
        return {
          rows: history.map((m) => ({
            mutation_json: m,
            intent_hash: publishingRecordedMutationDigest(m),
          })),
        };
      return { rows: [] };
    });
    const owner = createPostgresPublishingMutationStore(
      { run: (work) => work({ query }) },
      ids.otherBrand,
      scope(null),
    );
    return {
      owner,
      query,
      history,
      read: () =>
        owner.resolveRecordedOptionSetReviewForLifecycle({
          familyReference: ids.family,
          lifecycleReference: ids.lifecycle,
          observedAt: "2026-07-29T18:10:00.000Z",
        }),
    };
  }
  it("reads genuine Required InReview after original lease expiry without current policy or write admission", async () => {
    const f = await source(),
      packet = await f.read();
    expect(packet).toMatchObject({
      reviewOperationReference: ids.idempotency,
      submittedActorReference: ids.actor,
      submittedAt: at,
      latestMutationOperationReference: ids.idempotency,
      reviewPolicy: { policyContent: { approvalPolicy: "Required" } },
      sourceLease: "RequiresCurrentOuterTransactionAuthority",
    });
    expect(packet?.originalValidationEvidence.validUntil).toBe("2026-07-29T18:00:05.000Z");
    expect(
      f.query.mock.calls.some(
        ([sql]) => sql.includes("SHARE ROW EXCLUSIVE") || sql.includes("release_id"),
      ),
    ).toBe(false);
  });
  it("returns original Publishing Submit independently from latest actual approval and Catalog Review IDs", async () => {
    const f = await source("Required", true),
      packet = await f.read();
    expect(packet?.reviewOperationReference).toBe(ids.idempotency);
    expect(packet?.latestMutationOperationReference).toBe(ids.otherActor);
    expect(packet?.approvalOperationReference).toBe(ids.otherActor);
    expect(packet?.reviewLifecycle.state).toBe("InReview");
    expect(packet?.latestLifecycle.state).toBe("Approved");
    expect(packet?.originalApprovalEvidence?.validUntil).toBe("2026-07-29T18:00:05.000Z");
  });
  it("preserves a real legacy missing policy as null rather than fabricating approval policy", async () => {
    const f = await source(null);
    expect((await f.read())?.reviewPolicy).toBeNull();
  });
  it("rejects hash, scope, continuity, original evidence lease and independent approval corruption", async () => {
    const badHash = await source();
    badHash.query.mockImplementation(async (sql) =>
      sql.startsWith("SELECT mutation_json,intent_hash")
        ? { rows: badHash.history.map((m) => ({ mutation_json: m, intent_hash: digestB })) }
        : { rows: [] },
    );
    await expect(badHash.read()).rejects.toThrow();
    const wrongScope = await source();
    await expect(
      wrongScope.owner.resolveRecordedOptionSetReviewForLifecycle({
        familyReference: ids.otherBrand,
        lifecycleReference: ids.lifecycle,
        observedAt: "2026-07-29T18:10:00.000Z",
      }),
    ).rejects.toThrow();
    const missing = await source();
    missing.history.shift();
    await expect(missing.read()).rejects.toThrow();
    const expired = await source();
    const review = expired.history[1];
    if (!review?.validationEvidence) throw new Error("missing original Review");
    const { optionSetReviewPolicy: ignoredPolicy, ...legacyReview } = review;
    void ignoredPolicy;
    expired.history[1] = {
      ...legacyReview,
      validationEvidence: createPublishingValidationEvidence({
        ...review.validationEvidence,
        checkedAt: before,
        validUntil: at,
      }),
    };
    await expect(expired.read()).rejects.toThrow();
    const nonindependent = await source(null, true);
    const approved = nonindependent.history[2];
    if (!approved?.approvalEvidence) throw new Error("missing approval");
    nonindependent.history[2] = {
      ...approved,
      audit: { ...approved.audit, actor: { type: "User", reference: ids.actor } },
      approvalEvidence: createPublishingApprovalEvidence({
        ...approved.approvalEvidence,
        approvedActorReference: parsePublishingReference(ids.actor),
      }),
    };
    await expect(nonindependent.read()).rejects.toThrow();
  });
});

function administrativePublishingFixture() {
  const operational = context(null);
  const administrationContext = createBrandAdministrationContext(
    operational.actor,
    createBrand({ ...operational.brand, lifecycle: "Draft" }),
    at,
  );
  const next = lifecycle("Draft", 1, {
    scope: scope(null),
    familyReference: parsePublishingReference(ids.brand),
    configurationType: parsePublishingCode("BRAND_CONFIGURATION"),
    purposeCode: parsePublishingCode("BRAND_CONFIGURATION"),
  });
  const original = mutation("CreateDraft", null, next);
  const {
    tenantContext,
    optionSetCurrentQualification,
    optionSetReviewPolicy,
    optionSetApprovalWaiver,
    optionSetPolicyContent,
    optionPricePolicyContent,
    productPolicyContent,
    ...body
  } = original;
  void tenantContext;
  void optionSetCurrentQualification;
  void optionSetReviewPolicy;
  void optionSetApprovalWaiver;
  void optionSetPolicyContent;
  void optionPricePolicyContent;
  void productPolicyContent;
  const input = { ...body, administrationContext };
  const commits: CommitPublishingMutationInput[] = [];
  const authorization = vi.fn(
    async (
      request: import("../application/ports/publishing-ports.js").BrandAdministrationPublishingAuthorizationRequest,
    ) => {
      const ref = request.administrationContext.actor.actorReference;
      if (ref === null) throw new Error("Controlled named Actor required");
      if (request.resourceScope.kind !== "Brand" || request.resourceScope.storeReference !== null)
        throw new Error("Controlled Brand resource required");
      return evaluateBrandAdministrationPermission({
        administrationContext: request.administrationContext,
        action: request.action,
        resourceScope: {
          kind: "Brand",
          brandReference: request.resourceScope.brandReference,
          storeReference: null,
        },
        policySnapshotReference: parsePolicyReference(ids.policy),
        policyVersion: parsePolicyVersion(1),
        evidence: [
          {
            source: "ExplicitAllow",
            evidenceReference: parseEvidenceReference(ids.permissionEvidence),
            action: request.action,
            actorReference: ref,
            roleReference: null,
            brandReference: request.resourceScope.brandReference,
            storeReference: null,
            effectiveFrom: before,
            effectiveUntil: until,
          },
        ],
      });
    },
  );
  const unitOfWork = {
    commit: vi.fn(async (record: CommitPublishingMutationInput) => {
      commits.push(record);
      return { auditReference: parsePublishingReference(record.audit.auditId) };
    }),
  };
  return {
    input,
    ports: { authorization: { authorize: authorization }, unitOfWork },
    commits,
    authorization,
    operational,
  };
}
it("admits actual Draft Brand administration through the fixed configuration mutation kernel", async () => {
  const f = administrativePublishingFixture();
  const result = await executeBrandAdministrationPublishingMutation(f.input, f.ports);
  expect(result.lifecycle.state).toBe("Draft");
  expect(f.commits).toHaveLength(1);
  const auditActor = f.commits[0]?.audit.actor;
  if (!auditActor || auditActor.type !== "User")
    throw new Error("Actual named Audit Actor required");
  expect(auditActor.reference).toBe(f.input.administrationContext.actor.actorReference);
  expect(f.authorization.mock.calls[0]?.[0].administrationContext.profile).toBe(
    "BrandAdministrationContextV1",
  );
});
it("keeps operational execution strict and refuses administrative context laundering", async () => {
  const f = administrativePublishingFixture();
  const { administrationContext, ...body } = f.input;
  await expect(
    Reflect.apply(executePublishingMutation, undefined, [
      { ...body, tenantContext: administrationContext },
      ports().value,
    ]),
  ).rejects.toMatchObject({ code: "PUBLISHING_MUTATION_INVALID" });
  await expect(
    Reflect.apply(executeBrandAdministrationPublishingMutation, undefined, [
      { ...body, administrationContext: f.operational },
      f.ports,
    ]),
  ).rejects.toMatchObject({ code: "PUBLISHING_MUTATION_INVALID" });
  expect(f.commits).toHaveLength(0);
});
it.each(["family", "type", "purpose", "Store", "Brand", "Actor", "profile", "Rollback"])(
  "rejects administrative %s substitution before authorization",
  async (field) => {
    const f = administrativePublishingFixture();
    const value =
      field === "family"
        ? {
            ...f.input,
            next: { ...f.input.next, familyReference: parsePublishingReference(ids.family) },
          }
        : field === "type"
          ? {
              ...f.input,
              next: {
                ...f.input.next,
                configurationType: parsePublishingCode("MENU_CONFIGURATION"),
              },
            }
          : field === "purpose"
            ? {
                ...f.input,
                next: { ...f.input.next, purposeCode: parsePublishingCode("MENU_PUBLICATION") },
              }
            : field === "Store"
              ? { ...f.input, next: { ...f.input.next, scope: scope() } }
              : field === "Brand"
                ? { ...f.input, next: { ...f.input.next, scope: scope(null, ids.otherBrand) } }
                : field === "Actor"
                  ? {
                      ...f.input,
                      administrationContext: {
                        ...f.input.administrationContext,
                        actor: { ...f.input.administrationContext.actor, status: "Suspended" },
                      },
                    }
                  : field === "profile"
                    ? {
                        ...f.input,
                        administrationContext: {
                          ...f.input.administrationContext,
                          profile: "TenantContext",
                        },
                      }
                    : { ...f.input, operation: "Rollback" };
    await expect(
      Reflect.apply(executeBrandAdministrationPublishingMutation, undefined, [value, f.ports]),
    ).rejects.toMatchObject({ code: "PUBLISHING_MUTATION_INVALID" });
    expect(f.authorization).not.toHaveBeenCalled();
    expect(f.commits).toHaveLength(0);
  },
);
it("retains original validation expiry in administrative review", async () => {
  const f = administrativePublishingFixture();
  const next = createPublishingLifecycleRecord({
    ...f.input.next,
    state: "InReview",
    version: parsePublishingVersion(2),
    validationEvidenceReference: parsePublishingReference(ids.validation),
  });
  await expect(
    executeBrandAdministrationPublishingMutation(
      {
        ...f.input,
        operation: "SubmitReview",
        current: f.input.next,
        next,
        validationEvidence: validation(next, { validUntil: parsePublishingInstant(at) }),
      },
      f.ports,
    ),
  ).rejects.toMatchObject({ code: "PUBLISHING_VALIDATION_DENIED" });
  expect(f.commits).toHaveLength(0);
});
