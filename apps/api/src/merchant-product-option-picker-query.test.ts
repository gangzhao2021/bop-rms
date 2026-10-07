import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  materializeFullOptionSetCreation,
  parseCatalogOptionSetEditorContent,
  createCatalogFullOptionSetPublicationMaterialization,
  frozenFullOptionSetContentFields,
  type createPostgresFrozenFullOptionSetContentStore,
} from "@rms/catalog";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
import { createMerchantProductOptionPickerQuery as create } from "./merchant-product-option-picker-query.js";
import type { createCurrentPublishedOptionSetGraphSource } from "./current-published-option-set-graph.js";
const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  current: vi.fn(),
  capability: vi.fn(),
  frozen: vi.fn(),
  graph: vi.fn(),
}));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => mocks.scope }));
vi.mock("./merchant-product-current-authorization.js", () => ({
  createMerchantProductCurrentAuthorization: (o: unknown) => mocks.current(o),
}));
vi.mock("./merchant-product-store-capability.js", () => ({
  createMerchantProductStoreCapabilityGuard: (o: unknown) => mocks.capability(o),
}));
vi.mock("./current-published-option-set-graph.js", () => ({
  createCurrentPublishedOptionSetGraphSource: (o: unknown) => mocks.graph(o),
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresFrozenFullOptionSetContentStore: (o: unknown) => mocks.frozen(o),
}));
beforeEach(() => vi.clearAllMocks());
const id = (n: number) => "01902421-7900-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z",
  digest = "sha256:" + "a".repeat(64);
