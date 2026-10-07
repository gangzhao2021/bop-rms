import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex, type AppendAuditRecordInput } from "@bop/audit";
import { createMediaScope } from "@bop/media";
import { createIdentityActor } from "@bop/identity";
import { createBrand, createTenantContext } from "@bop/tenant";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import {
  parsePublishingReference,
  parsePublishingInstant,
  parsePublishingOptionSetReviewPolicy,
  publishingOptionSetPublicationPolicyDigest,
  optionSetPolicyScopeLevels,
  parseRecordedPublishingMutation,
  optionSetPublicationOperationFields,
  type CommitPublishingMutationInput,
  type OptionSetPublicationOperationStoreOptions,
  type OptionSetPublicationOriginalOperation,
} from "@bop/publishing";
import {
  CatalogError,
  materializeFullOptionSetCreation,
  parseCatalogOptionSetEditorContent,
  createCatalogOptionSetContentReviewBinding,
  parseCatalogOptionSetContentPolicyBinding,
  createCatalogFullOptionSetContentSealIntent,
  createCatalogFullOptionSetPublicationMaterialization,
  currentFullOptionSetDraftFields,
  fullOptionSetPublicationSourceAdmissionFields,
  fullOptionSealChecks,
  optionSetReleaseRecordFields,
  optionContentReviewValidationCodes,
  type createPostgresFullOptionSetPublicationSourceAdmissionStore,
  type createPostgresFullOptionSetContentSealStore,
  type createPostgresOptionSetReviewContentStore,
  type CatalogOptionSetReviewRecord,
  type CatalogOptionSetReleaseRecord,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import { createMerchantOptionSetPublicationCommand } from "./merchant-option-set-publication-command.js";
import type {
  CurrentOptionSetPublicationValidationOptions,
  CurrentOptionSetPublicationValidationPacket,
} from "./current-option-set-publication-validation.js";
const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  brandFactory: vi.fn(),
  scope: vi.fn(),
  current: vi.fn(),
  capability: vi.fn(),
  original: vi.fn(),
  admission: vi.fn(),
  validator: vi.fn(),
  publisher: vi.fn(),
  writer: vi.fn(),
  sealer: vi.fn(),
}));
vi.mock("@bop/permission", async (original) => ({
  ...(await original<typeof import("@bop/permission")>()),
  createPostgresTransactionCurrentPermissionPolicySource: (tx: unknown) => mocks.permission(tx),
}));
vi.mock("./merchant-brand-scope.js", () => ({
  createMerchantBrandScope: (...args: unknown[]) => {
    mocks.brandFactory(...args);
    return mocks.scope;
  },
}));
vi.mock("./merchant-product-current-authorization.js", () => ({
  createMerchantProductCurrentAuthorization: (options: unknown) => mocks.current(options),
}));
vi.mock("./merchant-product-store-capability.js", () => ({
  createMerchantProductStoreCapabilityGuard: () => mocks.capability(),
}));
vi.mock("./current-option-set-publication-validation.js", () => ({
  createCurrentOptionSetPublicationValidationSource: (o: unknown) => mocks.validator(o),
}));
vi.mock("@bop/publishing", async (original) => ({
  ...(await original<typeof import("@bop/publishing")>()),
  createPostgresOptionSetPublicationOperationStore: (o: unknown) => mocks.original(o),
  createPostgresPublishingMutationStore: () => mocks.publisher(),
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresFullOptionSetPublicationSourceAdmissionStore: (o: unknown) => mocks.admission(o),
  createPostgresOptionSetReviewContentStore: (o: unknown) => mocks.writer(o),
  createPostgresFullOptionSetContentSealStore: (o: unknown) => mocks.sealer(o),
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.permission.mockReturnValue(
    Object.freeze({
      authorize: vi.fn(),
      authorizeWithRoles: vi.fn(),
      authorizeActionsWithRoles: vi.fn(),
    }),
  );
});
const id = (n: number) => "01902421-7800-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T12:00:00.000Z",
  until = "2026-10-04T12:00:05.000Z",
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function creation() {
  return {
    internalCode: "SYNTH_CHOICES",
    draft: {
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic choices" },
      localizedDescriptions: {},
      displayStyle: "MultiChoice",
      minimumSelection: 0,
      maximumSelection: 1,
      allowRepeatedOption: false,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 1,
      options: [
        {
          stableCode: "CHOICE",
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic choice" },
          localizedDescriptions: {},
          sortOrder: 0,
          defaultEligible: true,
          triggeredOptionSetReference: null,
          conflictOptionCodes: [],
        },
      ],
    },
    additionalContent: {
      profile: "CatalogOptionSetEditorContentV1",
      optionDetails: [
        {
          stableCode: "CHOICE",
          quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
          media: null,
          pricingRule: null,
          consumption: null,
          triggeredOptionSetVersionReference: null,
        },
      ],
      conditionalRules: [],
      conflictRules: [],
      scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
    },
    operationReference: id(7),
    occurredAt: at,
    reasonCode: "INITIAL_CONFIGURATION",
  };
}
function full() {
  return materializeFullOptionSetCreation(creation(), {
    brandReference: id(2),
    actorReference: id(4),
    allocations: {
      optionSetReference: id(6),
      versionReference: id(8),
      options: [{ stableCode: "CHOICE", optionReference: id(9) }],
    },
  }).content;
}

type OriginalOptions = OptionSetPublicationOperationStoreOptions;
type Tx = Parameters<OriginalOptions["registerBeforeCommit"]>[0];
type Command = Parameters<
  OriginalOptions["authority"]["holdUntilTransactionCompletes"]
>[1]["command"];
type SourceOptions = Parameters<
  typeof createPostgresFullOptionSetPublicationSourceAdmissionStore
>[0];
type WriterOptions = Parameters<typeof createPostgresOptionSetReviewContentStore>[0];
type SealOptions = Parameters<typeof createPostgresFullOptionSetContentSealStore>[0];
// Controlled source/admission ports with actual public Catalog/Publishing parsers and mutation service.
// These cases test API composition, not native SQL, actual IAM, or source qualification.
function harness() {
  const content = full(),
    { sourceAggregate, ...additional } = content,
    parsed = parseCatalogOptionSetEditorContent(sourceAggregate, additional);
  const requestRoot = {
    optionSetReference: id(6),
    versionReference: id(8),
    expectedAggregateVersion: 1,
    sourceDigest: parsed.sourceDigest,
    contentDigest: parsed.contentDigest,
    configurationDigest: parsed.configurationDigest,
  };
  const state = {
    now: at,
    deadline: until,
    advanceQualificationMs: 0,
    actor: id(4),
    allowed: true,
    committed: false,
    failCommit: false,
    unavailable: false,
    decision: "Pass" as "Pass" | "HardError" | "Indeterminate",
    sequence: 100,
    sourceAdmitted: false,
    approvalPolicy: "Required" as "Required" | "NotRequired",
  };
  const sourceCurrent = {
    content,
    ...requestRoot,
    sourceOperationReference: id(7),
    sourceSnapshotTuple: {
      tenantReference: id(1),
      brandReference: id(2),
      optionSetReference: id(6),
      versionReference: id(8),
      aggregateVersion: 1,
      sourceDigest: parsed.sourceDigest,
      contentDigest: parsed.contentDigest,
      configurationDigest: parsed.configurationDigest,
    },
    observedAt: at,
    validUntil: until,
    referenceEligibility: "NotEvaluated",
  };
  const writes: CommitPublishingMutationInput[] = [],
    terminals = new Map<
      string,
      Exclude<OptionSetPublicationOriginalOperation, { outcome: "Absent" }>
    >(),
    order: string[] = [];
  let review: CatalogOptionSetReviewRecord | null = null,
    linkage: CatalogOptionSetReleaseRecord | null = null;
  const tx = {
    query: vi.fn(async (_sql: string, _values?: readonly unknown[]) => {
      void _sql;
      void _values;
      return { rows: [] };
    }),
  };
  const current = {
      assertCurrent: vi.fn(() => {
        if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return state.now;
      }),
      leaseDeadline: vi.fn(() => state.deadline),
      authorizeActionsWithDecisions: vi.fn(async (actions: readonly string[]) => {
        if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return actions.map((action) =>
          Object.freeze({
            effect: "Allow" as const,
            reason: "ROLE_PERMISSION" as const,
            source: "RolePermission" as const,
            action: parseBusinessAction(action),
            scopeKind: "Brand" as const,
            policySnapshotReference: parsePolicyReference(id(60)),
            policyVersion: parsePolicyVersion(1),
            audit: Object.freeze({
              effect: "Allow" as const,
              reason: "ROLE_PERMISSION" as const,
              source: "RolePermission" as const,
            }),
          }),
        );
      }),
    },
    capability = {
      holdUntilCommit: vi.fn(async () => undefined),
      holdUntilCommitWithDecisions: vi.fn(async (actions: readonly string[]) =>
        current.authorizeActionsWithDecisions(actions),
      ),
      leaseDeadline: vi.fn(() => state.deadline),
    };
  mocks.current.mockReturnValue(current);
  mocks.capability.mockReturnValue(capability);
  const context = () =>
    createTenantContext(
      createIdentityActor({
        actorType: "User",
        accountKind: "Workforce",
        actorReference: state.actor,
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt: at,
        recentMfaAt: null,
      }),
      createBrand({
        brandReference: id(2),
        code: "SYNTH_BRAND",
        displayName: "Synthetic Brand",
        defaultLocale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: at,
        updatedAt: at,
      }),
      null,
      state.now,
    );
  let actualHostTx: ProductLifecycleTransaction | undefined;
  mocks.scope.mockImplementation(async (actual: ProductLifecycleTransaction) => {
    actualHostTx = actual;
    return {
      tenantReference: id(1),
      actorReference: state.actor,
      context: context(),
      selectedStoreReference: id(3),
    };
  });
  const policyContent = () => ({
    profile: "PublishingOptionSetPublicationPolicyV1",
    tenantReference: id(1),
    brandReference: id(2),
    familyReference: id(30),
    policyReference: id(31),
    policyVersion: 1,
    scopeOrder: [...optionSetPolicyScopeLevels],
    approvalPolicy: state.approvalPolicy,
    warningOverrideAllowed: false,
    requiredLocales: ["en-CA"],
    mediaRequirement: "Optional",
    effectiveFrom: at,
    effectiveUntil: null,
  });
  const latest = () => writes[writes.length - 1];
  const submitted = () => writes.find((value) => value.operation === "SubmitReview");
  const originalReview = () => {
    const m = submitted(),
      head = latest();
    if (!m || !head || !m.validationEvidence) return null;
    if (m.audit.actor.type !== "User") throw Error("actual user submission required");
    return {
      reviewOperationReference: m.idempotencyKey,
      reviewLifecycle: m.next,
      submittedActorReference: m.audit.actor.reference,
      submittedAt: m.audit.occurredAt,
      originalValidationEvidence: m.validationEvidence,
      reviewPolicy: m.optionSetReviewPolicy ?? null,
      latestLifecycle: head.next,
      latestMutationOperationReference: head.idempotencyKey,
      approvalOperationReference: head.operation === "Approve" ? head.idempotencyKey : null,
      originalApprovalEvidence: head.operation === "Approve" ? head.approvalEvidence : null,
    };
  };
  mocks.publisher.mockReturnValue({
    resolveOptionSetReviewPolicy: vi.fn(async (input: Record<string, unknown>) =>
      parsePublishingOptionSetReviewPolicy({
        profile: "PublishingOptionSetReviewPolicyV1",
        tenantReference: id(1),
        policyContent: policyContent(),
        policyReleaseReference: id(32),
        policyReleaseSequence: 1,
        policySnapshotDigest: publishingOptionSetPublicationPolicyDigest(policyContent()),
        ...input,
      }),
    ),
    resolveRecordedOptionSetReviewForLifecycle: vi.fn(async () => originalReview()),
    resolveCurrentLifecycleMutation: vi.fn(async () => latest() ?? null),
    resolveCurrentOptionSetPublicationCandidate: vi.fn(async () => {
      const original = originalReview();
      if (!original?.reviewPolicy) throw Error("required original Review");
      return {
        lifecycle: original.latestLifecycle,
        latestMutationOperationReference: original.latestMutationOperationReference,
        reviewOperationReference: original.reviewOperationReference,
        approvalOperationReference: original.approvalOperationReference,
        originalValidationEvidence: original.originalValidationEvidence,
        originalApprovalEvidence: original.originalApprovalEvidence,
        reviewPolicy: original.reviewPolicy,
        previousRelease: null,
      };
    }),
    resolveCurrentOptionSetReleaseForReference: vi.fn(async () => {
      const head = latest();
      if (!head?.release) throw Error("actual release required");
      return {
        recorded: {
          release: head.release,
          lifecycle: head.next,
          auditReference: head.audit.auditId,
        },
        current: { release: head.release },
      };
    }),
  });
  mocks.original.mockImplementation((o: OriginalOptions) => {
    const admit = async (t: Tx, c: Command, mode: "Read" | "Write") => {
      const requiredPermissions =
        mode === "Read"
          ? ["catalog.option_set.read"]
          : [
              ...new Set([
                "catalog.option_set.read",
                ...(c.action === "SubmitReview"
                  ? [
                      "catalog.option_set.submit",
                      "publishing.review.submit",
                      ...(c.expectedLifecycle === null ? ["publishing.draft.create"] : []),
                    ]
                  : c.action === "Approve"
                    ? ["publishing.review.approve"]
                    : ["catalog.option_set.publish", "publishing.release.publish"]),
              ]),
            ].sort();
      const input = {
        command: c,
        mode,
        permission: "catalog.manage" as const,
        requiredPermissions,
        requiredFields: optionSetPublicationOperationFields,
        purposeCode: "CATALOG_OPTION_SET_PUBLICATION_OPERATION" as const,
        actorKind: "User" as const,
        observedAt: state.now,
        validUntil: o.originalValidUntil,
      };
      await o.authority.holdUntilTransactionCompletes(t, input);
      await o.registerBeforeCommit(
        t,
        async () => {
          await o.authority.holdUntilTransactionCompletes(t, input);
        },
        () => undefined,
      );
    };
    return {
      inspectOriginalOperation: vi.fn(async (t: Tx, c: Command) => {
        order.push("InspectOriginal");
        await admit(t, c, "Read");
        const existing = terminals.get(c.operationReference);
        if (existing && canonicalizeRfc8785(existing.command) !== canonicalizeRfc8785(c))
          throw Error("original mismatch");
        return existing ?? { outcome: "Absent" };
      }),
      withOriginalOperation: vi.fn(
        async (
          t: Tx,
          c: Command,
          work: (original: OptionSetPublicationOriginalOperation) => Promise<unknown>,
        ) => {
          order.push("PublishingSRE");
          expect(state.sourceAdmitted).toBe(true);
          await admit(t, c, "Write");
          return work({
            outcome: "Absent",
            createDraft: async (value) => {
              order.push("CreateDraft");
              const m = parseRecordedPublishingMutation(value);
              expect(m.audit.reasonCode).toBe("PUBLISHING_DRAFT_CREATED");
              expect(m.idempotencyKey).not.toBe(c.operationReference);
              writes.push(m);
              return { auditReference: parsePublishingReference(m.audit.auditId) };
            },
            commit: async (value) => {
              order.push(c.action);
              const m = parseRecordedPublishingMutation(value);
              expect(m.audit.reasonCode).toBe(c.reasonCode);
              expect(m.operation).toBe(c.action);
              expect(m.idempotencyKey).toBe(c.operationReference);
              writes.push(m);
              terminals.set(c.operationReference, {
                outcome: "Committed",
                command: c,
                originalOccurredAt: parsePublishingInstant(m.audit.occurredAt),
                auditReference: parsePublishingReference(m.audit.auditId),
                mutation: m,
              });
              return { auditReference: parsePublishingReference(m.audit.auditId) };
            },
          });
        },
      ),
    };
  });
  mocks.admission.mockImplementation((o: SourceOptions) => ({
    withOriginalSource: vi.fn(
      async (request: typeof requestRoot, work: (source: unknown) => Promise<unknown>) =>
        o.transactions.run(async (actualTx) => {
          order.push(o.action === "Publish" ? "ExclusiveSource" : "SharedSource");
          if (state.unavailable) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
          expect(request).toEqual(requestRoot);
          state.sourceAdmitted = true;
          const sealIdentity = o.sealCommand
            ? {
                operationReference: Reflect.get(o.sealCommand, "operationReference"),
                occurredAt: Reflect.get(o.sealCommand, "occurredAt"),
                publicationIntentDigest: createCatalogFullOptionSetContentSealIntent({
                  tenantReference: id(1),
                  brandReference: id(2),
                  actorReference: state.actor,
                  command: o.sealCommand,
                }),
              }
            : null;
          await o.authority.holdUntilTransactionCompletes(actualTx, {
            tenantReference: id(1),
            brandReference: id(2),
            actorReference: state.actor,
            actorKind: "User",
            permission: "catalog.manage",
            action:
              o.action === "SubmitReview"
                ? "catalog.option_set.submit"
                : o.action === "Publish"
                  ? "catalog.option_set.publish"
                  : "catalog.option_set.read",
            purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
            phase: "Current",
            requiredFields: fullOptionSetPublicationSourceAdmissionFields,
            request,
            operationReference: o.operationReference,
            reasonCode: o.reasonCode,
            originalObservedAt: o.originalObservedAt,
            originalValidUntil: o.originalValidUntil,
            sealIdentity,
            current: null,
            observedAt: state.now,
          });
          return work({
            current: { ...sourceCurrent, observedAt: state.now, validUntil: state.deadline },
            sealIdentity,
            admitOwnSeal: vi.fn(async () => {
              order.push("SourceHandoff");
            }),
          });
        }),
    ),
  }));
  mocks.validator.mockImplementation((o: CurrentOptionSetPublicationValidationOptions) => {
    const consume = async (
      input: Record<string, unknown>,
      work: (packet: CurrentOptionSetPublicationValidationPacket) => Promise<unknown>,
    ) => {
      order.push("Qualification");
      if (state.unavailable) throw Error("controlled source unavailable");
      state.now = new Date(Date.parse(state.now) + state.advanceQualificationMs).toISOString();
      const fresh = {
        tenantReference: id(1),
        brandReference: id(2),
        optionSetReference: id(6),
        versionReference: id(8),
        expectedAggregateVersion: 1,
        sourceDigest: parsed.sourceDigest,
        contentDigest: parsed.contentDigest,
        configurationDigest: parsed.configurationDigest,
        graphDigest: hash("graph"),
        originalIntentDigest: input.originalIntentDigest,
        activationAt: o.originalObservedAt,
      };
      const reviewBinding =
        review?.binding ??
        createCatalogOptionSetContentReviewBinding({
          ...fresh,
          policyReference: id(31),
          policyVersion: 1,
          policyContentDigest: publishingOptionSetPublicationPolicyDigest(policyContent()),
          currentPolicyPublicationReference: id(32),
        });
      const packet: CurrentOptionSetPublicationValidationPacket = {
        profile: "CurrentOptionSetPublicationValidationV1",
        operationReference: o.operationReference,
        sourceOperationReference: id(7),
        reviewBinding,
        content,
        recordedReview: review,
        qualifiedActivationAt: o.originalObservedAt,
        qualificationBinding: parseCatalogOptionSetContentPolicyBinding({
          ...fresh,
          observedAt: o.originalObservedAt,
          validUntil: o.originalValidUntil,
        }),
        checks: optionContentReviewValidationCodes.map((code) => ({
          code,
          outcome: state.decision,
        })),
        findings: [],
        sourceAssessmentDigests: {
          brandPolicy: hash("Brand"),
          priceInventory: hash("PricingInventory"),
          recipe: hash("Recipe"),
          media: hash("Media"),
        },
        decision: state.decision,
        originalObservedAt: o.originalObservedAt,
        observedAt: state.now,
        validUntil: o.originalValidUntil,
        independentApproval: "NotEvaluated",
        saleEligibility: "NotEvaluated",
        digest: hash("controlled actual-shape report"),
      };
      return work(packet);
    };
    return {
      withCurrentValidation: vi.fn(consume),
      withCurrentRecordedReviewValidation: vi.fn(consume),
      admitOwnSeal: vi.fn(async () => {
        order.push("ValidatorHandoff");
      }),
    };
  });
  mocks.writer.mockImplementation((o: WriterOptions) => ({
    readCurrentReviewForDraft: vi.fn(async () => {
      order.push("CurrentReviewAfterSRE");
      return review;
    }),
    saveReview: vi.fn(
      async (t: Tx, r: CatalogOptionSetReviewRecord, audit: AppendAuditRecordInput) => {
        if (!actualHostTx || t !== actualHostTx) throw Error("actual host transaction required");
        expect(audit.reasonCode).toBe(r.reasonCode);
        expect(audit.correlationId).toBe(r.operationReference);
        expect(audit.auditId).toBe(r.auditReference);
        review = r;
        await o.authority.holdUntilTransactionCompletes(actualHostTx, {
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: state.actor,
          actorKind: "User",
          permission: "catalog.manage",
          action: "catalog.option_set.submit",
          purposeCode: "CATALOG_OPTION_SET_REVIEW_RECORD",
          phase: "Apply",
          optionSetReference: id(6),
          requiredFields: [
            "profile",
            "operationReference",
            "sourceOperationReference",
            "lifecycleReference",
            "actorReference",
            "auditReference",
            "reasonCode",
            "recordedAt",
            "binding",
            "content",
            "digest",
          ],
          record: r,
          observedAt: state.now,
        });
        return { status: "Recorded", record: r };
      },
    ),
    saveRelease: vi.fn(
      async (t: Tx, r: CatalogOptionSetReleaseRecord, audit: AppendAuditRecordInput) => {
        if (!actualHostTx || t !== actualHostTx) throw Error("actual host transaction required");
        expect(audit.reasonCode).toBe(r.reasonCode);
        expect(audit.correlationId).toBe(r.operationReference);
        expect(audit.auditId).toBe(r.auditReference);
        for (const phase of ["Read", "Intent", "Apply"] as const) {
          await o.authority.holdUntilTransactionCompletes(actualHostTx, {
            tenantReference: id(1),
            brandReference: id(2),
            actorReference: state.actor,
            actorKind: "User",
            permission: "catalog.manage",
            action: phase === "Read" ? "catalog.option_set.read" : "catalog.option_set.publish",
            purposeCode: "CATALOG_OPTION_SET_RELEASE_RECORD",
            phase,
            optionSetReference: id(6),
            requiredFields: optionSetReleaseRecordFields,
            record: phase === "Read" ? null : r,
            observedAt: state.now,
          });
        }
        linkage = r;
        return { status: "Recorded", record: r };
      },
    ),
    readRelease: vi.fn(async (t: Tx) => {
      if (!actualHostTx || t !== actualHostTx) throw Error("actual host transaction required");
      await o.authority.holdUntilTransactionCompletes(actualHostTx, {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: state.actor,
        actorKind: "User",
        permission: "catalog.manage",
        action: "catalog.option_set.read",
        purposeCode: "CATALOG_OPTION_SET_RELEASE_RECORD",
        phase: "Read",
        optionSetReference: id(6),
        requiredFields: optionSetReleaseRecordFields,
        record: linkage,
        observedAt: state.now,
      });
      return linkage;
    }),
  }));
  mocks.sealer.mockImplementation((o: SealOptions) => ({
    seal: vi.fn(
      async (
        command: typeof requestRoot & {
          operationReference: string;
          occurredAt: string;
          reasonCode: string;
        },
      ) =>
        o.transactions.run(async (actualTx) => {
          order.push("Seal");
          const fields = currentFullOptionSetDraftFields.filter(
            (value) =>
              ![
                "brandReference",
                "lifecycle",
                "createdAt",
                "createdByActorReference",
                "updatedAt",
              ].includes(value),
          );
          await o.authority.holdUntilTransactionCompletes(actualTx, {
            tenantReference: id(1),
            brandReference: id(2),
            actorReference: state.actor,
            actorKind: "User",
            permission: "catalog.manage",
            action: "catalog.option_set.publish",
            purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
            phase: "Apply",
            requiredFields: fields,
            requiredChecks: fullOptionSealChecks,
            command,
            content,
            observedAt: state.now,
          });
          const plan = createCatalogFullOptionSetPublicationMaterialization(
            sourceAggregate,
            additional,
            {
              tenantReference: id(1),
              brandReference: id(2),
              optionSetReference: id(6),
              versionReference: id(8),
              sourceAggregateVersion: 1,
              publicationOperationReference: command.operationReference,
              publicationIntentDigest: createCatalogFullOptionSetContentSealIntent({
                tenantReference: id(1),
                brandReference: id(2),
                actorReference: state.actor,
                command,
              }),
              successorDraftVersionReference: id(900),
              sealedAt: command.occurredAt,
              sourceDigest: parsed.sourceDigest,
              contentDigest: parsed.contentDigest,
              configurationDigest: parsed.configurationDigest,
            },
          );
          const audit = o.audit.create({
            operationReference: command.operationReference,
            reasonCode: command.reasonCode,
            occurredAt: command.occurredAt,
            result: plan.content,
          });
          expect(audit.reasonCode).toBe(command.reasonCode);
          expect(audit.correlationId).toBe(command.operationReference);
          return { status: "Applied", content: plan.content };
        }),
    ),
  }));
  const authentication = { authorize: vi.fn(async () => ({ sessionReference: id(5) })) },
    merchant = {
      now: () => state.now,
      transactions: {
        async run<T>(work: (t: typeof tx) => Promise<T>) {
          const value = await work(tx);
          if (state.failCommit) throw Error("controlled COMMIT failure");
          state.committed = true;
          return value;
        },
      },
    };
  const options = {
    merchant: merchant as unknown as Parameters<
      typeof createMerchantOptionSetPublicationCommand
    >[0]["merchant"],
    authentication: authentication as unknown as Parameters<
      typeof createMerchantOptionSetPublicationCommand
    >[0]["authentication"],
    generateReference: () => id(++state.sequence),
    optionSetPolicyFamilyReference: id(30),
    policyReference: id(31),
    policyVersion: 1,
    brandConfigurationVersionReference: id(40),
    expectedBrandVersion: 1,
    mediaScope: createMediaScope({
      kind: "Brand",
      brandReference: context().brand.brandReference,
      storeReference: null,
    }),
  };
  const body = (action: "Validate" | "SubmitReview" | "Approve" | "Publish", op = id(50)) => ({
    profile: "CatalogOptionSetPublicationCommandRequestV1",
    action,
    ...requestRoot,
    ...(action === "Validate"
      ? {}
      : {
          operationReference: op,
          expectedReview: review
            ? {
                reviewOperationReference: review.operationReference,
                publishingReviewOperationReference: submitted()?.idempotencyKey,
                recordDigest: review.digest,
                bindingDigest: review.binding.digest,
              }
            : null,
          expectedLifecycle: latest()
            ? {
                lifecycleReference: latest()?.next.lifecycleId,
                version: latest()?.next.version,
                state: latest()?.next.state,
                latestMutationOperationReference: latest()?.idempotencyKey,
              }
            : null,
        }),
  });
  const execute = (command: unknown) => {
    state.deadline = new Date(Date.parse(state.now) + 5000).toISOString();
    state.sourceAdmitted = false;
    state.committed = false;
    return createMerchantOptionSetPublicationCommand(options)({
      sessionCookie: "synthetic-session",
      csrf: "synthetic-csrf",
      expectedScope: { brandReference: id(2), storeReference: id(3) },
      command,
    });
  };
  return {
    state,
    requestRoot,
    tx,
    current,
    capability,
    options,
    authentication,
    writes,
    terminals,
    order,
    body,
    execute,
    getReview: () => review,
    getLinkage: () => linkage,
  };
}
it("Validate returns the real composed report and four outcomes without publication mutation", async () => {
  const h = harness(),
    result = await h.execute(h.body("Validate"));
  expect(h.state.committed).toBe(true);
  expect(result).toMatchObject({
    outcome: "Validated",
    validation: {
      decision: "Pass",
      independentApproval: "NotEvaluated",
      saleEligibility: "NotEvaluated",
    },
  });
  expect(h.writes).toHaveLength(0);
  expect(mocks.original).not.toHaveBeenCalled();
});
it("first Submit reads absence after shared source and SRE, then commits two distinct mutations and Catalog Review", async () => {
  const h = harness(),
    result = await h.execute(h.body("SubmitReview"));
  expect(result).toMatchObject({
    resolution: { outcome: "Committed", mutation: { operation: "SubmitReview" } },
  });
  expect(h.writes.map((value) => value.operation)).toEqual(["CreateDraft", "SubmitReview"]);
  expect(h.writes[0]?.idempotencyKey).not.toBe(h.writes[1]?.idempotencyKey);
  expect(h.getReview()?.operationReference).not.toBe(h.writes[1]?.idempotencyKey);
  expect(h.order.indexOf("InspectOriginal")).toBeLessThan(h.order.indexOf("SharedSource"));
  expect(h.order.indexOf("SharedSource")).toBeLessThan(h.order.indexOf("PublishingSRE"));
  expect(h.order.indexOf("PublishingSRE")).toBeLessThan(h.order.indexOf("CurrentReviewAfterSRE"));
  expect(h.order.indexOf("CurrentReviewAfterSRE")).toBeLessThan(h.order.indexOf("CreateDraft"));
  expect(h.state.committed).toBe(true);
});
it("actual independent Actor approves recorded Review without inventing a Catalog approval action", async () => {
  const h = harness();
  await h.execute(h.body("SubmitReview"));
  h.state.actor = id(70);
  const result = await h.execute(h.body("Approve", id(51)));
  expect(result).toMatchObject({
    resolution: {
      outcome: "Committed",
      mutation: { operation: "Approve", approvalEvidence: { approvedActorReference: id(70) } },
    },
  });
  expect(
    h.current.authorizeActionsWithDecisions.mock.calls.flatMap((call) => call[0]),
  ).not.toContain("catalog.option_set.approve");
  expect(h.writes).toHaveLength(3);
});
it("same submitting Actor cannot approve its own Review", async () => {
  const h = harness();
  await h.execute(h.body("SubmitReview"));
  await expect(h.execute(h.body("Approve", id(51)))).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(h.writes).toHaveLength(2);
  expect(h.state.committed).toBe(false);
});
it("Approved Publish uses genuine seal handoffs and final own Published head rather than old Approved guard", async () => {
  const h = harness();
  await h.execute(h.body("SubmitReview"));
  h.state.actor = id(70);
  await h.execute(h.body("Approve", id(51)));
  const result = await h.execute(h.body("Publish", id(52)));
  expect(result).toMatchObject({
    resolution: {
      outcome: "Committed",
      mutation: {
        operation: "Publish",
        next: { state: "Published" },
        release: { kind: "Publish" },
      },
    },
  });
  expect(h.order.indexOf("ExclusiveSource")).toBeLessThan(h.order.lastIndexOf("PublishingSRE"));
  expect(h.order).toContain("Seal");
  expect(h.order).toContain("SourceHandoff");
  expect(h.order).toContain("ValidatorHandoff");
  expect(h.getLinkage()?.publishingOperationReference).toBe(id(52));
  const batches = h.current.authorizeActionsWithDecisions.mock.calls.map(([actions]) => actions);
  expect(batches.some((actions) => actions.includes("publishing.release.publish"))).toBe(true);
  expect(batches.some((actions) => actions.length === 1)).toBe(false);
  expect(h.capability.holdUntilCommit).not.toHaveBeenCalled();
  expect(h.capability.holdUntilCommitWithDecisions).toHaveBeenCalled();

  expect(h.state.committed).toBe(true);
});
it("NotRequired Publish retains actual original policy waiver and null approval with current proof", async () => {
  const h = harness();
  h.state.approvalPolicy = "NotRequired";
  await h.execute(h.body("SubmitReview"));
  const result = await h.execute(h.body("Publish", id(52)));
  expect(result).toMatchObject({
    resolution: {
      outcome: "Committed",
      mutation: {
        approvalEvidence: null,
        optionSetApprovalWaiver: {
          reviewPolicy: { policyContent: { approvalPolicy: "NotRequired" } },
          currentQualification: { operationReference: id(52) },
        },
      },
    },
  });
  expect(h.writes.map((value) => value.operation)).toEqual([
    "CreateDraft",
    "SubmitReview",
    "Publish",
  ]);
});
it("Required InReview is not waived by caller Publish intent", async () => {
  const h = harness();
  await h.execute(h.body("SubmitReview"));
  await expect(h.execute(h.body("Publish", id(52)))).rejects.toThrow();
  expect(h.writes).toHaveLength(2);
  expect(h.order).not.toContain("Seal");
});
it.each(["HardError", "Indeterminate"] as const)(
  "%s source result cannot create Draft or Submit Review",
  async (outcome) => {
    const h = harness();
    h.state.decision = outcome;
    await expect(h.execute(h.body("SubmitReview"))).rejects.toThrow();
    expect(h.writes).toHaveLength(0);
    expect(h.state.committed).toBe(false);
  },
);
it("a genuine newly recorded Review after original Context absence blocks a replacement first Submit", async () => {
  const h = harness();
  await h.execute(h.body("SubmitReview"));
  const replacement = {
    ...h.body("SubmitReview", id(53)),
    expectedReview: null,
    expectedLifecycle: null,
  };
  await expect(h.execute(replacement)).rejects.toMatchObject({ code: "CATALOG_VERSION_CONFLICT" });
  expect(h.writes).toHaveLength(2);
});
it("original committed retry bypasses unavailable current source and qualification without allocating new references", async () => {
  const h = harness(),
    body = h.body("SubmitReview");
  const first = await h.execute(body),
    sequence = h.state.sequence,
    qualification = h.order.filter((value) => value === "Qualification").length;
  h.state.unavailable = true;
  const replay = await h.execute(body);
  expect(replay).toEqual(first);
  expect(h.state.sequence).toBe(sequence);
  expect(h.writes).toHaveLength(2);
  expect(h.order.filter((value) => value === "Qualification")).toHaveLength(qualification);
});
it("original Abandoned receipt never opens a replacement write callback", async () => {
  const h = harness(),
    body = h.body("SubmitReview");
  await h.execute(body);
  const c = h.terminals.get(id(50));
  if (!c) throw Error("required actual fixture original");
  h.terminals.set(id(50), {
    outcome: "Abandoned",
    command: c.command,
    recordedAt: parsePublishingInstant(at),
    auditReference: parsePublishingReference(id(80)),
  });
  const writes = h.writes.length,
    sequence = h.state.sequence;
  expect(await h.execute(body)).toMatchObject({ resolution: { outcome: "Abandoned" } });
  expect(h.writes).toHaveLength(writes);
  expect(h.state.sequence).toBe(sequence);
});
it.each([
  "tenantReference",
  "actorReference",
  "brandReference",
  "storeReference",
  "occurredAt",
  "policyReference",
  "approvalEvidence",
  "content",
])("rejects browser %s before authentication", async (field) => {
  const h = harness();
  await expect(h.execute({ ...h.body("SubmitReview"), [field]: id(99) })).rejects.toMatchObject({
    code: "CATALOG_INPUT_INVALID",
  });
  expect(h.authentication.authorize).not.toHaveBeenCalled();
});
it("late actual permission withdrawal poisons COMMIT and does not return a tentative mutation", async () => {
  const h = harness();
  const old = mocks.writer.getMockImplementation();
  if (!old) throw Error("required fixture writer");
  mocks.writer.mockImplementation((o: WriterOptions) => {
    const writer = old(o);
    const save = writer.saveReview;
    writer.saveReview = async (...args: Parameters<typeof save>) => {
      const result = await save(...args);
      h.state.allowed = false;
      return result;
    };
    return writer;
  });
  await expect(h.execute(h.body("SubmitReview"))).rejects.toThrow();
  expect(h.state.committed).toBe(false);
});
it("outer COMMIT failure never reports applied mutation", async () => {
  const h = harness();
  h.state.failCommit = true;
  await expect(h.execute(h.body("SubmitReview"))).rejects.toThrow();
  expect(h.state.committed).toBe(false);
});

it("delayed NotRequired publication keeps original expired validation unchanged and records later real qualification/release time", async () => {
  const h = harness();
  h.state.approvalPolicy = "NotRequired";
  await h.execute(h.body("SubmitReview"));
  const original = h.writes[1]?.validationEvidence;
  if (!original) throw Error("required original immutable validation");
  h.state.now = "2026-10-04T12:00:10.000Z";
  h.state.advanceQualificationMs = 100;
  const result = await h.execute(h.body("Publish", id(52)));
  expect(result).toMatchObject({
    resolution: {
      mutation: {
        validationEvidence: original,
        optionSetCurrentQualification: {
          originalObservedAt: "2026-10-04T12:00:10.000Z",
          checkedAt: "2026-10-04T12:00:10.100Z",
        },
        release: { createdAt: "2026-10-04T12:00:10.100Z" },
      },
    },
  });
  expect(h.getLinkage()?.recordedAt).toBe("2026-10-04T12:00:10.100Z");
  expect(h.writes[2]?.validationEvidence?.validUntil).toBe(until);
});

it("ordinary publication refuses a missing combined authority port without legacy fallback", async () => {
  const h = harness();
  Object.defineProperty(h.capability, "holdUntilCommitWithDecisions", { value: undefined });
  await expect(h.execute(h.body("SubmitReview"))).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(h.capability.holdUntilCommit).not.toHaveBeenCalled();
  expect(h.writes).toHaveLength(0);
  expect(h.state.committed).toBe(false);
});

it("constructs one transaction Permission source before Scope and shares it with the actual authorization bridge", async () => {
  const h = harness();
  await h.execute(h.body("Validate"));
  const actualTransaction = mocks.scope.mock.calls[0]?.[0];
  if (!actualTransaction) throw Error("actual guarded transaction was not captured");
  expect(actualTransaction).not.toBe(h.tx);
  expect(typeof actualTransaction.query).toBe("function");
  expect(actualTransaction.query).not.toBe(h.tx.query);
  expect(mocks.permission).toHaveBeenCalledExactlyOnceWith(actualTransaction);
  const owner = mocks.permission.mock.results[0]?.value;
  expect(owner).toBeDefined();
  expect(mocks.brandFactory).toHaveBeenCalledWith(expect.anything(), owner);
  expect(mocks.current).toHaveBeenCalledWith(
    expect.objectContaining({ transaction: actualTransaction, permissionPolicy: owner }),
  );
  expect(mocks.permission.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.scope.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
  );
});
