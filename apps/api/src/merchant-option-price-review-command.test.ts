import { beforeEach, expect, it, vi } from "vitest";
import {
  createIdentityActor,
  createAuthenticationSession,
  parseSessionReference,
} from "@bop/identity";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import {
  evaluatePermission,
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
  parseEvidenceReference,
  parseRoleReference,
  parseEvidenceInstant,
} from "@bop/permission";
import {
  createPublishingScope,
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
  createPublishingApprovalEvidence,
  createPublishingReleaseRecord,
  publishingOptionPricePublicationPolicyDigest,
  parseReleaseSequence,
  parsePublishingReference,
  parsePublishingDigest,
  parsePublishingInstant,
  parsePublishingVersion,
  parsePublishingCode,
  parseRecordedPublishingMutation,
  parsePublishingOptionPriceReviewOperation,
  optionPriceReviewOperationFields,
  OptionPriceReviewOriginalDeniedError,
  PublishingContractError,
  parsePublishingOptionPricePublicationPolicy,
  type OptionPriceReviewOperationStoreOptions,
  type OptionPriceReviewOriginalOperation,
  type CommitPublishingMutationInput,
} from "@bop/publishing";
import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogCode,
} from "@rms/catalog";
import {
  createCurrencyMetadataSnapshot,
  parseCurrencyCode,
  parsePricingReference,
  parsePricingDigest,
  parseOptionPriceAuthoringCommand,
  materializeOptionPriceVersion,
  optionPriceWireSnapshot,
  parseOptionPriceAuthoringState,
  optionPriceAuthoringFields,
  type OptionPriceAuthoringStoreOptions,
} from "@rms/pricing";
import {
  createMerchantOptionPriceReviewCommand,
  type MerchantOptionPriceReviewCommandOptions,
} from "./merchant-option-price-review-command.js";
import { optionPricePublicationReviewCheckCodes } from "./merchant-option-price-publication-authority.js";
import type {
  MerchantOptionPriceContext,
  MerchantOptionPriceContextOptions,
} from "./merchant-option-price-context.js";
// Real public constructors/service and real host guard ordering, controlled
// owner transports. These fixtures do not prove PostgreSQL, actual IAM or policy publication.
const ports = vi.hoisted(() => ({
  brand: vi.fn(),
  store: vi.fn(),
  current: vi.fn(),
  cap: vi.fn(),
  permission: vi.fn(),
  context: vi.fn(),
  price: vi.fn(),
  publication: vi.fn(),
  original: vi.fn(),
}));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => ports.brand }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => ports.store }));
vi.mock("./merchant-product-current-authorization.js", () => ({
  createMerchantProductCurrentAuthorization: (o: unknown) => ports.current(o),
}));
vi.mock("./merchant-product-store-capability.js", () => ({
  createMerchantProductStoreCapabilityGuard: (o: unknown) => ports.cap(o),
}));
vi.mock("./merchant-option-price-context.js", () => ({
  createMerchantOptionPriceContextSource: (o: unknown) => ports.context(o),
}));
vi.mock("@bop/permission", async (original) => ({
  ...(await original<typeof import("@bop/permission")>()),
  createPostgresTransactionCurrentPermissionPolicySource: (tx: unknown) => ports.permission(tx),
}));
vi.mock("@rms/pricing", async (original) => ({
  ...(await original<typeof import("@rms/pricing")>()),
  createPostgresOptionPriceAuthoringStore: (o: unknown) => ports.price(o),
}));
vi.mock("@bop/publishing", async (original) => ({
  ...(await original<typeof import("@bop/publishing")>()),
  createPostgresPublishingMutationStore: (...args: unknown[]) => ports.publication(...args),
  createPostgresOptionPriceReviewOperationStore: (o: unknown) => ports.original(o),
}));
const id = (n: number) => "01902421-8980-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-05T12:00:00.000Z",
  after = (n: number) => new Date(Date.parse(at) + n).toISOString(),
  digest = "sha256:" + "a".repeat(64);