const plus = (n: number) => new Date(Date.parse(at) + n).toISOString();
type FrozenOptions = Parameters<typeof createPostgresFrozenFullOptionSetContentStore>[0];
type GraphOptions = Parameters<typeof createCurrentPublishedOptionSetGraphSource>[0];
function full(archived = false) {
  return materializeFullOptionSetCreation(
    {
      internalCode: "SYNTH_PICKER",
      operationReference: id(7),
      occurredAt: at,
      reasonCode: "AUTHORIZED_OPERATION",
      draft: {
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic picker choices" },
        localizedDescriptions: { "en-CA": "PRIVATE_FULL_DESCRIPTION" },
        displayStyle: "MultiChoice",
        minimumSelection: 0,
        maximumSelection: 1,
        allowRepeatedOption: false,
        perOptionMaximumQuantity: 1,
        maximumTotalQuantity: 1,
        options: [
          {
            stableCode: "CHOICE",
            lifecycle: archived ? "Archived" : "Draft",
            localizedNames: { "en-CA": "Synthetic choice" },
            localizedDescriptions: {},
            sortOrder: 0,
            defaultEligible: !archived,
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
    },
    {
      brandReference: id(2),
      actorReference: id(4),
      allocations: {
        optionSetReference: id(6),
        versionReference: id(8),
        options: [{ stableCode: "CHOICE", optionReference: id(9) }],
      },
    },
  ).content;
}
function frozenContent() {
  const content = full(),
    { sourceAggregate, ...additional } = content,
    parsed = parseCatalogOptionSetEditorContent(sourceAggregate, additional);
  return createCatalogFullOptionSetPublicationMaterialization(sourceAggregate, additional, {
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: id(6),
    versionReference: id(8),
    sourceAggregateVersion: 1,
    publicationOperationReference: id(10),
    publicationIntentDigest: digest,
    successorDraftVersionReference: id(11),
    sealedAt: at,
    sourceDigest: parsed.sourceDigest,
    contentDigest: parsed.contentDigest,
    configurationDigest: parsed.configurationDigest,
  }).content;
}
// Controlled public owner ports exercise the genuine borrowed transaction host.
// These unit fixtures are not native IAM, persistence or publication evidence.
function fixture(pin: string | null = null) {
  const state = {
    now: at,
    lease: until,
    allowed: true,
    feature: false,
    committed: false,
    commitFails: false,
    foreign: false,
    sourceUntil: until,
    scopeForeign: false,
    reenter: false,
    finalLease: until,
    archived: false,
  };
  const tx = { query: vi.fn(async () => ({ rows: [] })) };
  const authentication = { authorize: vi.fn(async () => ({ sessionReference: id(5) })) };
  const current = {
    assertCurrent: vi.fn(() => {
      if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return state.now;
    }),
    leaseDeadline: vi.fn(() => state.lease),
    authorizeActions: vi.fn(async () => undefined),
  };
  const capability = {
    leaseDeadline: vi.fn(() => state.lease),
    holdUntilCommit: vi.fn(async () => undefined),
    holdUntilCommitWithDecisions: vi.fn(async (actions: readonly string[]) => {
      if (state.feature) throw new MerchantProductWriteFeatureDisabled();
      if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return Object.freeze(
        actions.map((action) =>
          Object.freeze({
            action,
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            scopeKind: "Brand",
            policySnapshotReference: id(15),
            policyVersion: 1 as const,
            audit: Object.freeze({
              effect: "Allow",
              reason: "ROLE_PERMISSION",
              source: "RolePermission",
            }),
          }),
        ),
      );
    }),
  };
  mocks.current.mockReturnValue(current);
  mocks.capability.mockReturnValue(capability);
  mocks.scope.mockImplementation(async () => ({
    tenantReference: id(1),
    actorReference: id(4),
    selectedStoreReference: id(3),
    context: { brand: { brandReference: state.scopeForeign ? id(99) : id(2) } },
  }));
  let captured: GraphOptions | undefined;
  mocks.graph.mockImplementation((o: GraphOptions) => {
    captured = o;
    let final = false;
    return {
      assertFinalized: () => {
        if (!final) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        return state.finalLease;
      },
      async withCurrentGraph(command: unknown, work: (packet: unknown) => Promise<unknown>) {
        expect(command).toEqual({ optionSetReference: id(6), versionReference: null });
        await o.registerBeforeCommit(
          o.transaction,
          async () => {
            o.currentAuthorization.assertCurrent();
          },
          () => {
            final = true;
          },
        );
        const packet = {
          profile: "CurrentPublishedOptionSetGraphV1",
          graph: {
            brandReference: id(2),
            rootOptionSetReference: id(6),
            rootVersionReference: state.foreign ? id(99) : id(8),
            contents: [full(state.archived)],
          },
          sourceRecords: [
            {
              optionSetReference: id(6),
              versionReference: id(8),
              publicationReference: id(12),
              sealRecordDigest: digest,
              releaseRecordDigest: digest,
              approvalDisposition: "Approved",
            },
          ],
          graphDigest: digest,
          rules: { status: "Satisfiable", reason: null, searchNodes: 1 },
          originalObservedAt: at,
          observedAt: at,
          validUntil: state.sourceUntil,
          sourceAuthority: "CurrentPublishingReleaseAndFrozenContent",
          referenceEligibility: "NotEvaluated",
          eligibility: "NotEvaluated",
          publishValidation: "Incomplete",
        };
        const value = await work(packet);
        if (state.reenter) await work(packet);
        return value;
      },
    };
  });
  mocks.frozen.mockImplementation((o: FrozenOptions) => ({
    async readPinned(command: unknown) {
      expect(command).toEqual({
        optionSetReference: id(6),
        versionReference: pin,
        expectedRecordDigest: null,
      });
      return o.transactions.run(async (actual) => {
        const input = {
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(4),
          actorKind: "User" as const,
          permission: "catalog.manage" as const,
          action: "catalog.option_set.read" as const,
          purposeCode: "CATALOG_OPTION_SET_FROZEN_CONTENT" as const,
          requiredFields: frozenFullOptionSetContentFields,
          optionSetReference: id(6),
          versionReference: state.foreign ? id(99) : id(8),
          content: null,
          observedAt: at,
        };
        await o.authority.holdUntilTransactionCompletes(actual, input);
        const content = frozenContent();
        await o.authority.holdUntilTransactionCompletes(actual, { ...input, content });
        return {
          content,
          observedAt: at,
          validUntil: state.sourceUntil,
          eligibility: "NotEvaluated",
        };
      });
    },
  }));
  const merchant = {
    now: () => state.now,
    transactions: {
      async run<T>(work: (actual: typeof tx) => Promise<T>) {
        const result = await work(tx);
        if (state.commitFails) throw new Error("Synthetic commit failed");
        state.committed = true;
        return result;
      },
    },
  };
  const options = {
    merchant: merchant as unknown as Parameters<typeof create>[0]["merchant"],
    authentication: authentication as unknown as Parameters<typeof create>[0]["authentication"],
  };
  const request = {
    sessionCookie: "synthetic-session",
    csrf: "synthetic-csrf",
    expectedScope: { brandReference: id(2), storeReference: id(3) },
    command: { optionSetReference: id(6), versionReference: pin },
  };
  return {
    state,
    options,
    request,
    current,
    capability,
    authentication,
    tx,
    graphOptions: () => captured,
    execute: () => create(options)(request),
  };
}
it("CurrentPublished returns an authorized minimal selected projection only after COMMIT", async () => {
  const f = fixture(),
    view = await f.execute();
  expect(f.state.committed).toBe(true);
  expect(view).toMatchObject({
    profile: "CatalogProductOptionBindingPickerV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    versionReference: id(8),
    sourceAuthority: "CurrentPublishingReleaseAndFrozenContent",
    publicationReference: id(12),
    originalRecordDigest: digest,
    referenceEligibility: "NotEvaluated",
    publishValidation: "Incomplete",
    rootSelectionRule: { minimumSelection: 0, maximumSelection: 1 },
    options: [
      {
        optionReference: id(9),
        quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
        selectionDisabled: false,
      },
    ],
  });
  expect(view.bindingReference).toMatch(/^[0-9a-f-]{14}7[0-9a-f-]{21}$/u);
  expect(JSON.stringify(view)).not.toContain("PRIVATE_FULL_DESCRIPTION");
  expect(view).not.toHaveProperty("content");
  expect(view).not.toHaveProperty("sourceRecords");
  expect(view).not.toHaveProperty("proof");
  expect(mocks.frozen).not.toHaveBeenCalled();
  expect(mocks.current.mock.calls[0]?.[0]).toMatchObject({
    capabilityKey: "catalog.cat_product_edit",
  });
});
it("explicit version reads exact actual Frozen without current Published or history permissions", async () => {
  const f = fixture(id(8)),
    view = await f.execute();
  expect(view.versionReference).toBe(id(8));
  expect(view.sourceAuthority).toBe("RecordedFrozen");
  expect(view.publicationReference).toBeNull();
  expect(view.originalRecordDigest).toBe(frozenContent().digest);
  expect(mocks.graph).not.toHaveBeenCalled();
  expect(f.capability.holdUntilCommitWithDecisions).toHaveBeenCalledWith([
    "catalog.manage",
    "catalog.option_set.read",
  ]);
});
it.each([null, id(8)])(
  "fine denial for %s cannot become absent or disabled-success",
  async (pin) => {
    const f = fixture(pin);
    f.state.allowed = false;
    await expect(f.execute()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(f.state.committed).toBe(false);
  },
);
it("actual disabled feature keeps its finite typed error without exposing private source errors", async () => {
  const f = fixture();
  f.state.feature = true;
  await expect(f.execute()).rejects.toBeInstanceOf(MerchantProductWriteFeatureDisabled);
});
it.each([null, id(8)])(
  "foreign actual version for %s refuses rather than upgrading",
  async (pin) => {
    const f = fixture(pin);
    f.state.foreign = true;
    await expect(f.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(f.state.committed).toBe(false);
  },
);
it("cross Brand selection refuses before any source read", async () => {
  const f = fixture();
  f.state.scopeForeign = true;
  await expect(f.execute()).rejects.toBeInstanceOf(CatalogError);
  expect(mocks.graph).not.toHaveBeenCalled();
});
it.each([null, id(8)])(
  "expired/renewed source window for %s cannot extend original 5s",
  async (pin) => {
    const f = fixture(pin);
    f.state.sourceUntil = plus(5001);
    await expect(f.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
it("actual graph final shortened lease is projected after all owner final guards", async () => {
  const f = fixture();
  f.state.finalLease = plus(2000);
  expect((await f.execute()).validUntil).toBe(plus(2000));
});
it("real COMMIT failure exposes no tentative projection", async () => {
  const f = fixture();
  f.state.commitFails = true;
  await expect(f.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.state.committed).toBe(false);
});
it("duplicate actual source callback poisons the original request", async () => {
  const f = fixture();
  f.state.reenter = true;
  await expect(f.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it.each([
  { optionSetReference: id(6), versionReference: null, proof: {} },
  { optionSetReference: id(6) },
  { optionSetReference: id(6), versionReference: "invalid" },
])("closed invalid browser selector refuses before authentication", async (command) => {
  const f = fixture();
  await expect(create(f.options)({ ...f.request, command })).rejects.toMatchObject({
    code: "CATALOG_INPUT_INVALID",
  });
  expect(f.authentication.authorize).not.toHaveBeenCalled();
});
it("descriptor-safe browser selector rejects accessors without invoking them", async () => {
  const f = fixture(),
    getter = vi.fn(() => id(6)),
    command = { ...f.request.command };
  Object.defineProperty(command, "optionSetReference", { enumerable: true, get: getter });
  await expect(create(f.options)({ ...f.request, command })).rejects.toMatchObject({
    code: "CATALOG_INPUT_INVALID",
  });
  expect(getter).not.toHaveBeenCalled();
});
it("final fine withdrawal and natural expiry rollback rather than returning cached permission", async () => {
  const f = fixture();
  f.capability.holdUntilCommitWithDecisions
    .mockImplementationOnce(async (actions) =>
      Object.freeze(
        actions.map((action) =>
          Object.freeze({
            action,
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            scopeKind: "Brand",
            policySnapshotReference: id(15),
            policyVersion: 1 as const,
            audit: Object.freeze({
              effect: "Allow",
              reason: "ROLE_PERMISSION",
              source: "RolePermission",
            }),
          }),
        ),
      ),
    )
    .mockImplementation(async () => {
      throw new CatalogError("CATALOG_PERMISSION_DENIED");
    });
  await expect(f.execute()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(f.state.committed).toBe(false);
  const g = fixture();
  g.state.lease = at;
  await expect(g.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});

it("actual Archived Option is visible with an explicit selection refusal without invented eligibility", async () => {
  const f = fixture();
  f.state.archived = true;
  const view = await f.execute();
  expect(view.options[0]).toMatchObject({
    lifecycle: "Archived",
    selectionDisabled: true,
    disabledReason: "OptionArchived",
    defaultEligible: false,
  });
  expect(view.referenceEligibility).toBe("NotEvaluated");
});
it("missing current Published source stays unavailable, never an empty/disabled success", async () => {
  const f = fixture();
  mocks.graph.mockReturnValue({
    assertFinalized: () => until,
    withCurrentGraph: async () => {
      throw new CatalogError("CATALOG_UNAVAILABLE");
    },
  });
  await expect(f.execute()).rejects.toMatchObject({ code: "CATALOG_UNAVAILABLE" });
  expect(f.state.committed).toBe(false);
});
it("unknown source failure is sanitized without the private error body", async () => {
  const f = fixture();
  mocks.graph.mockReturnValue({
    assertFinalized: () => until,
    withCurrentGraph: async () => {
      throw new Error("SYNTH_PRIVATE_SOURCE_BODY");
    },
  });
  try {
    await f.execute();
    throw new Error("must refuse");
  } catch (error) {
    expect(error).toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(String(error)).not.toContain("SYNTH_PRIVATE_SOURCE_BODY");
  }
});
it("malformed full current permission evidence cannot authorize a selected projection", async () => {
  const f = fixture();
  f.capability.holdUntilCommitWithDecisions.mockImplementation(async (actions) =>
    Object.freeze(
      actions.map((action) => {
        const evidence = {
          action,
          effect: "Allow" as const,
          reason: "ROLE_PERMISSION" as const,
          source: "RolePermission" as const,
          scopeKind: "Brand" as const,
          policySnapshotReference: id(15),
          policyVersion: 1 as const,
          audit: Object.freeze({
            effect: "Allow" as const,
            reason: "ROLE_PERMISSION" as const,
            source: "RolePermission" as const,
          }),
        };
        Object.defineProperty(evidence, "scopeKind", { enumerable: true, value: "Store" });
        return Object.freeze(evidence);
      }),
    ),
  );
  await expect(f.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(mocks.graph).not.toHaveBeenCalled();
});
