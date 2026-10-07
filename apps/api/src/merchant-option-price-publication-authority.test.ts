import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentityActor } from "@bop/identity";
import { createBrand, createStore, createTenantContext, type TenantContext } from "@bop/tenant";
import { parseCatalogInstant } from "@rms/catalog";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  PublishingContractError,
  createPublishingScope,
  createPublishingLifecycleRecord,
  createPublishingReleaseRecord,
  createPublishingValidationEvidence,
  createPublishingApprovalEvidence,
  parsePublishingReference,
  parsePublishingCode,
  parsePublishingVersion,
  parsePublishingInstant,
  parsePublishingDigest,
  parseReleaseSequence,
  parsePublishingOptionPricePublicationPolicy,
  publishingOptionPricePublicationPolicyDigest,
  parseRecordedPublishingMutation,
  type createPostgresPublishingMutationStore,
} from "@bop/publishing";
import {
  evaluatePermission,
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
  parseEvidenceReference,
  parseEvidenceInstant,
  parseRoleReference,
} from "@bop/permission";
import {
  createCurrencyMetadataSnapshot,
  parseCurrencyCode,
  parsePricingReference,
  parsePricingDigest,
  parseOptionPriceAuthoringCommand,
  materializeOptionPriceVersion,
  optionPriceWireSnapshot,
  parseOptionPriceAuthoringState,
  optionPriceIntentDigest,
  type OptionPricePublicationAuthorization,
} from "@rms/pricing";
import {
  createMerchantOptionPricePublicationAuthority,
  optionPricePublicationReviewCheckCodes,
  type MerchantOptionPricePublicationAuthorityOptions,
} from "./merchant-option-price-publication-authority.js";
const controlled = vi.hoisted(() => ({
  create: vi.fn(),
  policy: vi.fn(),
  readReview: vi.fn(),
  approval: vi.fn(),
  review: vi.fn(),
}));
vi.mock("@bop/publishing", async (original) => ({
  ...(await original<typeof import("@bop/publishing")>()),
  createPostgresPublishingMutationStore: controlled.create,
}));
const id = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-05T12:00:00.000Z",
  plus = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