function fixture(action: "SubmitReview" | "Approve" = "SubmitReview", historical = false) {
  const factAt = historical ? after(-120000) : at,
    reviewUntil = historical ? after(-60000) : after(60000);
  const controls = {
      now: at,
      denied: false,
      fineDenied: false,
      replay: false,
      abandoned: false,
      originalFailure: undefined as Error | undefined,
      rootMismatch: false,
      policyChanged: false,
      contextCalls: 0,
      selfAuthor: false,
      noDraft: false,
      lateRootMismatch: false,
      lateHistoryDenied: false,
      historyFailure: undefined as unknown,
      afterCommit: undefined as (() => void) | undefined,
    },
    events: string[] = [],
    mutations: CommitPublishingMutationInput[] = [],
    actorId = action === "Approve" ? id(5) : id(4),
    actor = createIdentityActor({
      actorType: "User",
      actorReference: actorId,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    }),
    brand = createBrand({
      brandReference: id(2),
      code: "BRAND",
      displayName: "Controlled",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    store = createStore({
      storeReference: id(3),
      brandReference: id(2),
      code: "STORE",
      displayName: "Controlled",
      timeZone: "UTC",
      locale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    session = createAuthenticationSession({
      sessionReference: id(7),
      actor,
      status: "Active",
      policyCode: "WorkforceStandard",
      maxActiveSessions: 5,
      idleTimeoutMinutes: 30,
      absoluteTimeoutMinutes: 720,
      version: 1,
      authenticatedAt: at,
      createdAt: at,
      lastSeenAt: at,
      idleExpiresAt: after(1800000),
      absoluteExpiresAt: after(43200000),
      rotatedFromSessionReference: null,
      revocationReason: null,
      revokedAt: null,
    });
  const permissionActor = actor.actorReference;
  if (permissionActor === null) throw new Error("missing controlled Workforce Actor");
  const currency = createCurrencyMetadataSnapshot({
      currencyCode: parseCurrencyCode("CAD"),
      minorUnitExponent: 2,
      metadataVersion: 1,
      metadataVersionReference: parsePricingReference(id(8)),
      metadataDigest: parsePricingDigest(digest),
    }),
    create = parseOptionPriceAuthoringCommand({
      action: "CreateDraft",
      operationReference: id(9),
      ruleReference: id(10),
      expectedAggregateVersion: null,
      bindingReference: id(11),
      optionReference: id(12),
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
          effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
          effectiveUntil: null,
        },
      },
    }),
    draft = materializeOptionPriceVersion({
      command: create,
      current: null,
      brandReference: id(2),
      versionReference: id(13),
      occurredAt: factAt,
      currencyMetadata: currency,
    }),
    state = parseOptionPriceAuthoringState({
      profile: "OptionPriceAuthoringStateV1",
      brandReference: id(2),
      ruleReference: id(10),
      bindingReference: id(11),
      optionReference: id(12),
      aggregateVersion: 1,
      createdAt: factAt,
      createdByActorReference: id(4),
      updatedAt: factAt,
      draftAuthorActorReference: id(4),
      draft: optionPriceWireSnapshot(draft),
      currentPublished: null,
      latestVersion: optionPriceWireSnapshot(draft),
    }),
    pubScope = createPublishingScope({
      kind: "Brand",
      brandReference: id(2),
      storeReference: null,
    });
  const life = (status: "Draft" | "InReview", version: number) =>
      createPublishingLifecycleRecord({
        lifecycleId: parsePublishingReference(id(20)),
        familyReference: parsePublishingReference(id(10)),
        configurationType: parsePublishingCode("OPTION_PRICE_RULE"),
        purposeCode: parsePublishingCode("OPTION_PRICE_RULE_PUBLICATION"),
        snapshotReference: parsePublishingReference(id(13)),
        snapshotDigest: parsePublishingDigest(String(draft.snapshotDigest)),
        scope: pubScope,
        version: parsePublishingVersion(version),
        state: status,
        validationEvidenceReference: status === "Draft" ? null : parsePublishingReference(id(21)),
        approvalEvidenceReference: null,
        createdAt: parsePublishingInstant(factAt),
        changedAt: parsePublishingInstant(factAt),
      }),
    d = life("Draft", 1),
    r = life("InReview", 2),
    evidence = createPublishingValidationEvidence({
      evidenceReference: parsePublishingReference(id(21)),
      snapshotReference: d.snapshotReference,
      snapshotDigest: d.snapshotDigest,
      scope: pubScope,
      result: "Pass",
      checkedAt: parsePublishingInstant(factAt),
      validUntil: parsePublishingInstant(reviewUntil),
      checkCodes: optionPricePublicationReviewCheckCodes.map(parsePublishingCode),
    });
  const originalRecord = (
      operation: "CreateDraft" | "SubmitReview",
      current: typeof d | null,
      next: typeof d,
      n: number,
    ) =>
      parseRecordedPublishingMutation({
        operation,
        current,
        next,
        expectedVersion: current?.version ?? 1,
        idempotencyKey: id(n),
        release: null,
        supersededReleaseId: null,
        rollbackTargetReleaseId: null,
        validationEvidence: operation === "SubmitReview" ? evidence : null,
        approvalEvidence: null,
        audit: {
          auditId: id(n + 100),
          brandId: id(2),
          actor: { type: "User", reference: id(6) },
          actionCode:
            operation === "CreateDraft"
              ? "PUBLISHING_DRAFT_CREATED"
              : "PUBLISHING_REVIEW_SUBMITTED",
          targetType: "PublishingLifecycle",
          targetId: id(20),
          reasonCode:
            operation === "CreateDraft"
              ? "PUBLISHING_DRAFT_CREATED"
              : "PUBLISHING_REVIEW_SUBMITTED",
          correlationId: id(n),
          occurredAt: factAt,
          sourceChannel: "API",
          dataClassification: "Confidential",
          retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
          retentionPolicyVersion: 1,
        },
      }),
    rd = originalRecord("CreateDraft", null, d, 22),
    rr = originalRecord("SubmitReview", d, r, 23);
  const body = {
    action,
    operationReference: id(30),
    ruleReference: id(10),
    draftVersionReference: id(13),
    draftSnapshotDigest: String(draft.snapshotDigest),
    expectedAggregateVersion: 1,
    validationValidUntil: after(60000),
    approvalValidUntil: action === "Approve" ? after(50000) : null,
    expectedLifecycle:
      action === "Approve"
        ? {
            lifecycleReference: id(20),
            version: 2,
            state: "InReview",
            latestMutationOperationReference: id(23),
          }
        : null,
  };
  const check = () => {
      if (controls.denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return parseCatalogInstant(controls.now);
    },
    query = vi.fn(async () => ({ rows: [], rowCount: 0 })),
    tx = { query };
  const scope = {
    tenantReference: id(1),
    context: createTenantContext(actor, brand, null, at),
    actorReference: actorId,
    selectedStoreReference: id(3),
  };
  ports.brand.mockResolvedValue(scope);
  ports.store.mockResolvedValue({
    selected: { tenantReference: id(1) },
    context: createTenantContext(actor, brand, store, at),
    store,
    actorReference: actorId,
    sessionReference: parseSessionReference(id(7)),
  });
  ports.permission.mockReturnValue({});
  const current = {
      assertCurrent: check,
      leaseDeadline: () => after(5000),
      authorizeActions: vi.fn(),
      authorizeActionsWithDecisions: vi.fn(),
      withCurrentStoreScope: vi.fn(),
    },
    combined = vi.fn(async (actions: readonly string[]) => {
      check();
      return Object.freeze(
        actions.map((action) =>
          evaluatePermission({
            tenantContext: createTenantContext(actor, brand, null, controls.now),
            action: parseBusinessAction(action),
            resourceScope: {
              kind: "Brand",
              brandReference: brand.brandReference,
              storeReference: null,
            },
            policySnapshotReference: parsePolicyReference(id(40)),
            policyVersion: parsePolicyVersion(1),
            evidence: [
              {
                source:
                  controls.fineDenied && action !== "pricing.price-book.manage"
                    ? "ExplicitDeny"
                    : "RolePermission",
                evidenceReference: parseEvidenceReference(id(41)),
                action: parseBusinessAction(action),
                actorReference: permissionActor,
                roleReference:
                  controls.fineDenied && action !== "pricing.price-book.manage"
                    ? null
                    : parseRoleReference(id(42)),
                brandReference: brand.brandReference,
                storeReference: null,
                effectiveFrom: parseEvidenceInstant(at),
                effectiveUntil: null,
              },
            ],
          }),
        ),
      );
    });
  ports.current.mockReturnValue(current);
  ports.cap.mockReturnValue({
    holdUntilCommit: vi.fn(),
    holdUntilCommitWithDecisions: combined,
    leaseDeadline: () => after(5000),
  });
  const context: MerchantOptionPriceContext = {
    profile: "MerchantOptionPriceContextV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: actorId,
    productReference: id(50),
    productAggregateVersion: 1,
    productVersionReference: id(51),
    productSnapshotDigest: digest,
    binding: {
      bindingReference: parseCatalogReference(id(11)),
      optionSetReference: parseCatalogReference(id(52)),
      optionSetVersionReference: parseCatalogReference(id(53)),
      purpose: parseCatalogCode("EXTRAS"),
      sortOrder: 0,
      enabledOptionReferences: [parseCatalogReference(id(12))],
      defaultSelections: [],
      minimumSelectionOverride: null,
      maximumSelectionOverride: null,
      includedSkuReferences: [],
      excludedSkuReferences: [],
      channelCodes: [],
      storeOverrideAllowed: false,
    },
    versionResolution: "Pinned",
    optionReference: id(12),
    optionSetReference: id(52),
    optionSetVersionReference: id(53),
    optionSourceDigest: digest,
    optionSourceAuthority: "RecordedFrozen",
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Controlled" },
    choices: [
      {
        optionReference: id(12),
        stableCode: "EXTRA",
        lifecycle: "Active",
        localizedNames: { "en-CA": "Controlled" },
      },
    ],
    skus: [],
    currencyMetadata: currency,
    referenceEligibility: "NotEvaluated",
    publishValidation: "Incomplete",
    observedAt: at,
    validUntil: after(5000),
  };
  ports.context.mockImplementation((o: MerchantOptionPriceContextOptions) => {
    let complete = false;
    return {
      async withCurrentContext<T>(
        actual: MerchantOptionPriceContextOptions["transaction"],
        _request: unknown,
        work: (value: MerchantOptionPriceContext) => Promise<T>,
      ) {
        expect(actual).toBe(o.transaction);
        void _request;
        controls.contextCalls++;
        events.push("Catalog");
        await o.registerBeforeCommit(
          o.transaction,
          async () => {
            check();
          },
          () => {
            complete = true;
          },
        );
        return work(context);
      },
      assertFinalized() {
        expect(complete).toBe(true);
        return after(5000);
      },
    };
  });
  const policy = parsePublishingOptionPricePublicationPolicy({
    profile: "PublishingOptionPricePublicationPolicyV1",
    tenantReference: id(1),
    brandReference: id(2),
    familyReference: id(60),
    policyReference: id(61),
    policyVersion: 1,
    approvalPolicy: "Required",
    effectiveFrom: at,
    effectiveUntil: after(120000),
  });
  const pd = parsePublishingDigest(publishingOptionPricePublicationPolicyDigest(policy)),
    pv = createPublishingValidationEvidence({
      evidenceReference: parsePublishingReference(id(63)),
      snapshotReference: policy.policyReference,
      snapshotDigest: pd,
      scope: pubScope,
      result: "Pass",
      checkedAt: parsePublishingInstant(at),
      validUntil: parsePublishingInstant(after(120000)),
      checkCodes: [parsePublishingCode("POLICY_CONTENT")],
    }),
    pa = createPublishingApprovalEvidence({
      evidenceReference: parsePublishingReference(id(64)),
      reviewLifecycleId: parsePublishingReference(id(65)),
      reviewVersion: parsePublishingVersion(2),
      snapshotReference: policy.policyReference,
      snapshotDigest: pd,
      scope: pubScope,
      decision: "Accepted",
      approvedActorReference: parsePublishingReference(id(66)),
      approvedAt: parsePublishingInstant(at),
      validUntil: parsePublishingInstant(after(120000)),
    }),
    pl = createPublishingLifecycleRecord({
      lifecycleId: parsePublishingReference(id(65)),
      familyReference: policy.familyReference,
      configurationType: parsePublishingCode("OPTION_PRICE_PUBLICATION_POLICY"),
      purposeCode: parsePublishingCode("OPTION_PRICE_PUBLICATION_POLICY"),
      snapshotReference: policy.policyReference,
      snapshotDigest: pd,
      scope: pubScope,
      version: parsePublishingVersion(4),
      state: "Published",
      validationEvidenceReference: pv.evidenceReference,
      approvalEvidenceReference: pa.evidenceReference,
      createdAt: parsePublishingInstant(at),
      changedAt: parsePublishingInstant(at),
    }),
    pr = createPublishingReleaseRecord({
      releaseId: parsePublishingReference(id(62)),
      familyReference: policy.familyReference,
      configurationType: pl.configurationType,
      purposeCode: pl.purposeCode,
      snapshotReference: policy.policyReference,
      snapshotDigest: pd,
      scope: pubScope,
      sequence: parseReleaseSequence(1),
      sourceLifecycleId: pl.lifecycleId,
      kind: "Publish",
      previousReleaseId: null,
      createdAt: parsePublishingInstant(at),
    });
  const policyRead = vi.fn(async () => ({
    content: { ...policy, policyVersion: controls.policyChanged ? 2 : 1 },
    current: {
      release: pr,
      lifecycle: pl,
      validationEvidence: pv,
      approvalEvidence: pa,
      auditReference: parsePublishingReference(id(67)),
      observedAt: controls.now,
    },
    observedAt: controls.now,
  }));
  let historyReads = 0,
    reviewAcquisitions = 0;
  ports.publication.mockReturnValue({
    resolveCurrentOptionPricePublicationPolicy: policyRead,
    async withOptionPriceReview(
      _input: unknown,
      work: (held: { readForDraft: () => Promise<unknown> }) => Promise<unknown>,
    ) {
      void _input;
      events.push("Publishing");
      const acquisition = ++reviewAcquisitions;
      let active = true;
      try {
        return await work({
          readForDraft: async () => {
            if (!active) throw new Error("controlled review source outside owning callback");
            events.push("ReviewRead:" + acquisition);
            historyReads++;
            if (controls.historyFailure !== undefined) throw controls.historyFailure;
            if (controls.lateHistoryDenied && historyReads > 1)
              throw new Error("controlled historical source denial");
            return action === "Approve"
              ? {
                  outcome: "Recorded",
                  familyReference: d.familyReference,
                  snapshotReference: d.snapshotReference,
                  snapshotDigest: d.snapshotDigest,
                  draft: rd,
                  review: rr,
                  approval: null,
                  latest: rr,
                  observedAt: controls.now,
                }
              : {
                  outcome: "Absent",
                  familyReference: d.familyReference,
                  snapshotReference: d.snapshotReference,
                  snapshotDigest: d.snapshotDigest,
                  observedAt: controls.now,
                };
          },
        });
      } catch {
        // Faithful public protectedRun: callback errors are normalized by the
        // owning Publishing boundary, rather than leaking their original class.
        throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
      } finally {
        active = false;
      }
    },
  });
  ports.price.mockImplementation((o: OptionPriceAuthoringStoreOptions) => {
    let final = false,
      guarded = false,
      registered = false,
      reads = 0;
    const hold = async () => {
      await o.authority.holdUntilTransactionCompletes(o.transaction, {
        tenantReference: id(1),
        brandReference: id(2),
        selectedStoreReference: id(3),
        actorReference: actorId,
        permission: "pricing.price-book.manage",
        purposeCode: "PRICING_OPTION_PRICE_AUTHORING",
        requiredFields: optionPriceAuthoringFields,
        mode: "Read",
        command: null,
        state,
        observedAt: controls.now,
        originalObservedAt: at,
        originalValidUntil: after(5000),
      });
    };
    return {
      async readCurrent() {
        // Faithful owning guard boundary: no new read may run after its
        // asynchronous final revalidation has begun, even before sync final.
        if (guarded || final) throw new Error("controlled owning read after guard");
        events.push("Pricing");
        if (!registered) {
          registered = true;
          await o.registerBeforeCommit(
            o.transaction,
            async () => {
              guarded = true;
              events.push("PricingOwnerGuard");
              await hold();
            },
            () => {
              final = true;
            },
          );
        }
        await hold();
        reads++;
        if (controls.noDraft) return null;
        return controls.rootMismatch || (controls.lateRootMismatch && reads > 1)
          ? { ...state, aggregateVersion: 2 }
          : controls.selfAuthor
            ? parseOptionPriceAuthoringState({
                ...state,
                draft: optionPriceWireSnapshot(draft),
                latestVersion: optionPriceWireSnapshot(draft),
                draftAuthorActorReference: actorId,
              })
            : state;
      },
      async listForBinding() {
        return [state];
      },
      assertFinalized() {
        expect(final).toBe(true);
        return after(5000);
      },
    };
  });
  let actualTx:
    Parameters<OptionPriceReviewOperationStoreOptions["registerBeforeCommit"]>[0] | undefined;
  let actualCommand: ReturnType<typeof parsePublishingOptionPriceReviewOperation> | undefined,
    terminal: Exclude<OptionPriceReviewOriginalOperation, { outcome: "Absent" }> | undefined,
    originalFinal = false;
  ports.original.mockImplementation((o: OptionPriceReviewOperationStoreOptions) => {
    const authority = async (mode: "Read" | "Write" | "Resolve") => {
      if (!actualCommand) throw new Error("missing actual closed command");
      if (!actualTx) throw new Error("missing actual borrowed host");
      await o.authority.holdUntilTransactionCompletes(actualTx, {
        command: actualCommand,
        mode,
        permission: "pricing.price-book.manage",
        requiredPermissions:
          mode === "Write"
            ? [
                "pricing.price-book.manage",
                action === "SubmitReview"
                  ? "publishing.review.submit"
                  : "publishing.review.approve",
                ...(action === "SubmitReview" ? ["publishing.draft.create"] : []),
              ].sort()
            : ["pricing.price-book.manage"],
        requiredFields: optionPriceReviewOperationFields,
        purposeCode: "PRICING_OPTION_PRICE_REVIEW_OPERATION",
        actorKind: "User",
        observedAt: controls.now,
        validUntil: after(5000),
      });
    };
    const inspect = async (command: unknown) => {
      actualCommand = parsePublishingOptionPriceReviewOperation(command);
      await authority("Read");
      if (controls.originalFailure) throw controls.originalFailure;
      if (terminal) return terminal;
      if (controls.abandoned)
        return {
          outcome: "Abandoned" as const,
          command: actualCommand,
          recordedAt: parsePublishingInstant(at),
          auditReference: parsePublishingReference(id(70)),
        };
      if (controls.replay)
        return {
          outcome: "Committed" as const,
          command: actualCommand,
          originalOccurredAt: parsePublishingInstant(at),
          auditReference: parsePublishingReference(id(71)),
          mutation: rr,
        };
      return { outcome: "Absent" as const };
    };
    return {
      async inspectOriginalOperation(
        actual: Parameters<OptionPriceReviewOperationStoreOptions["registerBeforeCommit"]>[0],
        command: unknown,
      ) {
        actualTx = actual;
        events.push("Inspect");
        await o.registerBeforeCommit(
          actual,
          async () => {
            await authority("Read");
          },
          () => {
            originalFinal = true;
          },
        );
        return inspect(command);
      },
      async withOriginalOperation<T>(
        actual: Parameters<OptionPriceReviewOperationStoreOptions["registerBeforeCommit"]>[0],
        command: unknown,
        work: (original: OptionPriceReviewOriginalOperation) => Promise<T>,
      ) {
        expect(actual).toBe(actualTx);
        actualCommand = parsePublishingOptionPriceReviewOperation(command);
        await authority("Write");
        return work({
          outcome: "Absent",
          async createDraft(input) {
            events.push("CreateDraft");
            mutations.push(parseRecordedPublishingMutation(input));
            return { auditReference: parsePublishingReference(input.audit.auditId) };
          },
          async commit(input) {
            events.push("Commit");
            const m = parseRecordedPublishingMutation(input);
            mutations.push(m);
            if (!actualCommand) throw new Error("missing command");
            terminal = {
              outcome: "Committed",
              command: actualCommand,
              originalOccurredAt: parsePublishingInstant(m.audit.occurredAt),
              auditReference: parsePublishingReference(m.audit.auditId),
              mutation: m,
            };
            controls.afterCommit?.();
            return { auditReference: parsePublishingReference(m.audit.auditId) };
          },
        });
      },
      async resolveOperation(
        actual: Parameters<OptionPriceReviewOperationStoreOptions["registerBeforeCommit"]>[0],
        command: unknown,
      ) {
        actualTx = actual;
        await o.registerBeforeCommit(
          actual,
          async () => {
            await authority("Resolve");
          },
          () => {
            originalFinal = true;
          },
        );
        const found = await inspect(command);
        if (found.outcome !== "Absent") return found;
        if (!actualCommand) throw new Error("missing command");
        const audit = o.audit.create({ command: actualCommand, observedAt: controls.now });
        terminal = {
          outcome: "Abandoned",
          command: actualCommand,
          recordedAt: parsePublishingInstant(audit.occurredAt),
          auditReference: parsePublishingReference(audit.auditId),
        };
        return terminal;
      },
      assertFinalized() {
        expect(originalFinal).toBe(true);
        return after(5000);
      },
    };
  });
  const run: MerchantOptionPriceReviewCommandOptions["merchant"]["transactions"]["run"] = async (
    work,
  ) => {
    events.push("Begin");
    try {
      const result = await work(tx);
      events.push("CommitOuter");
      return result;
    } catch (error) {
      events.push("RollbackOuter");
      throw error;
    }
  };
  let next = 100;
  const generate = vi.fn(() => id(++next)),
    options: MerchantOptionPriceReviewCommandOptions = {
      merchant: {
        now: () => controls.now,
        transactions: { run },
        currentActor: vi.fn(),
        validateAssociation: vi.fn(),
      } as unknown as MerchantOptionPriceReviewCommandOptions["merchant"],
      authentication: { authorize: vi.fn(async () => session) },
      currencyMetadata: currency,
      publicationPolicyFamilyReference: id(60),
      references: { generate },
    },
    source = createMerchantOptionPriceReviewCommand(options),
    request = {
      sessionCookie: "controlled",
      csrf: "controlled",
      expectedScope: { brandReference: id(2), storeReference: id(3) },
      command: body,
      context: {
        productReference: id(50),
        expectedProductAggregateVersion: 1,
        bindingReference: id(11),
        optionReference: id(12),
      },
    };
  return {
    source,
    request,
    controls,
    events,
    mutations,
    generate,
    tx,
    options,
    context,
    state,
    policyRead,
    combined,
  };
}
beforeEach(() => vi.clearAllMocks());
it("first Submit holds Catalog then Publishing then Pricing and commits distinct CreateDraft and fixed checks before outer reply", async () => {
  const f = fixture();
  const result = await f.source.execute(f.request);
  expect(result.outcome).toBe("Committed");
  expect(f.mutations.map((m) => m.operation)).toEqual(["CreateDraft", "SubmitReview"]);
  expect(f.mutations[0]?.idempotencyKey).not.toBe(f.mutations[1]?.idempotencyKey);
  expect(f.mutations[1]?.idempotencyKey).toBe(id(30));
  expect(f.mutations[1]?.validationEvidence?.checkCodes).toEqual(
    optionPricePublicationReviewCheckCodes,
  );
  expect(f.events.indexOf("Catalog")).toBeLessThan(f.events.indexOf("Publishing"));
  expect(f.events.indexOf("Publishing")).toBeLessThan(f.events.indexOf("Pricing"));
  expect(f.events.at(-1)).toBe("CommitOuter");
});
it("Approve uses the actual original review deadline and independent stored Draft author", async () => {
  const f = fixture("Approve");
  const result = await f.source.execute(f.request);
  expect(result.outcome).toBe("Committed");
  expect(f.mutations).toHaveLength(1);
  expect(f.mutations[0]?.approvalEvidence).toMatchObject({
    approvedActorReference: id(5),
    validUntil: after(50000),
  });
});
it("original Committed replay bypasses changed current Draft, expired business window, context and allocation", async () => {
  const f = fixture();
  f.controls.replay = true;
  f.controls.rootMismatch = true;
  f.request.command.validationValidUntil = after(-1000);
  const result = await f.source.execute(f.request);
  expect(result.outcome).toBe("Committed");
  expect(f.controls.contextCalls).toBe(0);
  expect(f.generate).not.toHaveBeenCalled();
  expect(ports.price).not.toHaveBeenCalled();
  expect(f.policyRead).not.toHaveBeenCalled();
});
it("known Abandoned stays terminal and does not acquire fresh sources", async () => {
  const f = fixture();
  f.controls.abandoned = true;
  expect((await f.source.execute(f.request)).outcome).toBe("Abandoned");
  expect(f.generate).not.toHaveBeenCalled();
  expect(f.controls.contextCalls).toBe(0);
});
it("Resolve delegates genuine absence abandonment to the owning original store without semantic work", async () => {
  const f = fixture();
  expect((await f.source.resolve(f.request)).outcome).toBe("Abandoned");
  expect(f.controls.contextCalls).toBe(0);
  expect(ports.price).not.toHaveBeenCalled();
  expect(f.generate).toHaveBeenCalledTimes(1);
});
it("current revoked IAM rejects before original arbitration", async () => {
  const f = fixture();
  f.controls.denied = true;
  await expect(f.source.execute(f.request)).rejects.toMatchObject({
    code: "OPTION_PRICE_PERMISSION_DENIED",
  });
  expect(ports.original).not.toHaveBeenCalled();
});
it.each(["execute", "resolve"] as const)(
  "%s preserves an authentic opaque-original denial through host rollback",
  async (method) => {
    const f = fixture();
    f.controls.originalFailure = new OptionPriceReviewOriginalDeniedError();
    await expect(f.source[method](f.request)).rejects.toMatchObject({
      code: "OPTION_PRICE_PERMISSION_DENIED",
    });
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.mutations).toHaveLength(0);
    expect(f.controls.contextCalls).toBe(0);
  },
);
it("unknown original failure remains unavailable without classifying it as denial", async () => {
  const f = fixture();
  f.controls.originalFailure = new Error("controlled original infrastructure failure");
  await expect(f.source.resolve(f.request)).rejects.toMatchObject({
    code: "OPTION_PRICE_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.mutations).toHaveLength(0);
});
it("fine Submit permission cannot be substituted by manage", async () => {
  const f = fixture();
  f.controls.fineDenied = true;
  await expect(f.source.execute(f.request)).rejects.toMatchObject({
    code: "OPTION_PRICE_PERMISSION_DENIED",
  });
  expect(f.mutations).toHaveLength(0);
});
it("actual root CAS drift fails before lifecycle allocations or commit", async () => {
  const f = fixture();
  f.controls.rootMismatch = true;
  await expect(f.source.execute(f.request)).rejects.toMatchObject({
    code: "OPTION_PRICE_VERSION_CONFLICT",
  });
  expect(f.mutations).toHaveLength(0);
  expect(f.generate).not.toHaveBeenCalled();
});
it("expired explicit validation does not borrow the request authorization lease", async () => {
  const f = fixture();
  f.request.command.validationValidUntil = at;
  await expect(f.source.execute(f.request)).rejects.toMatchObject({
    code: "OPTION_PRICE_APPROVAL_REQUIRED",
  });
  expect(f.mutations).toHaveLength(0);
});
it("a business validation deadline cannot exceed genuine governing policy validity", async () => {
  const f = fixture();
  f.request.command.validationValidUntil = after(120001);
  await expect(f.source.execute(f.request)).rejects.toMatchObject({
    code: "OPTION_PRICE_APPROVAL_REQUIRED",
  });
  expect(f.mutations).toHaveLength(0);
});
it("caller scope fields are closed and never accepted as server authority", async () => {
  const f = fixture();
  await expect(
    f.source.execute({ ...f.request, command: { ...f.request.command, actorReference: id(99) } }),
  ).rejects.toBeDefined();
  expect(ports.original).not.toHaveBeenCalled();
});

it("rejects an approver who is the actual stored Pricing Draft author despite a distinct Submit actor", async () => {
  const f = fixture("Approve");
  f.controls.selfAuthor = true;
  await expect(f.source.execute(f.request)).rejects.toMatchObject({
    code: "OPTION_PRICE_APPROVAL_REQUIRED",
  });
  expect(f.mutations).toHaveLength(0);
  expect(f.events.at(-1)).toBe("RollbackOuter");
  expect(f.events).not.toContain("CommitOuter");
});
it("does not promote a payload-shaped approval error from an owning source into a trusted business refusal", async () => {
  const f = fixture("Approve");
  f.controls.historyFailure = { code: "OPTION_PRICE_APPROVAL_REQUIRED" };
  await expect(f.source.execute(f.request)).rejects.toMatchObject({
    code: "OPTION_PRICE_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.events.at(-1)).toBe("RollbackOuter");
  expect(f.mutations).toHaveLength(0);
});
it("late policy head change refuses delivery and the actual outer host rolls back", async () => {
  const f = fixture();
  f.controls.afterCommit = () => {
    f.controls.policyChanged = true;
  };
  await expect(f.source.execute(f.request)).rejects.toBeDefined();
  expect(f.events.at(-1)).toBe("RollbackOuter");
  expect(f.events).not.toContain("CommitOuter");
});
it("late actual IAM withdrawal after tentative commit refuses the original outer transaction", async () => {
  const f = fixture();
  f.controls.afterCommit = () => {
    f.controls.denied = true;
  };
  await expect(f.source.execute(f.request)).rejects.toMatchObject({
    code: "OPTION_PRICE_PERMISSION_DENIED",
  });
  expect(f.events.at(-1)).toBe("RollbackOuter");
});
it("original five-second deadline is checked after tentative owner commit and before outer COMMIT", async () => {
  const f = fixture();
  f.controls.afterCommit = () => {
    f.controls.now = after(5000);
  };
  await expect(f.source.execute(f.request)).rejects.toBeDefined();
  expect(f.events.at(-1)).toBe("RollbackOuter");
});

it("readonly query returns real current Draft and governing policy with genuine absent review, without operation or Audit allocation", async () => {
  const f = fixture();
  const view = await f.source.query({
    sessionCookie: f.request.sessionCookie,
    csrf: f.request.csrf,
    expectedScope: f.request.expectedScope,
    context: f.request.context,
    ruleReference: id(10),
  });
  expect(view).toMatchObject({
    profile: "MerchantOptionPriceReviewCurrentV1",
    ruleReference: id(10),
    aggregateVersion: 1,
    draftVersionReference: id(13),
    draftSnapshotDigest: String(f.state.draft?.snapshotDigest),
    policy: {
      familyReference: id(60),
      approvalPolicy: "Required",
      currentPublicationReference: id(62),
    },
    review: { outcome: "Absent" },
  });
  expect(f.generate).not.toHaveBeenCalled();
  expect(ports.original).not.toHaveBeenCalled();
  expect(f.mutations).toHaveLength(0);
  expect(f.events.at(-1)).toBe("CommitOuter");
  const owningGuard = f.events.indexOf("PricingOwnerGuard");
  expect(owningGuard).toBeGreaterThan(-1);
  expect(f.events.filter((event) => event === "Pricing")).toHaveLength(2);
  expect(f.events.lastIndexOf("Pricing")).toBeLessThan(owningGuard);
  expect(f.events.filter((event) => event.startsWith("ReviewRead:"))).toEqual([
    "ReviewRead:1",
    "ReviewRead:2",
  ]);
});
it("readonly query exposes actual original lifecycle and actors without claiming fresh qualification", async () => {
  const f = fixture("Approve");
  const view = await f.source.query({
    sessionCookie: f.request.sessionCookie,
    csrf: f.request.csrf,
    expectedScope: f.request.expectedScope,
    context: f.request.context,
    ruleReference: id(10),
  });
  expect(view.review).toEqual({
    outcome: "Recorded",
    lifecycle: {
      lifecycleReference: id(20),
      version: 2,
      state: "InReview",
      latestMutationOperationReference: id(23),
    },
    validationValidUntil: after(60000),
    approvalValidUntil: null,
    submittedActorReference: id(6),
    approvedActorReference: null,
    sourceAuthority: "RecordedHistory",
    qualification: "NotEvaluated",
  });
  expect(f.generate).not.toHaveBeenCalled();
  expect(
    f.combined.mock.calls.every(([actions]) =>
      actions.every((action) => action === "pricing.price-book.manage"),
    ),
  ).toBe(true);
});
it("readonly query refuses a genuine no-Draft state instead of presenting review absence", async () => {
  const f = fixture();
  f.controls.noDraft = true;
  await expect(
    f.source.query({
      sessionCookie: f.request.sessionCookie,
      csrf: f.request.csrf,
      expectedScope: f.request.expectedScope,
      context: f.request.context,
      ruleReference: id(10),
    }),
  ).rejects.toMatchObject({ code: "OPTION_PRICE_LIFECYCLE_CONFLICT" });
  expect(ports.original).not.toHaveBeenCalled();
  expect(f.generate).not.toHaveBeenCalled();
});
it("readonly query rereads the complete Pricing Draft identity before COMMIT and refuses later root drift", async () => {
  const f = fixture();
  f.controls.lateRootMismatch = true;
  await expect(
    f.source.query({
      sessionCookie: f.request.sessionCookie,
      csrf: f.request.csrf,
      expectedScope: f.request.expectedScope,
      context: f.request.context,
      ruleReference: id(10),
    }),
  ).rejects.toMatchObject({ code: "OPTION_PRICE_VERSION_CONFLICT" });
  expect(f.events.at(-1)).toBe("RollbackOuter");
  expect(f.generate).not.toHaveBeenCalled();
});
it("readonly query has genuine current permission admission before historical sources", async () => {
  const f = fixture();
  f.controls.denied = true;
  await expect(
    f.source.query({
      sessionCookie: f.request.sessionCookie,
      csrf: f.request.csrf,
      expectedScope: f.request.expectedScope,
      context: f.request.context,
      ruleReference: id(10),
    }),
  ).rejects.toMatchObject({ code: "OPTION_PRICE_PERMISSION_DENIED" });
  expect(ports.price).not.toHaveBeenCalled();
  expect(ports.original).not.toHaveBeenCalled();
});

it("readonly query refuses later historical source denial before the owning Pricing final guard", async () => {
  const f = fixture("Approve");
  f.controls.lateHistoryDenied = true;
  await expect(
    f.source.query({
      sessionCookie: f.request.sessionCookie,
      csrf: f.request.csrf,
      expectedScope: f.request.expectedScope,
      context: f.request.context,
      ruleReference: id(10),
    }),
  ).rejects.toBeDefined();
  expect(f.events.at(-1)).toBe("RollbackOuter");
  expect(f.events).not.toContain("PricingOwnerGuard");
  expect(f.events).not.toContain("CommitOuter");
  expect(f.generate).not.toHaveBeenCalled();
  expect(f.mutations).toHaveLength(0);
});

it("readonly query preserves genuinely historical expired review evidence without renewing it or turning it into current qualification", async () => {
  const f = fixture("Approve", true);
  const view = await f.source.query({
    sessionCookie: f.request.sessionCookie,
    csrf: f.request.csrf,
    expectedScope: f.request.expectedScope,
    context: f.request.context,
    ruleReference: id(10),
  });
  expect(view.review).toMatchObject({
    outcome: "Recorded",
    validationValidUntil: after(-60000),
    sourceAuthority: "RecordedHistory",
    qualification: "NotEvaluated",
  });
  expect(view.validUntil).toBe(after(5000));
  expect(f.generate).not.toHaveBeenCalled();
});
