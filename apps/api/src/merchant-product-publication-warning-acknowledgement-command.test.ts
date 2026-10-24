import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  productPublicationCheckCodes,
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
  planCatalogProductPublicationV2,
  buildCatalogProductPublicationValidationReport,
  parseCatalogProductPublicationValidationDetails,
  parseCatalogProductPublicationWarningAcknowledgementCommand as parseCommand,
  buildCatalogProductPublicationWarningAcknowledgementObservation as observe,
  buildCatalogProductPublicationWarningAcknowledgementReceipt as acknowledge,
  parseCatalogProductPublicationWarningAcknowledgementObservation as parseObservation,
  productPublicationWarningAcknowledgementFields,
  type ProductPublicationWarningAcknowledgementStoreOptions as StoreOptions,
} from "@rms/catalog";
import {
  createMerchantProductPublicationWarningAcknowledgementCommand,
  type MerchantProductWarningAcknowledgementSourceFactory,
  type MerchantProductWarningAcknowledgementSourceFactoryInput,
} from "./merchant-product-publication-warning-acknowledgement-command.js";
const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  brandFactory: vi.fn(),
  resolve: vi.fn(),
  execute: vi.fn(),
  runtimeAuthority: vi.fn(),
  capability: vi.fn(),
}));
vi.mock("./merchant-product-publication-runtime-authority.js", () => ({
  createMerchantProductPublicationRuntimeAuthority: mocks.runtimeAuthority,
}));
vi.mock("./merchant-product-store-capability.js", () => ({
  createMerchantProductStoreCapabilityGuard: mocks.capability,
}));
vi.mock("./merchant-product-category-assignments.js", () => ({
  createMerchantProductCategoryAssignments: () => ({
    holdUntilTransactionCompletes: async () => undefined,
  }),
}));
vi.mock("@bop/permission", async (original) => ({
  ...(await original<typeof import("@bop/permission")>()),
  createPostgresTransactionCurrentPermissionPolicySource: (tx: unknown) => mocks.permission(tx),
}));
vi.mock("./merchant-brand-scope.js", () => ({
  createMerchantBrandScope: (...args: unknown[]) => {
    mocks.brandFactory(...args);
    return mocks.resolve;
  },
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresProductPublicationWarningAcknowledgementStore: (options: unknown) => ({
    execute: (command: unknown) => mocks.execute(options, command),
  }),
}));
// Controlled writer/current-source doubles isolate the real API and outer UoW.
// Pure command/report/observation/receipt parsing remains real; native tests own SQL evidence.
const id = (n: number) => "01902491-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  until = "2026-10-03T12:00:05.000Z",
  humanAt = "2026-10-03T14:00:00.000Z",
  humanUntil = "2026-10-03T14:00:05.000Z",
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(humanAt) + 1000);
});
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const intent = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    publicationCommand = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(4),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 1,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: hash("content"),
      configurationDigest: hash("configuration"),
      scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC",
      replacementIntent: { ...intent, digest: hash(intent) },
      replacementIntentDigest: hash(intent),
    }),
    validation = parseProductPublicationValidationV2({
      profile: "CatalogProductPublicationValidationV2",
      replacementIntentDigest: publicationCommand.replacementIntentDigest,
      evidenceReference: id(7),
      productAggregateVersion: 1,
      contentDigest: publicationCommand.contentDigest,
      configurationDigest: publicationCommand.configurationDigest,
      scopeDigest: hash(publicationCommand.scopeSet),
      periodDigest: hash(publicationCommand.effectivePeriod),
      policyReference: id(8),
      policyVersion: 1,
      approvalPolicy: "Required",
      checks: productPublicationCheckCodes.map((code) => ({
        code,
        outcome:
          code === "ApprovalPolicy" ? "Pending" : code === "ChangeImpact" ? "Warning" : "Pass",
      })),
      warningAcknowledgement: null,
      checkedAt: at,
      validUntil: until,
    }),
    publication = planCatalogProductPublicationV2(publicationCommand, null, {
      now: at,
      productAggregateVersion: 1,
      contentDigest: publicationCommand.contentDigest,
      configurationDigest: publicationCommand.configurationDigest,
      scopeDigest: validation.scopeDigest,
      periodDigest: validation.periodDigest,
      validation,
      approval: null,
      reviewReference: null,
      replacement: null,
    }),
    details = parseCatalogProductPublicationValidationDetails({
      coverage: "Complete",
      impact: "Recorded",
      findings: [
        {
          checkCode: "ChangeImpact",
          ruleCode: "SKU-008",
          outcome: "Warning",
          subjectReference: id(20),
          reasonCode: "SYNTHETIC_REFERENCE_GAP",
          references: [],
        },
      ],
      sources: [
        {
          sourceCode: "SYNTHETIC_REFERENCE",
          sourceDigest: hash("held source"),
          generation: "1",
          relevantReferenceDigest: hash("relevant refs"),
          observedAt: at,
          validUntil: until,
        },
      ],
    }),
    report = buildCatalogProductPublicationValidationReport({
      command: publicationCommand,
      publication,
      validation,
      details,
      recordedAt: at,
    });
  if (details.coverage !== "Complete") throw new Error("Missing synthetic details");
  const command = parseCommand({
      profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
      action: "AcknowledgeProductPublicationWarnings",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(30),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 7,
      reportOperationReference: report.operationReference,
      reportDigest: report.digest,
      warningBindingDigest: report.warningBindingDigest,
      warningCodes: ["ChangeImpact"],
      reasonCode: "CONFIRMED_REFERENCE_WARNING",
      occurredAt: humanAt,
    }),
    freshValidation = parseProductPublicationValidationV2({
      ...validation,
      productAggregateVersion: 7,
      evidenceReference: id(31),
      checkedAt: humanAt,
      validUntil: humanUntil,
    }),
    freshDetails = {
      ...details,
      sources: details.sources.map((s) => ({
        ...s,
        generation: "99",
        sourceDigest: hash("fresh source at new root"),
        observedAt: "2026-10-03T14:00:00.001Z",
        validUntil: humanUntil,
      })),
    },
    policy = {
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: id(1),
      brandReference: id(2),
      familyReference: id(40),
      policyReference: id(8),
      policyVersion: 1,
      scopeOrder: ["Store", "StoreGroup", "Region", "Channel", "OrderType", "Brand"],
      approvalPolicy: "Required",
      warningOverrideAllowed: true,
      requiredLocales: [],
      mediaRequirement: "Optional",
      effectiveFrom: at,
      effectiveUntil: null,
    },
    observationInput = {
      command,
      binding: report.binding,
      validation: freshValidation,
      details: freshDetails,
      policy,
      observedAt: "2026-10-03T14:00:00.002Z",
      validUntil: humanUntil,
    },
    observation = observe(observationInput),
    receiptInput = { command, report, observation, recordedAt: "2026-10-03T14:00:00.003Z" },
    receipt = acknowledge(receiptInput),
    next = parseProductPublicationCommandV2({
      ...publicationCommand,
      operationReference: id(50),
      expectedProductAggregateVersion: 8,
      expectedPublicationVersion: publication.publicationVersion,
      occurredAt: "2026-10-03T14:00:00.004Z",
    }),
    bindingInput = {
      receipt,
      command: next,
      current: publication,
      validation: { ...freshValidation, productAggregateVersion: 8 },
      details: freshDetails,
      policy,
      now: "2026-10-03T14:00:00.004Z",
    };
  return {
    command,
    publicationCommand,
    publication,
    report,
    validation,
    details,
    observationInput,
    receiptInput,
    receipt,
    bindingInput,
  };
}
type Tx = Parameters<StoreOptions["authority"]["holdUntilTransactionCompletes"]>[0];
const permissions = [
  "catalog.manage",
  "catalog.product.manage",
  "catalog.product.acknowledge-warnings",
  "catalog.product.read",
  "catalog.product.history.read",
] as const;
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
function setup() {
  const f = fixture();
  let clock = "2026-10-03T14:00:00.003Z",
    replay = false,
    workFails = false,
    outerExpiry = false,
    late: () => void = () => undefined;
  const browser = Object.fromEntries(
      Object.entries(f.command).filter(
        ([key]) =>
          ![
            "tenantReference",
            "brandReference",
            "actorReference",
            "actorKind",
            "purposeCode",
          ].includes(key),
      ),
    ),
    authorizeAction = vi.fn(async (action: string) => ({
      action,
      effect: "Allow",
      scopeKind: "Brand",
    })),
    scope = {
      tenantReference: id(1),
      context: { brand: { brandReference: id(2) } },
      selectedStoreReference: id(50),
      actorReference: id(3),
      authorizeAction,
      authorizeActions: async (actions: readonly string[]) =>
        Promise.all(actions.map(authorizeAction)),
      authorizeActionsWithValidity: vi.fn(
        async (
          actions: readonly string[],
        ): Promise<{
          decisions: { action: string; effect: string; scopeKind: string }[];
          validUntil: string | null;
        }> => ({
          decisions: await Promise.all(actions.map(authorizeAction)),
          validUntil: null,
        }),
      ),
    },
    authentication = { authorize: vi.fn(async () => ({ sessionReference: id(51) })) },
    events: string[] = [],
    query = vi.fn(async () => ({ rows: [] })),
    run = vi.fn(async (work: (tx: Tx) => Promise<unknown>) => {
      events.push("BEGIN");
      try {
        const result = await work({ query });
        events.push("COMMIT");
        return result;
      } catch (error) {
        events.push("ROLLBACK");
        throw error;
      }
    }),
    holder = {
      holdUntilTransactionCompletes: vi.fn(async function (this: unknown) {
        expect(this).toBe(holder);
      }),
    },
    screen = vi.fn(async () => undefined),
    sourceSpy = vi.fn(),
    sources: StoreOptions["sources"] = {
      async withHeldCurrentObservation(tx, input, work) {
        sourceSpy(tx, input);
        expect(this).toBe(sources);
        return work(f.receipt.observation);
      },
    },
    options = {
      merchant: { transactions: { run }, now: () => clock } as never,
      authentication: authentication as never,
      authority: holder,
      contentAuthority: holder,
      historyAuthority: holder,
      reportAuthority: holder,
      sources,
      holdScreenUntilCommit: screen,
      auditReference: () => id(52),
    };
  mocks.resolve.mockResolvedValue(scope);
  mocks.execute.mockImplementation(async (store: StoreOptions, parsed: typeof f.command) =>
    store.transactions.run(async (tx) => {
      await store.authority.holdUntilTransactionCompletes(tx, {
        command: parsed,
        mode: replay ? "Replay" : "Acknowledge",
        purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
        permission: "catalog.manage",
        requiredPermissions: permissions,
        requiredScope: "FullBrandScope",
        requiredFields: productPublicationWarningAcknowledgementFields,
        observedAt: store.clock.now(),
      });
      if (!replay) {
        // The owning writer selects aggregate/current/report. Their real SQL
        // binding is outside this transport-isolation double.
        await store.sources.withHeldCurrentObservation(
          tx,
          {
            command: parsed,
            aggregate: {} as never,
            current: f.publication,
            report: f.report,
            observedAt: store.clock.now(),
            validUntil: humanUntil,
          },
          async () => {
            if (workFails) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
            expect(store.audit?.create(f.receipt)).toMatchObject({
              actionCode: "CATALOG_PRODUCT_PUBLICATION_WARNINGS_ACKNOWLEDGED",
              targetId: parsed.productReference,
              actor: { type: "User", reference: id(3) },
              occurredAt: f.receipt.recordedAt,
            });
            events.push("TENTATIVE_ACK");
            return undefined;
          },
        );
      }
      late();
      if (outerExpiry)
        await store.registerBeforeCommit(
          tx,
          async () => {
            events.push("LATER_ASYNC_GUARD");
            clock = humanUntil;
          },
          () => undefined,
        );
      return { status: replay ? "Replayed" : "Applied", receipt: f.receipt };
    }),
  );
  const execute = createMerchantProductPublicationWarningAcknowledgementCommand(options);
  return {
    ...f,
    browser,
    options,
    sources,
    sourceSpy,
    holder,
    screen,
    events,
    run,
    authentication,
    authorizeAction,
    authorizeActionsWithValidity: scope.authorizeActionsWithValidity,
    execute,
    post: (
      command: unknown = browser,
      expectedScope: unknown = { brandReference: id(2), storeReference: id(50) },
    ) => execute({ sessionCookie: "synthetic", csrf: "synthetic", command, expectedScope }),
    expireInLaterGuard: () => {
      outerExpiry = true;
    },
    failWork: () => {
      workFails = true;
    },
    clock: (value: string) => {
      clock = value;
    },
    late: (work: () => void) => {
      late = work;
    },
    replay: () => {
      replay = true;
    },
  };
}
it("derives User context, holds the exact action/screen and returns original root without publication mutation", async () => {
  const f = setup(),
    result = await f.post();
  expect(mocks.execute.mock.calls[0]?.[1]).toEqual(f.command);
  expect(result).toEqual({
    profile: "CatalogProductPublicationWarningAcknowledgementResultV1",
    status: "Applied",
    operationReference: f.command.operationReference,
    productReference: f.command.productReference,
    versionReference: f.command.versionReference,
    aggregateVersion: 7,
    reportOperationReference: f.report.operationReference,
    reportDigest: f.report.digest,
    warningBindingDigest: f.command.warningBindingDigest,
    warningCodes: ["ChangeImpact"],
    reasonCode: f.command.reasonCode,
    occurredAt: humanAt,
    recordedAt: f.receipt.recordedAt,
    receiptDigest: f.receipt.digest,
  });
  expect(f.sourceSpy).toHaveBeenCalledTimes(1);
  expect(f.holder.holdUntilTransactionCompletes).toHaveBeenCalledTimes(2);
  expect(f.screen).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      screenId: "CAT-PRODUCT-EDIT",
      capability: "catalog.cat_product_edit",
      owningAction: "catalog.product.acknowledge-warnings",
      storeReference: id(50),
      actorReference: id(3),
      sessionReference: id(51),
    }),
  );
  expect(f.events).toEqual(["BEGIN", "TENTATIVE_ACK", "COMMIT"]);
});
it("replays the old immutable receipt after its source expiry with current authority and zero observation reads", async () => {
  const f = setup();
  f.replay();
  f.clock("2026-10-04T14:00:00.000Z");
  const result = await f.post();
  expect(result.status).toBe("Replayed");
  expect(result.recordedAt).toBe(f.receipt.recordedAt);
  expect(f.sourceSpy).not.toHaveBeenCalled();
  expect(f.holder.holdUntilTransactionCompletes).toHaveBeenCalledTimes(2);
});
it.each([
  "tenantReference",
  "brandReference",
  "actorReference",
  "actorKind",
  "purposeCode",
  "validation",
  "policy",
  "permission",
])("rejects browser authority %s before authentication", async (key) => {
  const f = setup();
  await expect(f.post({ ...f.browser, [key]: "injected" })).rejects.toHaveProperty(
    "code",
    "CATALOG_INPUT_INVALID",
  );
  expect(f.authentication.authorize).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
});
it.each(["profile", "action", "warningCodes", "reasonCode", "reportDigest"])(
  "rejects invalid explicit consent %s without writer dispatch",
  async (key) => {
    const f = setup();
    await expect(
      f.post({ ...f.browser, [key]: key === "warningCodes" ? [] : "" }),
    ).rejects.toHaveProperty("code", "CATALOG_INPUT_INVALID");
    expect(mocks.execute).not.toHaveBeenCalled();
  },
);
it("captures command descriptors before awaits and rejects getters without executing them", async () => {
  const f = setup(),
    get = vi.fn();
  await expect(
    f.post(Object.defineProperty({ ...f.browser }, "warningCodes", { enumerable: true, get })),
  ).rejects.toHaveProperty("code", "CATALOG_INPUT_INVALID");
  expect(get).not.toHaveBeenCalled();
  const body = { ...f.browser },
    pending = f.post(body);
  body.reasonCode = "OTHER_REASON";
  expect((await pending).reasonCode).toBe(f.command.reasonCode);
});
it("rejects a changed selected Store before writer execution", async () => {
  const f = setup();
  await expect(
    f.post(f.browser, { brandReference: id(2), storeReference: id(99) }),
  ).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  expect(mocks.execute).not.toHaveBeenCalled();
});
it.each(permissions)("rolls back on late %s withdrawal", async (denied) => {
  const f = setup();
  f.late(() =>
    f.authorizeAction.mockImplementation(async (action) => ({
      action,
      effect: action === denied ? "Deny" : "Allow",
      scopeKind: "Brand",
    })),
  );
  await expect(f.post()).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  expect(f.events).toEqual(["BEGIN", "TENTATIVE_ACK", "ROLLBACK"]);
});
it("requires Brand authority and an actually configured Ack producer/screen holder", async () => {
  const f = setup();
  f.authorizeAction.mockImplementation(async (action) => ({
    action,
    effect: "Allow",
    scopeKind: "Store",
  }));
  await expect(f.post()).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  expect(() =>
    createMerchantProductPublicationWarningAcknowledgementCommand({
      ...f.options,
      sources: {} as never,
    }),
  ).toThrow(CatalogError);
  expect(() =>
    createMerchantProductPublicationWarningAcknowledgementCommand({
      ...f.options,
      holdScreenUntilCommit: undefined,
    } as never),
  ).toThrow(CatalogError);
});
it("captures configured holder/source/screen/clock receivers before callers replace ports", async () => {
  const f = setup();
  Object.assign(f.options, {
    authority: {
      holdUntilTransactionCompletes: async () => {
        throw Error("replacement");
      },
    },
    sources: {
      withHeldCurrentObservation: async () => {
        throw Error("replacement");
      },
    },
    holdScreenUntilCommit: async () => {
      throw Error("replacement");
    },
  });
  expect((await f.post()).status).toBe("Applied");
  expect(f.sourceSpy).toHaveBeenCalledTimes(1);
});
it.each([
  "expired",
  "duplicateCaught",
  "swallowedWork",
  "missing",
  "foreignReturn",
  "foreignBinding",
  "late",
])("rejects %s source callback without turning it into consent", async (mode) => {
  const f = setup();
  const source: StoreOptions["sources"] = {
    async withHeldCurrentObservation(_tx, _input, work) {
      if (mode === "missing") return undefined as never;
      let packet = f.receipt.observation;
      if (mode === "expired") f.clock(humanUntil);
      if (mode === "foreignBinding") packet = { ...packet, actorReference: id(99) };
      if (mode === "late") {
        queueMicrotask(() => {
          void work(packet).catch(() => undefined);
        });
        return undefined as never;
      }
      if (mode === "swallowedWork") {
        try {
          await work(packet);
        } catch {
          /* Deliberately broken producer. */
        }
        return undefined as never;
      }
      const result = await work(packet);
      if (mode === "duplicateCaught") {
        try {
          await work(packet);
        } catch {
          /* Must poison original transaction. */
        }
      }
      return mode === "foreignReturn" ? ({} as never) : result;
    },
  };
  const execute = createMerchantProductPublicationWarningAcknowledgementCommand({
    ...f.options,
    sources: source,
  });
  if (mode === "swallowedWork") f.failWork();
  await expect(
    execute({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      command: f.browser,
      expectedScope: { brandReference: id(2), storeReference: id(50) },
    }),
  ).rejects.toThrow();
  expect(f.events.at(-1)).toBe("ROLLBACK");
});
it("keeps the producer's earlier deadline through later outer authority checks", async () => {
  const f = setup(),
    body = { ...f.receipt.observation, validUntil: "2026-10-03T14:00:00.004Z" },
    { digest: discarded, ...withoutDigest } = body;
  void discarded;
  const packet = parseObservation({ ...withoutDigest, digest: hash(withoutDigest) }),
    sources: StoreOptions["sources"] = {
      withHeldCurrentObservation: async (_tx, _input, work) => work(packet),
    },
    execute = createMerchantProductPublicationWarningAcknowledgementCommand({
      ...f.options,
      sources,
    });
  f.late(() => f.clock("2026-10-03T14:00:00.004Z"));
  await expect(
    execute({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      command: f.browser,
      expectedScope: { brandReference: id(2), storeReference: id(50) },
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.events).toEqual(["BEGIN", "TENTATIVE_ACK", "ROLLBACK"]);
});

it("rechecks the original lease synchronously after a later outer async guard", async () => {
  const f = setup();
  f.expireInLaterGuard();
  await expect(f.post()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.events).toEqual(["BEGIN", "TENTATIVE_ACK", "LATER_ASYNC_GUARD", "ROLLBACK"]);
});
it("keeps original replay subject to current acknowledgement permission", async () => {
  const f = setup();
  f.replay();
  f.authorizeAction.mockImplementation(async (action) => ({
    action,
    effect: action === "catalog.product.acknowledge-warnings" ? "Deny" : "Allow",
    scopeKind: "Brand",
  }));
  await expect(f.post()).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  expect(f.sourceSpy).not.toHaveBeenCalled();
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});

function factorySetup() {
  const f = setup(),
    { sources, ...base } = f.options,
    inputs: MerchantProductWarningAcknowledgementSourceFactoryInput[] = [],
    produced = { sources },
    factory: MerchantProductWarningAcknowledgementSourceFactory = (input) => {
      expect(f.events).toEqual(["BEGIN"]);
      expect(f.authentication.authorize).toHaveBeenCalledTimes(1);
      inputs.push(input);
      return produced;
    },
    options = { ...base, sourceFactory: factory },
    execute = createMerchantProductPublicationWarningAcknowledgementCommand(options);
  return {
    ...f,
    inputs,
    produced,
    options,
    postFactory: () =>
      execute({
        sessionCookie: "synthetic",
        csrf: "synthetic",
        command: f.browser,
        expectedScope: { brandReference: id(2), storeReference: id(50) },
      }),
  };
}
it("constructs Ack sources once inside the actual authenticated transaction and captures their ports", async () => {
  const f = factorySetup(),
    original = mocks.execute.getMockImplementation();
  f.options.sourceFactory = () => {
    throw new Error("Replaced Ack factory");
  };
  mocks.execute.mockImplementation(async (store: StoreOptions, command: unknown) => {
    f.produced.sources.withHeldCurrentObservation = async () => {
      throw new Error("Replaced Ack source");
    };
    return original?.(store, command);
  });
  await expect(f.postFactory()).resolves.toMatchObject({ status: "Applied", aggregateVersion: 7 });
  expect(f.inputs).toHaveLength(1);
  const input = f.inputs[0];
  expect(input).toMatchObject({
    command: f.command,
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    storeReference: id(50),
    sessionReference: id(51),
    originalValidUntil: "2026-10-03T14:00:05.003Z",
  });
  expect(Object.isFrozen(input)).toBe(true);
  expect(f.sourceSpy).toHaveBeenCalledTimes(1);
  expect(f.sourceSpy.mock.calls[0]?.[0]).toBe(input?.transaction);
  expect(f.events).toEqual(["BEGIN", "TENTATIVE_ACK", "COMMIT"]);
});
it("factory Ack replay skips every current observation read after the old evidence expires", async () => {
  const f = factorySetup();
  f.replay();
  f.clock("2026-10-04T14:00:00.000Z");
  await expect(f.postFactory()).resolves.toMatchObject({
    status: "Replayed",
    recordedAt: f.receipt.recordedAt,
  });
  expect(f.inputs).toHaveLength(1);
  expect(f.sourceSpy).not.toHaveBeenCalled();
  expect(f.events).toEqual(["BEGIN", "COMMIT"]);
});
it("rejects simultaneous supplied and factory Ack sources before authentication", () => {
  const f = factorySetup();
  expect(() =>
    createMerchantProductPublicationWarningAcknowledgementCommand({
      ...f.options,
      sources: f.sources,
    }),
  ).toThrow(CatalogError);
  expect(f.authentication.authorize).not.toHaveBeenCalled();
  expect(f.inputs).toHaveLength(0);
});
it.each([null, {}, { sources: {} }, { sources: {}, extra: true }])(
  "rejects malformed Ack factory results without writer dispatch: %j",
  async (result) => {
    const f = factorySetup(),
      execute = createMerchantProductPublicationWarningAcknowledgementCommand({
        ...f.options,
        sourceFactory: () => result as never,
      });
    await expect(
      execute({
        sessionCookie: "synthetic",
        csrf: "synthetic",
        command: f.browser,
        expectedScope: { brandReference: id(2), storeReference: id(50) },
      }),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(f.sourceSpy).not.toHaveBeenCalled();
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
  },
);
it("rejects an extra Ack factory result field alongside a valid observation port", async () => {
  const f = factorySetup(),
    execute = createMerchantProductPublicationWarningAcknowledgementCommand({
      ...f.options,
      sourceFactory: () => ({ ...f.produced, extra: true }),
    });
  await expect(
    execute({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      command: f.browser,
      expectedScope: { brandReference: id(2), storeReference: id(50) },
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(mocks.execute).not.toHaveBeenCalled();
});
it("factory Ack source guards keep the shorter original observation lease through the host final phase", async () => {
  const f = factorySetup(),
    original = mocks.execute.getMockImplementation();
  mocks.execute.mockImplementation(async (store: StoreOptions, command: unknown) => {
    const result = await original?.(store, command),
      input = f.inputs[0];
    if (!input) throw Error("Missing actual Ack factory input");
    await input.registerBeforeCommit(
      input.transaction,
      async () => {
        await Promise.resolve();
        f.clock(humanUntil);
      },
      () => {
        input.clock.now();
      },
    );
    return result;
  });
  await expect(f.postFactory()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.events).toEqual(["BEGIN", "TENTATIVE_ACK", "ROLLBACK"]);
});
it("a swallowed factory Ack registration on another transaction cannot commit", async () => {
  const f = factorySetup(),
    original = mocks.execute.getMockImplementation();
  mocks.execute.mockImplementation(async (store: StoreOptions, command: unknown) => {
    const result = await original?.(store, command),
      input = f.inputs[0];
    if (!input) throw Error("Missing actual Ack factory input");
    await input
      .registerBeforeCommit(
        { query: async () => ({ rows: [] }) },
        async () => undefined,
        () => undefined,
      )
      .catch(() => undefined);
    return result;
  });
  await expect(f.postFactory()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.events).toEqual(["BEGIN", "TENTATIVE_ACK", "ROLLBACK"]);
});

it.each([false, true])(
  "retains actual Media access checks and poisons swallowed denial: %s",
  async (swallow) => {
    const f = factorySetup(),
      original = mocks.execute.getMockImplementation();
    let mediaCalls = 0;
    f.authorizeAction.mockImplementation(async (action) => ({
      action,
      effect: action === "media.asset.access" && ++mediaCalls > 1 ? "Deny" : "Allow",
      scopeKind: "Brand",
    }));
    mocks.execute.mockImplementation(async (options: StoreOptions, command: unknown) => {
      const input = f.inputs[0];
      if (!input) throw new Error("Missing actual factory input");
      await input.authorizeMediaAccess();
      const result = await original?.(options, command);
      await input.registerBeforeCommit(
        input.transaction,
        async () => {
          const pending = input.authorizeMediaAccess();
          if (swallow) await pending.catch(() => undefined);
          else await pending;
        },
        () => {
          input.clock.now();
        },
      );
      return result;
    });
    await expect(f.postFactory()).rejects.toBeInstanceOf(CatalogError);
    expect(mediaCalls).toBe(2);
    expect(f.events.at(-1)).toBe("ROLLBACK");
    expect(f.events).not.toContain("COMMIT");
  },
);

it.each([false, true])(
  "retains real current authorization and poisons a caught late field permission denial: %s",
  async (swallow) => {
    const f = factorySetup(),
      original = mocks.execute.getMockImplementation();
    let calls = 0;
    f.authorizeAction.mockImplementation(async (action) => ({
      action,
      effect: action === "pricing.price-book.manage" && ++calls > 1 ? "Deny" : "Allow",
      scopeKind: "Brand",
    }));
    mocks.execute.mockImplementation(async (options: StoreOptions, command: unknown) => {
      const input = f.inputs[0];
      if (!input?.currentAuthorization)
        throw new Error("Missing real current authorization bridge");
      await input.currentAuthorization.authorizeActions(["pricing.price-book.manage"]);
      const result = await original?.(options, command);
      await input.registerBeforeCommit(
        input.transaction,
        async () => {
          const pending = input.currentAuthorization?.authorizeActions([
            "pricing.price-book.manage",
          ]);
          if (swallow) await pending?.catch(() => undefined);
          else await pending;
        },
        () => {
          input.clock.now();
        },
      );
      return result;
    });
    await expect(f.postFactory()).rejects.toBeInstanceOf(CatalogError);
    expect(calls).toBe(2);
    expect(f.events.at(-1)).toBe("ROLLBACK");
    expect(f.events).not.toContain("COMMIT");
  },
);

it.each([false, true])(
  "holds concrete Ack authority and Product Screen on original replay: %s",
  async (replay) => {
    const f = factorySetup(),
      {
        authority: _a,
        contentAuthority: _c,
        historyAuthority: _h,
        reportAuthority: _r,
        holdScreenUntilCommit: _s,
        ...base
      } = f.options;
    void _a;
    void _c;
    void _h;
    void _r;
    void _s;
    if (replay) f.replay();
    const holdUntilCommit = vi.fn(async () => undefined);
    mocks.runtimeAuthority.mockReturnValue({
      acknowledgementAuthority: f.holder,
      acknowledgementContentAuthority: f.holder,
      acknowledgementHistoryAuthority: f.holder,
      acknowledgementReportAuthority: f.holder,
    });
    mocks.permission.mockReturnValue(
      Object.freeze({
        authorize: vi.fn(),
        authorizeWithRoles: vi.fn(),
        authorizeActionsWithRoles: vi.fn(),
      }),
    );
    const capability = { holdUntilCommit };
    mocks.capability.mockReturnValue(capability);
    const run = createMerchantProductPublicationWarningAcknowledgementCommand({
      ...base,
      currentRuntime: true,
    });
    await expect(
      run({
        sessionCookie: "synthetic",
        csrf: "synthetic",
        command: f.browser,
        expectedScope: { brandReference: id(2), storeReference: id(50) },
      }),
    ).resolves.toMatchObject({ status: replay ? "Replayed" : "Applied" });
    expect(mocks.runtimeAuthority).toHaveBeenCalledExactlyOnceWith(f.inputs[0]);
    expect(mocks.capability).toHaveBeenCalledTimes(1);
    expect(mocks.permission).toHaveBeenCalledTimes(1);
    const actualPolicy = mocks.permission.mock.results[0]?.value;
    const actualHost = f.inputs[0];
    if (!actualHost) throw Error("actual source host was not captured");
    expect(actualHost.capability).toBe(capability);
    expect(mocks.permission).toHaveBeenCalledWith(actualHost.transaction);
    expect(mocks.brandFactory).toHaveBeenCalledWith(expect.anything(), actualPolicy);
    expect(mocks.capability).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction: actualHost.transaction,
        currentAuthorization: actualHost.currentAuthorization,
        clock: actualHost.clock,
        sessionReference: actualHost.sessionReference,
        originalValidUntil: actualHost.originalValidUntil,
        registerBeforeCommit: actualHost.registerBeforeCommit,
      }),
    );
    expect(mocks.capability.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runtimeAuthority.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(holdUntilCommit).toHaveBeenCalledTimes(4);
    expect(f.screen).not.toHaveBeenCalled();
    expect(f.authorizeActionsWithValidity.mock.calls).toEqual(
      Array.from({ length: 4 }, () => [[...permissions]]),
    );
  },
);
it.each([
  "authority",
  "contentAuthority",
  "historyAuthority",
  "reportAuthority",
  "holdScreenUntilCommit",
])("refuses concrete Ack runtime mixed with injected %s", (field) => {
  const f = factorySetup(),
    {
      authority: _a,
      contentAuthority: _c,
      historyAuthority: _h,
      reportAuthority: _r,
      holdScreenUntilCommit: _s,
      ...base
    } = f.options;
  void _a;
  void _c;
  void _h;
  void _r;
  void _s;
  expect(() =>
    createMerchantProductPublicationWarningAcknowledgementCommand({
      ...base,
      currentRuntime: true,
      [field]: {},
    }),
  ).toThrow(expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }));
});

function runtimeFactorySetup() {
  const f = factorySetup(),
    {
      authority: a,
      contentAuthority: c,
      historyAuthority: h,
      reportAuthority: r,
      holdScreenUntilCommit: s,
      ...base
    } = f.options;
  void a;
  void c;
  void h;
  void r;
  void s;
  mocks.runtimeAuthority.mockReturnValue({
    acknowledgementAuthority: f.holder,
    acknowledgementContentAuthority: f.holder,
    acknowledgementHistoryAuthority: f.holder,
    acknowledgementReportAuthority: f.holder,
  });
  mocks.capability.mockReturnValue({ holdUntilCommit: vi.fn(async () => undefined) });
  const execute = createMerchantProductPublicationWarningAcknowledgementCommand({
    ...base,
    currentRuntime: true,
  });
  return {
    ...f,
    postRuntime: () =>
      execute({
        sessionCookie: "synthetic",
        csrf: "synthetic",
        command: f.browser,
        expectedScope: { brandReference: id(2), storeReference: id(50) },
      }),
  };
}
it.each(["admission", "media"])(
  "retains the runtime Ack %s grant boundary through later null boundaries and all async guards",
  async (target) => {
    const f = runtimeFactorySetup(),
      original = mocks.execute.getMockImplementation(),
      boundary = "2026-10-03T14:00:02.000Z";
    let retained = false;
    f.authorizeActionsWithValidity.mockImplementation(async (actions) => {
      const matches =
          target === "media"
            ? actions.includes("media.asset.access")
            : actions.includes("catalog.manage"),
        validUntil = matches && !retained ? boundary : null;
      if (matches) retained = true;
      return { decisions: await Promise.all(actions.map(f.authorizeAction)), validUntil };
    });
    mocks.execute.mockImplementation(async (store: StoreOptions, command: unknown) => {
      const input = f.inputs[0];
      if (!input || !original) throw new Error("Missing controlled runtime host");
      if (target === "media") await input.authorizeMediaAccess();
      const result = await original(store, command);
      await input.registerBeforeCommit(
        input.transaction,
        async () => {
          f.clock(boundary);
        },
        () => undefined,
      );
      return result;
    });
    await expect(f.postRuntime()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    expect(
      f.authorizeActionsWithValidity.mock.calls.filter(([actions]) =>
        actions.includes("catalog.manage"),
      ),
    ).toHaveLength(4);
    if (target === "media")
      expect(f.authorizeActionsWithValidity).toHaveBeenCalledWith(["media.asset.access"]);
    expect(f.events).toEqual(["BEGIN", "TENTATIVE_ACK", "ROLLBACK"]);
  },
);
it.each(["denied", "wrong scope"])(
  "refuses runtime Ack admission %s at the later checkpoint",
  async (kind) => {
    const f = runtimeFactorySetup();
    let calls = 0;
    f.authorizeActionsWithValidity.mockImplementation(async (actions) => {
      const late = ++calls === 3;
      return {
        decisions: (await Promise.all(actions.map(f.authorizeAction))).map((decision, index) =>
          late && index === 0
            ? { ...decision, ...(kind === "denied" ? { effect: "Deny" } : { scopeKind: "Store" }) }
            : decision,
        ),
        validUntil: null,
      };
    });
    await expect(f.postRuntime()).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
    expect(f.authorizeActionsWithValidity).toHaveBeenCalledTimes(3);
    expect(f.events).toEqual(["BEGIN", "TENTATIVE_ACK", "ROLLBACK"]);
  },
);
it("poisons the runtime Ack transaction when a late Media denial is caught", async () => {
  const f = runtimeFactorySetup(),
    original = mocks.execute.getMockImplementation();
  let mediaCalls = 0;
  f.authorizeActionsWithValidity.mockImplementation(async (actions) => ({
    decisions: (await Promise.all(actions.map(f.authorizeAction))).map((decision) =>
      decision.action === "media.asset.access" && ++mediaCalls > 1
        ? { ...decision, effect: "Deny" }
        : decision,
    ),
    validUntil: null,
  }));
  mocks.execute.mockImplementation(async (store: StoreOptions, command: unknown) => {
    const input = f.inputs[0];
    if (!input || !original) throw new Error("Missing controlled runtime host");
    await input.authorizeMediaAccess();
    const result = await original(store, command);
    await input.registerBeforeCommit(
      input.transaction,
      async () => {
        await input.authorizeMediaAccess().catch(() => undefined);
      },
      () => undefined,
    );
    return result;
  });
  await expect(f.postRuntime()).rejects.toBeInstanceOf(CatalogError);
  expect(mediaCalls).toBe(2);
  expect(f.events).toEqual(["BEGIN", "TENTATIVE_ACK", "ROLLBACK"]);
});
it("preserves legacy Ack decision-only admission and Media authorization", async () => {
  const f = factorySetup(),
    original = mocks.execute.getMockImplementation();
  mocks.execute.mockImplementation(async (store: StoreOptions, command: unknown) => {
    const input = f.inputs[0];
    if (!input || !original) throw new Error("Missing controlled runtime host");
    await input.authorizeMediaAccess();
    return original(store, command);
  });
  await expect(f.postFactory()).resolves.toMatchObject({ status: "Applied" });
  expect(f.authorizeActionsWithValidity).not.toHaveBeenCalled();
  expect(f.authorizeAction).toHaveBeenCalledWith("media.asset.access");
  expect(f.screen).toHaveBeenCalledTimes(4);
});

it("preserves the legacy acknowledgement permission path without constructing a transaction owner", async () => {
  const f = factorySetup();
  await f.postFactory();
  expect(mocks.permission).not.toHaveBeenCalled();
  for (const args of mocks.brandFactory.mock.calls) expect(args).toHaveLength(1);
});