type Owner = ReturnType<typeof createPostgresPublishingMutationStore>;
// Real owner constructors, controlled owner read transport. This does not prove
// actual PostgreSQL, IAM, published governance or performed review checks.
function fixture(required = false, policyEnd: string | null = null) {
  let now = at,
    allow = true;
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const tx: MerchantOptionPricePublicationAuthorityOptions["transaction"] = { query };
  const command = parseOptionPriceAuthoringCommand({
    action: "CreateDraft",
    operationReference: id(10),
    ruleReference: id(11),
    expectedAggregateVersion: null,
    bindingReference: id(12),
    optionReference: id(13),
    content: {
      skuReference: null,
      scopeKind: "Brand",
      scopeReference: null,
      channelCode: null,
      orderType: null,
      unitAmountMinor: "125",
      includedQuantity: 1,
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: {
          instant: parsePublishingInstant(at),
          localDateTime: at.slice(0, 23),
          utcOffsetMinutes: 0,
        },
        effectiveUntil: null,
      },
    },
  });
  const currency = createCurrencyMetadataSnapshot({
    currencyCode: parseCurrencyCode("CAD"),
    minorUnitExponent: 2,
    metadataVersion: 1,
    metadataVersionReference: parsePricingReference(id(14)),
    metadataDigest: parsePricingDigest("sha256:" + "a".repeat(64)),
  });
  const draft = materializeOptionPriceVersion({
    command,
    current: null,
    brandReference: id(2),
    versionReference: id(15),
    occurredAt: at,
    currencyMetadata: currency,
  });
  const state = parseOptionPriceAuthoringState({
    profile: "OptionPriceAuthoringStateV1",
    brandReference: id(2),
    ruleReference: id(11),
    bindingReference: id(12),
    optionReference: id(13),
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(4),
    updatedAt: at,
    draftAuthorActorReference: id(4),
    draft: optionPriceWireSnapshot(draft),
    currentPublished: null,
    latestVersion: optionPriceWireSnapshot(draft),
  });
  const publish = parseOptionPriceAuthoringCommand({
    ...command,
    action: "Publish",
    operationReference: id(16),
    expectedAggregateVersion: 1,
    bindingReference: null,
    optionReference: null,
    content: null,
  });
  const scope = createPublishingScope({
    kind: "Brand",
    brandReference: id(2),
    storeReference: null,
  });
  const policy = parsePublishingOptionPricePublicationPolicy({
    profile: "PublishingOptionPricePublicationPolicyV1",
    tenantReference: id(1),
    brandReference: id(2),
    familyReference: id(20),
    policyReference: id(21),
    policyVersion: 1,
    approvalPolicy: required ? "Required" : "NotRequired",
    effectiveFrom: at,
    effectiveUntil: policyEnd,
  });
  const pd = publishingOptionPricePublicationPolicyDigest(policy),
    validation = createPublishingValidationEvidence({
      evidenceReference: parsePublishingReference(id(22)),
      snapshotReference: policy.policyReference,
      snapshotDigest: parsePublishingDigest(pd),
      scope,
      result: "Pass",
      checkedAt: parsePublishingInstant(at),
      validUntil: parsePublishingInstant(plus(60000)),
      checkCodes: [parsePublishingCode("POLICY_CONTENT")],
    }),
    governanceApproval = createPublishingApprovalEvidence({
      evidenceReference: parsePublishingReference(id(23)),
      reviewLifecycleId: parsePublishingReference(id(24)),
      reviewVersion: parsePublishingVersion(2),
      snapshotReference: policy.policyReference,
      snapshotDigest: parsePublishingDigest(pd),
      scope,
      decision: "Accepted",
      approvedActorReference: parsePublishingReference(id(25)),
      approvedAt: parsePublishingInstant(at),
      validUntil: parsePublishingInstant(plus(60000)),
    });
  const policyLife = createPublishingLifecycleRecord({
      lifecycleId: parsePublishingReference(id(24)),
      familyReference: policy.familyReference,
      configurationType: parsePublishingCode("OPTION_PRICE_PUBLICATION_POLICY"),
      purposeCode: parsePublishingCode("OPTION_PRICE_PUBLICATION_POLICY"),
      snapshotReference: policy.policyReference,
      snapshotDigest: parsePublishingDigest(pd),
      scope,
      version: parsePublishingVersion(4),
      state: "Published",
      validationEvidenceReference: validation.evidenceReference,
      approvalEvidenceReference: governanceApproval.evidenceReference,
      createdAt: parsePublishingInstant(at),
      changedAt: parsePublishingInstant(at),
    }),
    release = createPublishingReleaseRecord({
      releaseId: parsePublishingReference(id(26)),
      familyReference: policy.familyReference,
      configurationType: policyLife.configurationType,
      purposeCode: policyLife.purposeCode,
      snapshotReference: policy.policyReference,
      snapshotDigest: policyLife.snapshotDigest,
      scope,
      sequence: parseReleaseSequence(1),
      sourceLifecycleId: policyLife.lifecycleId,
      kind: "Publish",
      previousReleaseId: null,
      createdAt: parsePublishingInstant(at),
    });
  controlled.policy.mockImplementation(async () => ({
    content: policy,
    current: {
      release,
      lifecycle: policyLife,
      validationEvidence: validation,
      approvalEvidence: governanceApproval,
      auditReference: parsePublishingReference(id(27)),
      observedAt: parsePublishingInstant(now),
    },
    observedAt: parsePublishingInstant(now),
  }));
  const reviewValidation = createPublishingValidationEvidence({
      evidenceReference: parsePublishingReference(id(30)),
      snapshotReference: parsePublishingReference(String(draft.versionReference)),
      snapshotDigest: parsePublishingDigest(String(draft.snapshotDigest)),
      scope,
      result: "Pass",
      checkedAt: parsePublishingInstant(at),
      validUntil: parsePublishingInstant(plus(60000)),
      checkCodes: optionPricePublicationReviewCheckCodes.map(parsePublishingCode),
    }),
    reviewApproval = createPublishingApprovalEvidence({
      evidenceReference: parsePublishingReference(id(31)),
      reviewLifecycleId: parsePublishingReference(id(32)),
      reviewVersion: parsePublishingVersion(2),
      snapshotReference: reviewValidation.snapshotReference,
      snapshotDigest: reviewValidation.snapshotDigest,
      scope,
      decision: "Accepted",
      approvedActorReference: parsePublishingReference(id(5)),
      approvedAt: parsePublishingInstant(at),
      validUntil: parsePublishingInstant(plus(60000)),
    });
  const life = (state: "Draft" | "InReview" | "Approved", version: number) =>
    createPublishingLifecycleRecord({
      lifecycleId: parsePublishingReference(id(32)),
      familyReference: parsePublishingReference(id(11)),
      configurationType: parsePublishingCode("OPTION_PRICE_RULE"),
      purposeCode: parsePublishingCode("OPTION_PRICE_RULE_PUBLICATION"),
      snapshotReference: reviewValidation.snapshotReference,
      snapshotDigest: reviewValidation.snapshotDigest,
      scope,
      version: parsePublishingVersion(version),
      state,
      validationEvidenceReference: state === "Draft" ? null : reviewValidation.evidenceReference,
      approvalEvidenceReference: state === "Approved" ? reviewApproval.evidenceReference : null,
      createdAt: parsePublishingInstant(at),
      changedAt: parsePublishingInstant(at),
    });
  const d = life("Draft", 1),
    r = life("InReview", 2),
    a = life("Approved", 3);
  const record = (
    operation: "CreateDraft" | "SubmitReview" | "Approve",
    current: typeof d | null,
    next: typeof d,
    n: number,
  ) =>
    parseRecordedPublishingMutation({
      operation,
      current,
      next,
      expectedVersion: current?.version ?? 1,
      idempotencyKey: id(40 + n),
      release: null,
      supersededReleaseId: null,
      rollbackTargetReleaseId: null,
      validationEvidence: operation === "SubmitReview" ? reviewValidation : null,
      approvalEvidence: operation === "Approve" ? reviewApproval : null,
      audit: {
        auditId: id(50 + n),
        brandId: id(2),
        actor: { type: "User", reference: operation === "Approve" ? id(5) : id(6) },
        actionCode: {
          CreateDraft: "PUBLISHING_DRAFT_CREATED",
          SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
          Approve: "PUBLISHING_REVIEW_APPROVED",
        }[operation],
        targetType: "PublishingLifecycle",
        targetId: id(32),
        reasonCode: "AUTHORIZED_OPERATION",
        correlationId: id(16),
        occurredAt: at,
        sourceChannel: "API",
        dataClassification: "Confidential",
        retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
        retentionPolicyVersion: 1,
      },
    });
  const rd = record("CreateDraft", null, d, 1),
    rr = record("SubmitReview", d, r, 2),
    ra = record("Approve", r, a, 3);
  controlled.readReview.mockImplementation(async () => ({
    outcome: "Recorded",
    familyReference: a.familyReference,
    snapshotReference: a.snapshotReference,
    snapshotDigest: a.snapshotDigest,
    draft: rd,
    review: rr,
    approval: ra,
    latest: ra,
    observedAt: parsePublishingInstant(now),
  }));
  const independentBody = {
    profile: "CurrentIndependentPublishingApprovalV1",
    tenantReference: parsePublishingReference(id(1)),
    scope,
    familyReference: a.familyReference,
    lifecycleReference: a.lifecycleId,
    configurationType: a.configurationType,
    purposeCode: a.purposeCode,
    snapshotReference: a.snapshotReference,
    snapshotDigest: a.snapshotDigest,
    approvedLifecycleVersion: a.version,
    reviewVersion: r.version,
    draftOperationReference: rd.idempotencyKey,
    reviewOperationReference: rr.idempotencyKey,
    approvalOperationReference: ra.idempotencyKey,
    requestedByActorReference: parsePublishingReference(id(6)),
    approvedByActorReference: parsePublishingReference(id(5)),
    validationEvidenceReference: reviewValidation.evidenceReference,
    approvalEvidenceReference: reviewApproval.evidenceReference,
    validationCheckCodes: Object.freeze(
      [...optionPricePublicationReviewCheckCodes].sort().map(parsePublishingCode),
    ),
    observedAt: parsePublishingInstant(at),
    validUntil: parsePublishingInstant(plus(60000)),
    sourceDigest: parsePublishingDigest("sha256:" + "c".repeat(64)),
    recordedIndependence: "Verified",
    currentValidation: "NotEvaluated",
    referenceEligibility: "NotEvaluated",
    eligibility: "NotEvaluated",
  };
  const withDigest = (
    body: Omit<Awaited<ReturnType<Owner["resolveCurrentIndependentApproval"]>>, "digest">,
  ): Awaited<ReturnType<Owner["resolveCurrentIndependentApproval"]>> =>
    Object.freeze({ ...body, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) });
  const independent = withDigest({
    ...independentBody,
    profile: "CurrentIndependentPublishingApprovalV1",
    recordedIndependence: "Verified",
    currentValidation: "NotEvaluated",
    referenceEligibility: "NotEvaluated",
    eligibility: "NotEvaluated",
  });
  const alterApproval = (changes: Partial<typeof independent> = {}) => {
    const { digest, ...body } = { ...independent, ...changes };
    void digest;
    return withDigest(body);
  };
  controlled.approval.mockImplementation(async () =>
    alterApproval({ observedAt: parsePublishingInstant(now) }),
  );
  controlled.review.mockImplementation(
    async (
      _input: unknown,
      work: (held: { readForDraft: typeof controlled.readReview }) => Promise<unknown>,
    ) => {
      void _input;
      // Faithful protectedRun behavior: any callback/read failure becomes
      // the owner's bounded contract error, never a caller Pricing error.
      try {
        return await work({ readForDraft: controlled.readReview });
      } catch {
        throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
      }
    },
  );
  controlled.create.mockReturnValue({
    resolveCurrentOptionPricePublicationPolicy: controlled.policy,
    withOptionPriceReview: controlled.review,
    resolveCurrentIndependentApproval: controlled.approval,
  });
  const actor = createIdentityActor({
    actorType: "User",
    actorReference: id(4),
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: at,
    recentMfaAt: null,
  });
  const actorReference = actor.actorReference;
  if (actorReference === null) throw new Error("missing controlled Workforce Actor");
  const brand = createBrand({
    brandReference: id(2),
    code: "BRAND",
    displayName: "Controlled Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const store = createStore({
    storeReference: id(3),
    brandReference: id(2),
    code: "STORE",
    displayName: "Controlled Store",
    timeZone: "UTC",
    locale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const hooks: { guard: () => Promise<void>; final: () => void }[] = [],
    combined = vi.fn(async (actions: readonly string[]) =>
      Object.freeze(
        actions.map((action) =>
          evaluatePermission({
            tenantContext: createTenantContext(actor, brand, null, now),
            action: parseBusinessAction(action),
            resourceScope: {
              kind: "Brand",
              brandReference: brand.brandReference,
              storeReference: null,
            },
            policySnapshotReference: parsePolicyReference(id(60)),
            policyVersion: parsePolicyVersion(1),
            evidence: [
              {
                source: allow ? "RolePermission" : "ExplicitDeny",
                evidenceReference: parseEvidenceReference(id(61)),
                action: parseBusinessAction(action),
                actorReference,
                roleReference: allow ? parseRoleReference(id(62)) : null,
                brandReference: brand.brandReference,
                storeReference: null,
                effectiveFrom: parseEvidenceInstant(at),
                effectiveUntil: null,
              },
            ],
          }),
        ),
      ),
    );
  const opts: MerchantOptionPricePublicationAuthorityOptions = {
    transaction: tx,
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    sessionReference: id(7),
    originalObservedAt: at,
    originalValidUntil: plus(5000),
    operationReference: id(16),
    ruleReference: id(11),
    expectedAggregateVersion: 1,
    publicationPolicyFamilyReference: id(20),
    clock: { now: () => now },
    currentAuthorization: {
      authorizeActions: vi.fn(),
      authorizeActionsWithDecisions: vi.fn(),
      assertCurrent: vi.fn(),
      leaseDeadline: () => parseCatalogInstant(plus(5000)),
      async withCurrentStoreScope<T>(
        _input: unknown,
        work: (context: TenantContext) => Promise<T>,
      ) {
        void _input;
        return work(createTenantContext(actor, brand, store, now));
      },
    },
    capability: {
      holdUntilCommit: vi.fn(),
      holdUntilCommitWithDecisions: combined,
      leaseDeadline: () => plus(5000),
    },
    registerBeforeCommit: async (_tx, guard, final) => {
      expect(_tx).toBe(tx);
      if (!final) throw new Error("missing final");
      hooks.push({ guard, final });
    },
  };
  const source = createMerchantOptionPricePublicationAuthority(opts),
    invoke = <T>(work: (packet: OptionPricePublicationAuthorization) => Promise<T>) =>
      source.withCurrentAuthorization(
        tx,
        {
          command: publish,
          originalIntentDigest: optionPriceIntentDigest(publish),
          state,
          originalObservedAt: at,
          validUntil: plus(5000),
        },
        work,
      );
  async function finalize() {
    for (const h of hooks) await h.guard();
    for (const h of hooks) h.final();
    return source.assertFinalized();
  }
  return {
    source,
    invoke,
    finalize,
    opts,
    tx,
    combined,
    query,
    policy,
    release,
    state,
    publish,
    independent,
    alterApproval,
    reviewApproval,
    withdraw: () => {
      allow = false;
    },
    setTime: (value: string) => {
      now = value;
    },
  };
}
beforeEach(() => vi.clearAllMocks());
describe("actual owning Option price publication source composition", () => {
  it("evaluates the controlled current Brand permission against the actual Brand context", async () => {
    const f = fixture();
    const decisions = await f.combined(["pricing.price-book.manage"]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      action: "pricing.price-book.manage",
      scopeKind: "Brand",
      effect: "Allow",
      reason: "ROLE_PERMISSION",
    });
    f.withdraw();
    const denied = await f.combined(["pricing.price-book.manage"]);
    expect(denied[0]).toMatchObject({
      scopeKind: "Brand",
      effect: "Deny",
      reason: "EXPLICIT_DENY",
    });
  });
  it("uses dedicated actual governance family and genuine no-approval policy, retaining current sources at COMMIT", async () => {
    const f = fixture();
    const packet = await f.invoke(async (p) => p);
    expect(packet.policy.familyReference).toBe(id(20));
    expect(packet.draftVersionReference).toBe(String(f.state.draft?.versionReference));
    expect(packet.approvalEvidenceReference).toBeNull();
    expect(controlled.review).not.toHaveBeenCalled();
    expect(controlled.policy).toHaveBeenCalledTimes(2);
    await f.finalize();
    expect(controlled.policy).toHaveBeenCalledTimes(3);
    expect(f.opts.capability.holdUntilCommit).not.toHaveBeenCalled();
  });
  it("requires true independent recorded approval with fixed expected check inventory and stored Draft author", async () => {
    const f = fixture(true);
    const p = await f.invoke(async (p) => p);
    expect(p.approvedActorReference).toBe(id(5));
    expect(p.draftAuthorActorReference).toBe(id(4));
    expect(controlled.approval.mock.calls[0]?.[0]).toMatchObject({
      familyReference: id(11),
      snapshotReference: f.state.draft?.versionReference,
      requiredCheckCodes: [...optionPricePublicationReviewCheckCodes].sort(),
    });
    await f.finalize();
  });
  it("retains original approval identity while actual observation advances within the request", async () => {
    const f = fixture(true);
    await f.invoke(async (p) => {
      f.setTime(plus(250));
      return p;
    });
    f.setTime(plus(500));
    await f.finalize();
    expect(controlled.approval).toHaveBeenCalledTimes(3);
  });
  it("rejects approval by actual Draft author even when original Submit actor differs", async () => {
    const f = fixture(true);
    controlled.approval.mockResolvedValue(
      f.alterApproval({ approvedByActorReference: parsePublishingReference(id(4)) }),
    );
    await expect(f.invoke(async (p) => p)).rejects.toMatchObject({
      code: "OPTION_PRICE_APPROVAL_REQUIRED",
    });
  });
  it("does not accept partial or unrelated historical checks", async () => {
    const f = fixture(true);
    controlled.approval.mockResolvedValue(
      f.alterApproval({ validationCheckCodes: [parsePublishingCode("UNRELATED_CHECK")] }),
    );
    await expect(f.invoke(async (p) => p)).rejects.toMatchObject({
      code: "OPTION_PRICE_APPROVAL_REQUIRED",
    });
  });
  it("rejects genuine absent review instead of fabricating approval", async () => {
    const f = fixture(true);
    controlled.readReview.mockResolvedValue({
      outcome: "Absent",
      familyReference: id(11),
      snapshotReference: f.state.draft?.versionReference,
      snapshotDigest: f.state.draft?.snapshotDigest,
      observedAt: at,
    });
    await expect(f.invoke(async (p) => p)).rejects.toMatchObject({
      code: "OPTION_PRICE_APPROVAL_REQUIRED",
    });
  });
  it.each(["missing-review", "missing-approval", "not-approved"])(
    "preserves approval-required outside the normalized owner callback for %s",
    async (change) => {
      const f = fixture(true),
        original = controlled.readReview.getMockImplementation();
      if (!original) throw new Error("missing controlled genuine review packet");
      controlled.readReview.mockImplementation(async () => {
        const packet = await original();
        return {
          ...packet,
          ...(change === "missing-review"
            ? { review: null }
            : change === "missing-approval"
              ? { approval: null }
              : { latest: packet.review }),
        };
      });
      await expect(f.invoke(async (p) => p)).rejects.toMatchObject({
        code: "OPTION_PRICE_APPROVAL_REQUIRED",
      });
      expect(controlled.approval).not.toHaveBeenCalled();
      await expect(f.finalize()).rejects.toBeDefined();
    },
  );
  it("keeps unknown owning Review failures bounded and poisons finalization", async () => {
    const f = fixture(true);
    controlled.readReview.mockRejectedValue(new Error("controlled private owner failure"));
    await expect(f.invoke(async (p) => p)).rejects.toMatchObject({
      code: "OPTION_PRICE_DEPENDENCY_UNAVAILABLE",
    });
    expect(controlled.approval).not.toHaveBeenCalled();
    await expect(f.finalize()).rejects.toBeDefined();
  });
  it("caps source lease at actual approval natural expiry without refreshing it", async () => {
    const f = fixture(true);
    controlled.approval.mockImplementation(async () =>
      f.alterApproval({ validUntil: parsePublishingInstant(plus(1000)) }),
    );
    const p = await f.invoke(async (p) => p);
    expect(p.validUntil).toBe(plus(1000));
    f.setTime(plus(1000));
    await expect(f.finalize()).rejects.toBeDefined();
  });
  it("caps genuine natural policy expiry and refuses an expired callback", async () => {
    const f = fixture(false, plus(1000));
    await expect(
      f.invoke(async (p) => {
        expect(p.validUntil).toBe(plus(1000));
        f.setTime(plus(1000));
        return p;
      }),
    ).rejects.toMatchObject({ code: "OPTION_PRICE_DEPENDENCY_UNAVAILABLE" });
  });
  it("rejects original deadline extension before any owning policy read", async () => {
    const f = fixture();
    await expect(
      f.source.withCurrentAuthorization(
        f.tx,
        {
          command: f.publish,
          originalIntentDigest: optionPriceIntentDigest(f.publish),
          state: f.state,
          originalObservedAt: at,
          validUntil: plus(5001),
        },
        async (p) => p,
      ),
    ).rejects.toBeDefined();
    expect(controlled.policy).not.toHaveBeenCalled();
  });
  it("rejects altered original intent before source acquisition", async () => {
    const f = fixture();
    await expect(
      f.source.withCurrentAuthorization(
        f.tx,
        {
          command: f.publish,
          originalIntentDigest: "sha256:" + "f".repeat(64),
          state: f.state,
          originalObservedAt: at,
          validUntil: plus(5000),
        },
        async (p) => p,
      ),
    ).rejects.toBeDefined();
    expect(controlled.policy).not.toHaveBeenCalled();
  });
  it("poisons the original host when work attempts reentry even if the rejection is swallowed", async () => {
    const f = fixture();
    await expect(
      f.invoke(async (p) => {
        try {
          await f.invoke(async (second) => second);
        } catch {
          /* The original host must remain poisoned. */
        }
        return p;
      }),
    ).rejects.toBeDefined();
    await expect(f.finalize()).rejects.toBeDefined();
  });
  it("rejects current governance head drift after tentative work and poisons COMMIT", async () => {
    const f = fixture();
    let calls = 0;
    const original = controlled.policy.getMockImplementation();
    if (!original) throw new Error("missing controlled source");
    controlled.policy.mockImplementation(async () => {
      const p = await original();
      return ++calls > 1
        ? { ...p, current: { ...p.current, release: { ...p.current.release, releaseId: id(70) } } }
        : p;
    });
    await expect(f.invoke(async (p) => p)).rejects.toMatchObject({
      code: "OPTION_PRICE_DEPENDENCY_UNAVAILABLE",
    });
    await expect(f.finalize()).rejects.toBeDefined();
  });
  it("rechecks actual current permission after work and at COMMIT", async () => {
    const f = fixture();
    await expect(
      f.invoke(async (p) => {
        f.withdraw();
        return p;
      }),
    ).rejects.toMatchObject({ code: "OPTION_PRICE_PERMISSION_DENIED" });
    await expect(f.finalize()).rejects.toBeDefined();
  });
  it("rejects foreign transaction and swallowed work failure", async () => {
    const f = fixture();
    await expect(
      f.source.withCurrentAuthorization(
        { query: f.tx.query },
        {
          command: f.publish,
          originalIntentDigest: optionPriceIntentDigest(f.publish),
          state: f.state,
          originalObservedAt: at,
          validUntil: plus(5000),
        },
        async (p) => p,
      ),
    ).rejects.toBeDefined();
    const other = fixture();
    await expect(
      other.invoke(async () => {
        throw new Error("controlled callback failed");
      }),
    ).rejects.toMatchObject({ code: "OPTION_PRICE_DEPENDENCY_UNAVAILABLE" });
    await expect(other.finalize()).rejects.toBeDefined();
  });
  it("captures all owner query/authorization ports and requires both actual final hooks", async () => {
    const f = fixture();
    await f.invoke(async (p) => p);
    expect(() => f.source.assertFinalized()).toThrow();
    const other = fixture();
    await other.invoke(async (p) => p);
    other.tx.query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    await expect(other.finalize()).rejects.toBeDefined();
  });
});
