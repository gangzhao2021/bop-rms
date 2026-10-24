import { beforeEach, expect, it, vi } from "vitest";
import { createIdentityActor } from "@bop/identity";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { createFeatureControlAdministrationDefinition } from "@bop/feature-control";
import { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import {
  CatalogError,
  createCatalogFullOptionSetPublicationMaterialization,
  createCatalogOptionSetReleaseRecord,
  parseCatalogOptionSetEditorContent,
  evaluateCatalogOptionSetRuleSatisfiability,
  parseCatalogInstant,
  frozenFullOptionSetContentFields,
  optionSetReleaseRecordFields,
  type createPostgresFrozenFullOptionSetContentStore,
  type createPostgresOptionSetReviewContentStore,
} from "@rms/catalog";
import {
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
  createPublishingApprovalEvidence,
  parsePublishingReference,
  parsePublishingVersion,
  parsePublishingInstant,
  parsePublishingCode,
} from "@bop/publishing";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import {
  createCurrentPublishedOptionSetGraphSource,
  type CurrentPublishedOptionSetGraphOptions,
} from "./current-published-option-set-graph.js";
const owner = vi.hoisted(() => ({
  publishing: vi.fn(),
  current: vi.fn(),
  referenced: vi.fn(),
  review: vi.fn(),
  release: vi.fn(),
  frozen: vi.fn(),
  pinned: vi.fn(),
}));
vi.mock("@bop/publishing", async (original) => ({
  ...(await original<object>()),
  createPostgresPublishingMutationStore: owner.publishing,
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<object>()),
  createPostgresOptionSetReviewContentStore: owner.review,
  createPostgresFrozenFullOptionSetContentStore: owner.frozen,
}));
const id = (n: number) => "01902421-7990-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z";
const fingerprint = "sha256:" + "a".repeat(64);
type FrozenOptions = Parameters<typeof createPostgresFrozenFullOptionSetContentStore>[0];
type ReviewOptions = Parameters<typeof createPostgresOptionSetReviewContentStore>[0];
function node(n = 10, child: number | null = null, childVersion: number | null = null) {
  const source = {
    optionSetReference: id(n),
    brandReference: id(2),
    internalCode: "SYNTH_" + n,
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(4),
    updatedAt: at,
    draft: {
      versionReference: id(n + 100),
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic choices " + n },
      localizedDescriptions: {},
      displayStyle: "MultiChoice",
      minimumSelection: 0,
      maximumSelection: 1,
      allowRepeatedOption: false,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 1,
      createdAt: at,
      updatedAt: at,
      options: [
        {
          optionReference: id(n + 200),
          optionSetReference: id(n),
          brandReference: id(2),
          stableCode: "ONE",
          lifecycle: "Active",
          localizedNames: { "en-CA": "Synthetic choice" },
          localizedDescriptions: {},
          sortOrder: 0,
          defaultEligible: false,
          triggeredOptionSetReference: child === null ? null : id(child),
          conflictOptionReferences: [],
          createdAt: at,
          createdByActorReference: id(4),
        },
      ],
    },
  };
  const additional = {
    profile: "CatalogOptionSetEditorContentV1",
    optionDetails: [
      {
        optionReference: id(n + 200),
        quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
        media: null,
        pricingRule: null,
        consumption: null,
        triggeredOptionSetVersionReference: childVersion === null ? null : id(childVersion),
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
  };
  const prepared = parseCatalogOptionSetEditorContent(source, additional);
  const content = createCatalogFullOptionSetPublicationMaterialization(source, additional, {
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: id(n),
    versionReference: id(n + 100),
    sourceAggregateVersion: 1,
    publicationOperationReference: id(n + 300),
    publicationIntentDigest: fingerprint,
    successorDraftVersionReference: id(n + 400),
    sealedAt: at,
    sourceDigest: prepared.sourceDigest,
    contentDigest: prepared.contentDigest,
    configurationDigest: prepared.configurationDigest,
  }).content;
  const linkage = createCatalogOptionSetReleaseRecord({
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: id(n),
    versionReference: id(n + 100),
    operationReference: id(n + 500),
    reviewOperationReference: id(n + 600),
    reviewRecordDigest: fingerprint,
    reviewBindingDigest: fingerprint,
    sealOperationReference: id(n + 300),
    sealRecordDigest: content.digest,
    publishingOperationReference: id(n + 700),
    actorReference: id(4),
    auditReference: id(n + 800),
    reasonCode: "AUTHORIZED_OPERATION",
    recordedAt: at,
    release: {
      releaseId: id(n + 900),
      familyReference: id(n),
      configurationType: "CATALOG_OPTION_SET",
      purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
      snapshotReference: id(n + 100),
      snapshotDigest: fingerprint,
      scope: { kind: "Brand", brandReference: id(2), storeReference: null },
      sequence: 1,
      sourceLifecycleId: id(n + 1000),
      kind: "Publish",
      previousReleaseId: null,
      createdAt: at,
    },
  });
  const release = linkage.release;
  const validation = createPublishingValidationEvidence({
    evidenceReference: parsePublishingReference(id(n + 1100)),
    snapshotReference: release.snapshotReference,
    snapshotDigest: release.snapshotDigest,
    scope: release.scope,
    result: "Pass",
    checkedAt: parsePublishingInstant(at),
    validUntil: parsePublishingInstant("2026-10-05T12:01:00.000Z"),
    checkCodes: [parsePublishingCode("CURRENT_REFERENCES")],
  });
  const approval = createPublishingApprovalEvidence({
    evidenceReference: parsePublishingReference(id(n + 1200)),
    reviewLifecycleId: release.sourceLifecycleId,
    reviewVersion: parsePublishingVersion(2),
    snapshotReference: release.snapshotReference,
    snapshotDigest: release.snapshotDigest,
    scope: release.scope,
    decision: "Accepted",
    approvedActorReference: parsePublishingReference(id(5)),
    approvedAt: parsePublishingInstant(at),
    validUntil: validation.validUntil,
  });
  const lifecycle = createPublishingLifecycleRecord({
    lifecycleId: release.sourceLifecycleId,
    familyReference: release.familyReference,
    configurationType: release.configurationType,
    purposeCode: release.purposeCode,
    snapshotReference: release.snapshotReference,
    snapshotDigest: release.snapshotDigest,
    scope: release.scope,
    version: parsePublishingVersion(4),
    state: "Published",
    validationEvidenceReference: validation.evidenceReference,
    approvalEvidenceReference: approval.evidenceReference,
    createdAt: release.createdAt,
    changedAt: release.createdAt,
  });
  const proof = {
    release,
    lifecycle,
    validationEvidence: validation,
    approvalEvidence: approval,
    auditReference: parsePublishingReference(id(n + 1300)),
    approvalDisposition: "Approved" as const,
    waiver: null,
    observedAt: at,
  };
  return { content, linkage, proof };
}
interface Controls {
  nodes: Map<string, ReturnType<typeof node>>;
  omittedLinkage: boolean;
  wrongContent: boolean;
  wrongTransaction: boolean;
  wrongFields: boolean;
  missingChildPin: boolean;
}
let controls: Controls;
beforeEach(() => {
  vi.clearAllMocks();
  controls = {
    nodes: new Map([[id(10), node()]]),
    omittedLinkage: false,
    wrongContent: false,
    wrongTransaction: false,
    wrongFields: false,
    missingChildPin: false,
  };
  owner.publishing.mockReturnValue({
    resolveCurrentOptionSetRelease: owner.current,
    resolveCurrentOptionSetReleaseForReference: owner.referenced,
  });
  owner.current.mockImplementation(
    async (input: { familyReference: string; observedAt: string }) => {
      const current = controls.nodes.get(input.familyReference);
      if (!current) throw new Error("synthetic missing current release");
      return { ...current.proof, observedAt: input.observedAt };
    },
  );
  owner.referenced.mockImplementation(
    async (input: { publicationReference: string; observedAt: string }) => {
      const current = [...controls.nodes.values()].find(
        (n) => String(n.proof.release.releaseId) === input.publicationReference,
      );
      if (!current) throw new Error("synthetic missing reference");
      const { observedAt, ...recorded } = current.proof;
      void observedAt;
      return {
        recorded,
        current: { ...recorded, observedAt: input.observedAt },
        observedAt: input.observedAt,
      };
    },
  );
  owner.review.mockImplementation((options: ReviewOptions) => ({
    readReleaseForPublication: owner.release.mockImplementation(
      async (
        tx: Parameters<ReviewOptions["registerBeforeCommit"]>[0],
        publication: string,
        set: string,
      ) => {
        const current = controls.nodes.get(set);
        if (!current) throw new Error("missing fixture");
        const observation = options.clock.now();
        const input = {
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(4),
          actorKind: "User" as const,
          permission: "catalog.manage" as const,
          action: "catalog.option_set.read" as const,
          purposeCode: "CATALOG_OPTION_SET_RELEASE_RECORD" as const,
          phase: "Read" as const,
          optionSetReference: set,
          requiredFields: optionSetReleaseRecordFields,
          record: null,
          observedAt: observation,
        };
        await options.authority.holdUntilTransactionCompletes(tx, input);
        expect(publication).toBe(String(current.proof.release.releaseId));
        if (controls.omittedLinkage) return null;
        await options.authority.holdUntilTransactionCompletes(tx, {
          ...input,
          record: current.linkage,
        });
        return current.linkage;
      },
    ),
  }));
  owner.frozen.mockImplementation((options: FrozenOptions) => ({
    readPinned: owner.pinned.mockImplementation(
      async (request: {
        optionSetReference: string;
        versionReference: string;
        expectedRecordDigest: string;
      }) =>
        options.transactions.run(async (tx) => {
          const current = controls.nodes.get(request.optionSetReference);
          if (!current) throw new Error("missing fixture");
          const observation = options.clock.now();
          const input = {
            tenantReference: id(1),
            brandReference: id(2),
            actorReference: id(4),
            actorKind: "User" as const,
            permission: "catalog.manage" as const,
            action: "catalog.option_set.read" as const,
            purposeCode: "CATALOG_OPTION_SET_FROZEN_CONTENT" as const,
            requiredFields: controls.wrongFields ? [] : frozenFullOptionSetContentFields,
            optionSetReference: request.optionSetReference,
            versionReference: request.versionReference,
            content: null,
            observedAt: observation,
          };
          const actual = controls.wrongTransaction ? { ...tx } : tx;
          await options.authority.holdUntilTransactionCompletes(actual, input);
          expect(request.expectedRecordDigest).toBe(current.linkage.sealRecordDigest);
          // Corrupt the returned owner packet only after constructing lawful full
          // fixtures. The actual public parser must reject this missing trigger pair.
          const content = controls.wrongContent
            ? node(11).content
            : controls.missingChildPin
              ? {
                  ...current.content,
                  editorContent: {
                    ...current.content.editorContent,
                    optionDetails: current.content.editorContent.optionDetails.map((detail) => ({
                      ...detail,
                      triggeredOptionSetVersionReference: null,
                    })),
                  },
                }
              : current.content;
          const evidence = await options.authority.holdUntilTransactionCompletes(tx, {
            ...input,
            content,
          });
          return {
            content,
            observedAt: observation,
            validUntil: evidence.validUntil,
            eligibility: "NotEvaluated",
          };
        }),
    ),
  }));
});
function pricingFeature() {
  return createFeatureControlAdministrationDefinition({
    controlId: id(81),
    key: "pricing.pricebook.editor",
    description: "Controlled Pricing feature",
    version: 1,
    ownerReference: id(4),
    purposeCode: "PRICE_BOOK_EDITOR",
    scope: { kind: "Brand", brandReference: id(2), storeReference: null },
    source: "BrandOverride",
    defaultValue: "Disabled",
    configuredValue: "Enabled",
    lifecycle: "Published",
    temporary: false,
    effectiveFrom: at,
    effectiveUntil: null,
    reviewAt: "2026-10-06T12:00:00.000Z",
    expiresAt: null,
    dependencies: [],
    authoredByReference: id(4),
    approvedByReference: id(82),
    approvalEvidenceReference: id(83),
    publicationReference: id(84),
  });
}
function pricingContext(observedAt: string) {
  return createTenantContext(
    createIdentityActor({
      actorType: "User",
      accountKind: "Workforce",
      actorReference: id(4),
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    }),
    createBrand({
      brandReference: id(2),
      code: "SYNTH",
      displayName: "Synthetic",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    createStore({
      storeReference: id(3),
      brandReference: id(2),
      code: "SYNTH",
      displayName: "Synthetic",
      timeZone: "UTC",
      locale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    observedAt,
  );
}
function fixture(
  useCombined = false,
  capabilityPermissionAction?: "catalog.manage" | "pricing.price-book.manage",
  genuinePricing = false,
) {
  let observedAt = at,
    denied = false,
    committed = false;
  const authorize = vi.fn(async (actions: readonly string[]) => {
    void actions;
    if (denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
  });
  let combinedInvalid = "";
  const legacyCapability = vi.fn(async () => undefined);
  const combined = vi.fn(async (actions: readonly string[]) => {
    if (denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    return combinedDecisions(actions, combinedInvalid);
  });
  const query = vi.fn(async (sql: string) => ({
    rows:
      genuinePricing && sql.includes("pg_catalog.pg_constraint")
        ? [{ complete: true }]
        : genuinePricing && sql.includes("FROM bop_feature_control.control_version")
          ? [{ definition: pricingFeature(), recordedAt: at, dependencies: [] }]
          : [],
  }));
  const host = createMerchantCategoryTransactions({
    async run(work) {
      const result = await work({
        async query<Row>(sql: string) {
          const packet = await query(sql);
          // Controlled own Feature rows are parsed by the genuine owning reader.
          return { rows: packet.rows as unknown as readonly Row[] };
        },
      });
      committed = true;
      return result;
    },
  });
  let options: CurrentPublishedOptionSetGraphOptions | undefined;
  const run = <T>(
    work: (source: ReturnType<typeof createCurrentPublishedOptionSetGraphSource>) => Promise<T>,
  ) =>
    host.transactions.run(async (tx) => {
      const currentOptions: CurrentPublishedOptionSetGraphOptions = {
        transaction: tx,
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        actorReference: id(4),
        sessionReference: id(6),
        clock: { now: () => observedAt },
        originalValidUntil: until,
        ...(capabilityPermissionAction === undefined ? {} : { capabilityPermissionAction }),
        currentAuthorization: {
          authorizeActions: authorize,
          ...(genuinePricing ? { authorizeActionsWithDecisions: combined } : {}),
          assertCurrent: () => parseCatalogInstant(observedAt),
          leaseDeadline: () => until,
          async withCurrentStoreScope(input, work) {
            if (!genuinePricing) throw new Error("not used by injected synthetic Feature fixture");
            expect(input.capabilityKey).toBe("pricing.price_book_editor");
            return work(pricingContext(input.observedAt));
          },
        },
        capability: {
          holdUntilCommit: legacyCapability,
          ...(useCombined ? { holdUntilCommitWithDecisions: combined } : {}),
          leaseDeadline: () => until,
        },
        registerBeforeCommit: host.registerBeforeCommit,
        events: { generateReference: () => id(7) },
      };
      const selectedOptions = genuinePricing
        ? {
            ...currentOptions,
            capability: createMerchantProductStoreCapabilityGuard({
              ...currentOptions,
              capabilityKey: "pricing.price_book_editor",
            }),
          }
        : currentOptions;
      options = selectedOptions;
      return work(createCurrentPublishedOptionSetGraphSource(selectedOptions));
    });
  return {
    run,
    combined,
    legacyCapability,
    invalidCombined: (value: string) => {
      combinedInvalid = value;
    },
    authorize,
    query,
    setTime: (value: string) => {
      observedAt = value;
    },
    deny: () => {
      denied = true;
    },
    committed: () => committed,
    options: () => {
      if (!options) throw new Error("fixture not entered");
      return options;
    },
  };
}
const request = (versionReference: string | null = null) => ({
  optionSetReference: id(10),
  versionReference,
});
it("joins real public owner shapes on the original host and rechecks current heads through COMMIT", async () => {
  const f = fixture();
  await f.run((source) =>
    source.withCurrentGraph(request(), async (result) => {
      expect(result.graph.rootVersionReference).toBe(id(110));
      expect(result.graph.contents).toEqual([controls.nodes.get(id(10))?.content.editorContent]);
      expect(result.sourceRecords[0]).toMatchObject({
        optionSetReference: id(10),
        publicationReference: id(910),
        approvalDisposition: "Approved",
      });
      expect(result.graphDigest).toBe(
        evaluateCatalogOptionSetRuleSatisfiability(result.graph).graphDigest,
      );
      expect(result.rules.status).toBe("Satisfiable");
      expect(result.referenceEligibility).toBe("NotEvaluated");
      expect(result.publishValidation).toBe("Incomplete");
      expect(result.validUntil).toBe(until);
      expect(Object.isFrozen(result.graph.contents)).toBe(true);
      return "consumed";
    }),
  );
  expect(f.committed()).toBe(true);
  expect(owner.current).toHaveBeenCalledTimes(2);
  expect(owner.referenced).toHaveBeenCalledTimes(2);
  expect(f.authorize).toHaveBeenCalledWith(["catalog.manage", "catalog.option_set.read"]);
});
it("retains an explicit current child pin including its complete fields", async () => {
  controls.nodes.set(id(10), node(10, 11, 111));
  controls.nodes.set(id(11), node(11));
  const f = fixture();
  await f.run((source) =>
    source.withCurrentGraph(request(id(110)), async (result) => {
      expect(result.graph.contents).toHaveLength(2);
      expect(result.graph.contents[0]?.optionDetails[0]?.triggeredOptionSetVersionReference).toBe(
        id(111),
      );
      expect(result.sourceRecords.map((n) => n.versionReference)).toEqual([id(110), id(111)]);
    }),
  );
  expect(f.committed()).toBe(true);
});
it.each([
  "missingLinkage",
  "wrongContent",
  "crossTransaction",
  "wrongFields",
  "wrongRootPin",
  "oldChildPin",
  "missingChildPin",
])("refuses %s without a committed result", async (failure) => {
  if (failure === "missingLinkage") controls.omittedLinkage = true;
  if (failure === "wrongContent") controls.wrongContent = true;
  if (failure === "crossTransaction") controls.wrongTransaction = true;
  if (failure === "wrongFields") controls.wrongFields = true;
  if (failure === "missingChildPin") controls.missingChildPin = true;
  if (failure === "oldChildPin" || failure === "missingChildPin") {
    controls.nodes.set(id(10), node(10, 11, failure === "oldChildPin" ? 112 : 111));
    controls.nodes.set(id(11), node(11));
  }
  const f = fixture(),
    work = vi.fn(async () => undefined);
  await expect(
    f.run((source) =>
      source.withCurrentGraph(request(failure === "wrongRootPin" ? id(999) : null), work),
    ),
  ).rejects.toBeInstanceOf(CatalogError);
  expect(work).not.toHaveBeenCalled();
  expect(f.committed()).toBe(false);
});
it("reports a known explicit root current-head mismatch as version conflict without consuming content", async () => {
  const f = fixture(),
    work = vi.fn(async () => undefined);
  await expect(
    f.run((source) => source.withCurrentGraph(request(id(999)), work)),
  ).rejects.toMatchObject({ code: "CATALOG_VERSION_CONFLICT" });
  expect(work).not.toHaveBeenCalled();
  expect(owner.release).not.toHaveBeenCalled();
  expect(owner.pinned).not.toHaveBeenCalled();
  expect(f.committed()).toBe(false);
});
it("keeps a contradictory triggered child version unavailable rather than reporting a root conflict", async () => {
  controls.nodes.set(id(10), node(10, 11, 112));
  controls.nodes.set(id(11), node(11));
  const f = fixture(),
    work = vi.fn(async () => undefined);
  await expect(
    f.run((source) => source.withCurrentGraph(request(id(110)), work)),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(work).not.toHaveBeenCalled();
  expect(f.committed()).toBe(false);
});
it("keeps the host poisoned after a consumer swallows the root version conflict", async () => {
  const f = fixture(),
    work = vi.fn(async () => undefined);
  await expect(
    f.run(async (source) => {
      await expect(source.withCurrentGraph(request(id(999)), work)).rejects.toMatchObject({
        code: "CATALOG_VERSION_CONFLICT",
      });
      await expect(source.withCurrentGraph(request(), work)).rejects.toMatchObject({
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      return "swallowed conflict";
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(work).not.toHaveBeenCalled();
  expect(owner.current).toHaveBeenCalledTimes(1);
  expect(f.committed()).toBe(false);
});
it("uses the actual current root when the selector is null", async () => {
  const f = fixture();
  await f.run((source) =>
    source.withCurrentGraph(request(), async (result) => {
      expect(result.graph.rootVersionReference).toBe(id(110));
      expect(result.sourceRecords[0]?.versionReference).toBe(id(110));
    }),
  );
  expect(f.committed()).toBe(true);
});
it("bounds the complete acquisition to 32 nodes without dropping inactive edges", async () => {
  controls.nodes.clear();
  for (let n = 10; n <= 42; n++)
    controls.nodes.set(id(n), node(n, n === 42 ? null : n + 1, n === 42 ? null : n + 101));
  const f = fixture();
  await expect(
    f.run((source) => source.withCurrentGraph(request(), async () => undefined)),
  ).rejects.toBeInstanceOf(CatalogError);
  expect(owner.pinned).toHaveBeenCalledTimes(32);
  expect(f.committed()).toBe(false);
});
it.each(["permission", "deadline", "sourceHead", "queryPort", "authorizationPort"])(
  "refuses late %s after consumption before COMMIT",
  async (failure) => {
    const f = fixture();
    await expect(
      f.run((source) =>
        source.withCurrentGraph(request(), async () => {
          if (failure === "permission") f.deny();
          if (failure === "deadline") f.setTime(until);
          if (failure === "sourceHead") {
            const current = controls.nodes.get(id(10));
            if (!current) throw new Error("missing fixture");
            const { profile, digest, ...fields } = current.linkage;
            void profile;
            void digest;
            const linkage = createCatalogOptionSetReleaseRecord({
              ...fields,
              release: { ...current.linkage.release, releaseId: id(9999) },
            });
            controls.nodes.set(id(10), {
              ...current,
              linkage,
              proof: { ...current.proof, release: linkage.release },
            });
          }
          if (failure === "queryPort")
            Object.defineProperty(f.options().transaction, "query", { value: vi.fn() });
          if (failure === "authorizationPort")
            f.options().currentAuthorization.authorizeActions = async () => undefined;
        }),
      ),
    ).rejects.toBeDefined();
    expect(f.committed()).toBe(false);
  },
);
it("poisons the host if a consumer swallows acquisition failure", async () => {
  controls.omittedLinkage = true;
  const f = fixture();
  await expect(
    f.run(async (source) => {
      await source.withCurrentGraph(request(), async () => undefined).catch(() => undefined);
      return "swallowed";
    }),
  ).rejects.toBeInstanceOf(CatalogError);
  expect(f.committed()).toBe(false);
});
it("refuses reuse of an already consumed source even with the same request", async () => {
  const f = fixture();
  await expect(
    f.run(async (source) => {
      await source.withCurrentGraph(request(), async () => undefined);
      return source.withCurrentGraph(request(), async () => undefined);
    }),
  ).rejects.toBeInstanceOf(CatalogError);
  expect(f.committed()).toBe(false);
});

it("retains a complete cyclic source but reports actual Catalog TriggerCycle without qualification", async () => {
  controls.nodes.set(id(10), node(10, 11, 111));
  controls.nodes.set(id(11), node(11, 10, 110));
  const f = fixture();
  await f.run((source) =>
    source.withCurrentGraph(request(), async (result) => {
      expect(result.graph.contents).toHaveLength(2);
      expect(result.rules).toMatchObject({ status: "Unsatisfiable", reason: "TriggerCycle" });
      expect(result.eligibility).toBe("NotEvaluated");
    }),
  );
  expect(owner.pinned).toHaveBeenCalledTimes(2);
});
it("rejects conflicting explicit versions of an already reached root", async () => {
  controls.nodes.set(id(10), node(10, 11, 111));
  controls.nodes.set(id(11), node(11, 10, 112));
  const f = fixture();
  await expect(
    f.run((source) => source.withCurrentGraph(request(), async () => undefined)),
  ).rejects.toBeInstanceOf(CatalogError);
  expect(f.committed()).toBe(false);
});

// Controlled full public Permission decisions; every callback creates a fresh
// packet. Production owning acquisition is exercised by the separate SQL gate.
function combinedDecisions(actions: readonly string[], invalid = "") {
  const values = actions.map((action) => ({
    effect: "Allow" as const,
    reason: "ROLE_PERMISSION" as const,
    source: "RolePermission" as const,
    action: parseBusinessAction(action),
    scopeKind: "Brand" as const,
    policySnapshotReference: parsePolicyReference(id(80)),
    policyVersion: parsePolicyVersion(1),
    audit: {
      effect: "Allow" as const,
      reason: "ROLE_PERMISSION" as const,
      source: "RolePermission" as const,
    },
  }));
  if (invalid === "pricing-deny") {
    const pricing = values.find((value) => String(value.action) === "pricing.price-book.manage");
    if (pricing) Object.assign(pricing, { effect: "Deny" });
  }
  if (invalid === "count") values.pop();
  if (invalid === "order") values.reverse();
  const first = values[0];
  if (first) {
    if (invalid === "deny") Object.assign(first, { effect: "Deny" });
    if (invalid === "scope") Object.assign(first, { scopeKind: "Store" });
    if (invalid === "audit") Object.assign(first.audit, { reason: "EXPLICIT_ALLOW" });
    if (invalid === "version") Object.assign(first, { policyVersion: 0 });
    if (invalid === "extra") Object.assign(first, { callerPass: true });
    if (invalid === "getter")
      Object.defineProperty(first, "action", {
        enumerable: true,
        get() {
          throw Error("Accessor must never be called");
        },
      });
  }
  if (invalid === "mutable") return values;
  for (const value of values) {
    Object.freeze(value.audit);
    Object.freeze(value);
  }
  return Object.freeze(values);
}

it("uses a fresh combined full permission checkpoint through callback and COMMIT without legacy singleton work", async () => {
  const f = fixture(true);
  await f.run((source) =>
    source.withCurrentGraph(request(), async () => {
      expect(f.combined).toHaveBeenCalled();
      expect(f.legacyCapability).not.toHaveBeenCalled();
      expect(f.authorize).not.toHaveBeenCalled();
    }),
  );
  expect(f.committed()).toBe(true);
  expect(f.combined.mock.calls.length).toBeGreaterThan(1);
  expect(f.legacyCapability).not.toHaveBeenCalled();
  expect(f.authorize).not.toHaveBeenCalled();
  for (const [actions] of f.combined.mock.calls) {
    expect(actions).toContain("catalog.manage");
    expect(actions).toContain("catalog.option_set.read");
    expect(Object.isFrozen(actions)).toBe(true);
  }
});
it.each(["count", "order", "deny", "scope", "audit", "version", "extra", "getter", "mutable"])(
  "refuses malformed combined %s before acquiring owner facts",
  async (invalid) => {
    const f = fixture(true);
    f.invalidCombined(invalid);
    await expect(
      f.run((source) => source.withCurrentGraph(request(), async () => undefined)),
    ).rejects.toBeDefined();
    expect(f.committed()).toBe(false);
    expect(f.legacyCapability).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
  },
);
it.each(["withdrawal", "deny", "expiry", "port"])(
  "rechecks combined %s at final current guards",
  async (change) => {
    const f = fixture(true);
    await expect(
      f.run((source) =>
        source.withCurrentGraph(request(), async () => {
          if (change === "withdrawal") f.deny();
          if (change === "deny") f.invalidCombined("deny");
          if (change === "expiry") f.setTime(until);
          if (change === "port") {
            const options = f.options();
            if (!options) throw Error("Missing captured options");
            options.capability.holdUntilCommitWithDecisions = async (actions) =>
              combinedDecisions(actions);
          }
        }),
      ),
    ).rejects.toBeDefined();
    expect(f.committed()).toBe(false);
  },
);

it.each(["add", "remove"])(
  "rejects optional combined port %s after original capture",
  async (change) => {
    const f = fixture(change === "remove");
    await expect(
      f.run((source) =>
        source.withCurrentGraph(request(), async () => {
          const options = f.options();
          if (!options) throw Error("Missing captured options");
          if (change === "remove")
            Reflect.deleteProperty(options.capability, "holdUntilCommitWithDecisions");
          else
            options.capability.holdUntilCommitWithDecisions = async (actions) =>
              combinedDecisions(actions);
        }),
      ),
    ).rejects.toBeDefined();
    expect(f.committed()).toBe(false);
  },
);

it("exposes finalized graph lease only after the actual outer COMMIT", async () => {
  const f = fixture(true);
  let completed: ReturnType<typeof createCurrentPublishedOptionSetGraphSource> | undefined;
  await f.run(async (source) => {
    completed = source;
    return source.withCurrentGraph(request(), async (view) => view);
  });
  expect(f.committed()).toBe(true);
  expect(completed?.assertFinalized()).toBe(until);
});
it("refuses an unfinalized graph lease inside the borrowed outer transaction", async () => {
  const f = fixture(true);
  await expect(
    f.run(async (source) => {
      await source.withCurrentGraph(request(), async (view) => view);
      source.assertFinalized();
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.committed()).toBe(false);
});
it("a finalized graph lease cannot be renewed after the original deadline", async () => {
  const f = fixture(true);
  let completed: ReturnType<typeof createCurrentPublishedOptionSetGraphSource> | undefined;
  await f.run(async (source) => {
    completed = source;
    return source.withCurrentGraph(request(), async (view) => view);
  });
  f.setTime(until);
  expect(() => completed?.assertFinalized()).toThrow();
});

it("uses the actual Pricing capability guard and full three-action packet on the original graph host", async () => {
  const f = fixture(true, "pricing.price-book.manage", true);
  await f.run((source) => source.withCurrentGraph(request(), async () => undefined));
  expect(f.committed()).toBe(true);
  const graphPackets = f.combined.mock.calls.filter(([actions]) =>
    actions.includes("catalog.option_set.read"),
  );
  expect(graphPackets.length).toBeGreaterThan(1);
  for (const [actions] of graphPackets)
    expect(actions).toEqual([
      "catalog.manage",
      "catalog.option_set.read",
      "pricing.price-book.manage",
    ]);
  expect(
    f.query.mock.calls.some(([sql]) => sql.includes("FROM bop_feature_control.control_version")),
  ).toBe(true);
});
it("does not conceal a genuine Pricing capability mismatch under the default Catalog admission", async () => {
  const f = fixture(true, undefined, true);
  await expect(
    f.run((source) => source.withCurrentGraph(request(), async () => undefined)),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.committed()).toBe(false);
});
it("retains the exact legacy Catalog two-action packet", async () => {
  const f = fixture(true);
  await f.run((source) => source.withCurrentGraph(request(), async () => undefined));
  for (const [actions] of f.combined.mock.calls)
    expect(actions).toEqual(["catalog.manage", "catalog.option_set.read"]);
});
it("legacy Pricing admission still authorizes all three fine actions", async () => {
  const f = fixture(false, "pricing.price-book.manage");
  await f.run((source) => source.withCurrentGraph(request(), async () => undefined));
  expect(f.legacyCapability).toHaveBeenCalled();
  for (const [actions] of f.authorize.mock.calls)
    expect(actions).toEqual([
      "catalog.manage",
      "catalog.option_set.read",
      "pricing.price-book.manage",
    ]);
});
it.each([
  "count",
  "order",
  "deny",
  "scope",
  "audit",
  "version",
  "extra",
  "getter",
  "mutable",
  "pricing-deny",
])("refuses malformed or denied Pricing graph full packet %s", async (invalid) => {
  const f = fixture(true, "pricing.price-book.manage", true);
  f.invalidCombined(invalid);
  await expect(
    f.run((source) => source.withCurrentGraph(request(), async () => undefined)),
  ).rejects.toBeDefined();
  expect(f.committed()).toBe(false);
});
it("refuses late Pricing fine permission withdrawal through the genuine capability guard", async () => {
  const f = fixture(true, "pricing.price-book.manage", true);
  await expect(
    f.run((source) =>
      source.withCurrentGraph(request(), async () => {
        f.invalidCombined("pricing-deny");
      }),
    ),
  ).rejects.toBeDefined();
  expect(f.committed()).toBe(false);
});
it.each(["changed", "added", "removed"])(
  "poisons changed fixed server capability permission %s",
  async (change) => {
    const f = fixture(true, change === "added" ? undefined : "pricing.price-book.manage");
    await expect(
      f.run((source) =>
        source.withCurrentGraph(request(), async () => {
          if (change === "removed")
            Reflect.deleteProperty(f.options(), "capabilityPermissionAction");
          else
            Object.assign(f.options(), {
              capabilityPermissionAction:
                change === "added" ? "pricing.price-book.manage" : "catalog.manage",
            });
        }),
      ),
    ).rejects.toBeDefined();
    expect(f.committed()).toBe(false);
  },
);
it("rejects an unrecognized server capability permission before any graph source acquisition", async () => {
  const f = fixture();
  await expect(
    f.run(async () => {
      const options = f.options();
      Object.assign(options, { capabilityPermissionAction: "catalog.option_set.manage" });
      return createCurrentPublishedOptionSetGraphSource(options);
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.committed()).toBe(false);
});
