import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  productPublicationWriteFieldsV2,
  productPublicationCheckCodes,
  type ProductPublicationStoreOptionsV2,
} from "@rms/catalog";
import {
  createMerchantProductPublicationCommandV2,
  type MerchantProductPublicationSourceFactoryV2,
  type MerchantProductPublicationSourceFactoryV2Input,
} from "./merchant-product-publication-command-v2.js";

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
  createPostgresProductPublicationStoreV2: (options: unknown) => ({
    execute: (command: unknown) => mocks.execute(options, command),
  }),
}));
const id = (n: number) => `01902452-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-02T12:00:00.000Z";
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const body = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
const replacementIntent = { ...body, digest: hash(body) };
const command = {
  profile: "CatalogProductPublicationCommandV2",
  replacementIntent,
  replacementIntentDigest: replacementIntent.digest,
  operationReference: id(1),
  productReference: id(2),
  versionReference: id(3),
  expectedProductAggregateVersion: 1,
  expectedPublicationVersion: 0,
  action: "Validate",
  contentDigest: "sha256:" + "a".repeat(64),
  configurationDigest: "sha256:" + "b".repeat(64),
  scopeSet: [
    { level: "Store", reference: id(6), channelCodes: ["WEB"], orderTypeCodes: ["PICKUP"] },
  ],
  effectivePeriod: {
    timeZone: "UTC",
    effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
    effectiveUntil: null,
  },
  scheduleReference: null,
  replacementVersionReference: null,
  successorDraftVersionReference: null,
  occurredAt: at,
  reasonCode: "SYNTHETIC_V2",
};
type Tx = Parameters<
  ProductPublicationStoreOptionsV2["authority"]["holdUntilTransactionCompletes"]
>[0];
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
  let clock = at,
    late: () => void = () => undefined,
    status: "Applied" | "Replayed" = "Applied";
  const authorizeAction = vi.fn(async (action: string) => ({
    action,
    effect: "Allow",
    scopeKind: "Brand",
  }));
  const scope = {
    tenantReference: id(4),
    context: { brand: { brandReference: id(5) } },
    selectedStoreReference: id(6),
    actorReference: id(7),
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
  };
  mocks.resolve.mockResolvedValue(scope);
  const authorize = vi.fn(async () => ({ sessionReference: id(8) }));
  const query = vi.fn(async () => ({ rows: [] }));
  const events: string[] = [];
  const run = vi.fn(async (work: (tx: Tx) => Promise<unknown>) => {
    events.push("BEGIN");
    try {
      const result = await work({ query });
      events.push("COMMIT");
      return result;
    } catch (error) {
      events.push("ROLLBACK");
      throw error;
    }
  });
  const holder = {
    holdUntilTransactionCompletes: vi.fn(async function (this: unknown) {
      expect(this).toBe(holder);
    }),
  };
  const sources = { withHeldCurrentFacts: vi.fn(), withCurrentPolicy: vi.fn() };
  const options = {
    merchant: { transactions: { run }, now: () => clock } as never,
    authentication: { authorize } as never,
    maximumApprovalValiditySeconds: 300,
    auditReference: () => id(9),
    authority: holder,
    sources: sources as never,
  };
  mocks.execute.mockImplementation(
    async (value: ProductPublicationStoreOptionsV2, parsed: typeof command) => {
      return value.transactions.run(async (tx) => {
        await value.authority.holdUntilTransactionCompletes(tx, {
          command: parsed as never,
          requiredPermissions: [
            "catalog.manage",
            "catalog.product.read",
            "catalog.product.validate",
          ],
          requiredFields: productPublicationWriteFieldsV2,
          requiredScope: "FullBrandScope",
          observedAt: value.clock.now(),
        });
        late();
        // The owning writer is isolated here to test the actual admission UoW;
        // native acceptance owns persisted approval/publication/replay evidence.
        return {
          status,
          aggregate: { aggregateVersion: 2 },
          publication: {
            publicationVersion: 1,
            state: "Draft",
            scheduleVersion: 0,
            effectivePeriod: parsed.effectivePeriod,
            successorDraftVersionReference: null,
          },
        };
      });
    },
  );
  const execute = createMerchantProductPublicationCommandV2(options);
  return {
    options,
    run,
    events,
    authorize,
    holder,
    sources,
    authorizeAction,
    authorizeActionsWithValidity: scope.authorizeActionsWithValidity,
    execute,
    post: (
      value: unknown = command,
      expectedScope: unknown = { brandReference: id(5), storeReference: id(6) },
    ) => execute({ sessionCookie: "synthetic", csrf: "synthetic", command: value, expectedScope }),
    clock: (value: string) => {
      clock = value;
    },
    late: (work: () => void) => {
      late = work;
    },
    replay: () => {
      status = "Replayed";
    },
  };
}
it("derives server context, sends full V2 intent and rechecks owning authority before outer commit", async () => {
  const f = setup(),
    result = await f.post();
  expect(result).toMatchObject({
    profile: "CatalogProductPublicationCommandResultV2",
    replacementIntentDigest: replacementIntent.digest,
    status: "Applied",
    operationReference: id(1),
    aggregateVersion: 2,
  });
  expect(mocks.execute.mock.calls[0]?.[1]).toEqual({
    ...command,
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(4),
    brandReference: id(5),
    actorReference: id(7),
    actorKind: "User",
  });
  expect(f.holder.holdUntilTransactionCompletes).toHaveBeenCalledTimes(2);
  expect(f.sources.withHeldCurrentFacts).not.toHaveBeenCalled();
  expect(f.sources.withCurrentPolicy).not.toHaveBeenCalled();
});
it.each([
  "tenantReference",
  "brandReference",
  "actorReference",
  "actorKind",
  "purposeCode",
  "validation",
  "approval",
  "permission",
])("rejects caller-supplied %s before authentication", async (key) => {
  const f = setup();
  await expect(f.post({ ...command, [key]: id(90) })).rejects.toHaveProperty(
    "code",
    "CATALOG_INPUT_INVALID",
  );
  expect(f.authorize).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
});
it.each(["profile", "replacementIntent", "replacementIntentDigest"])(
  "requires explicit V2 %s",
  async (key) => {
    const f = setup(),
      value = Object.fromEntries(Object.entries(command).filter(([name]) => name !== key));
    await expect(f.post(value)).rejects.toHaveProperty("code", "CATALOG_INPUT_INVALID");
    expect(f.authorize).not.toHaveBeenCalled();
  },
);
it("rejects null/extra/forged replacement intents without accessing nested getters", async () => {
  const f = setup(),
    get = vi.fn(() => "None");
  for (const replacementIntent of [
    null,
    { ...command.replacementIntent, extra: true },
    { ...command.replacementIntent, digest: "sha256:" + "c".repeat(64) },
    Object.defineProperty({ ...command.replacementIntent }, "mode", { get, enumerable: true }),
  ])
    await expect(f.post({ ...command, replacementIntent })).rejects.toHaveProperty(
      "code",
      "CATALOG_INPUT_INVALID",
    );
  expect(get).not.toHaveBeenCalled();
  expect(f.authorize).not.toHaveBeenCalled();
});
it("reserves System activation before authentication", async () => {
  const f = setup();
  await expect(f.post({ ...command, action: "ActivateScheduled" })).rejects.toHaveProperty(
    "code",
    "CATALOG_PERMISSION_DENIED",
  );
  expect(f.authorize).not.toHaveBeenCalled();
});
it("rejects a changed selected scope before owning execution", async () => {
  const f = setup();
  await expect(
    f.post(command, { brandReference: id(5), storeReference: id(99) }),
  ).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  expect(mocks.execute).not.toHaveBeenCalled();
});
it.each(["catalog.manage", "catalog.product.manage", "catalog.product.validate"])(
  "rejects late %s withdrawal through final admission",
  async (denied) => {
    const f = setup();
    f.late(() => {
      f.authorizeAction.mockImplementation(async (action) => ({
        action,
        effect: action === denied ? "Deny" : "Allow",
        scopeKind: "Brand",
      }));
    });
    await expect(f.post()).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  },
);
it("does not accept a Store grant for Brand mutation", async () => {
  const f = setup();
  f.authorizeAction.mockImplementation(async (action) => ({
    action,
    effect: "Allow",
    scopeKind: "Store",
  }));
  await expect(f.post()).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  expect(f.holder.holdUntilTransactionCompletes).not.toHaveBeenCalled();
});
it.each(["2026-10-02T12:00:05.000Z", "2026-10-02T11:59:59.999Z"])(
  "refuses late expiry/rollback %s",
  async (time) => {
    const f = setup();
    f.late(() => f.clock(time));
    await expect(f.post()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  },
);
it("captures configured port receiver and refuses a nonvoid holder", async () => {
  const f = setup();
  Object.assign(f.options, {
    authority: {},
    sources: {},
    auditReference: () => {
      throw Error("rebound");
    },
  });
  await f.post();
  const g = setup();
  g.holder.holdUntilTransactionCompletes.mockResolvedValue({} as never);
  await expect(g.post()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});
it("passes original full command/time unchanged to owning replay after clock advances", async () => {
  const f = setup();
  await f.post();
  const original = mocks.execute.mock.calls[0]?.[1];
  f.clock("2026-10-02T13:00:00.000Z");
  f.replay();
  expect(await f.post()).toMatchObject({
    status: "Replayed",
    replacementIntentDigest: replacementIntent.digest,
  });
  expect(mocks.execute.mock.calls[1]?.[1]).toEqual(original);
  expect(f.sources.withHeldCurrentFacts).not.toHaveBeenCalled();
});
it("requires full V2 sources and explicit approval validity configuration", () => {
  const f = setup();
  for (const sources of [{}, { withHeldCurrentFacts: vi.fn() }, { withCurrentPolicy: vi.fn() }])
    expect(() =>
      createMerchantProductPublicationCommandV2({ ...f.options, sources: sources as never }),
    ).toThrow(CatalogError);
  expect(() =>
    createMerchantProductPublicationCommandV2({ ...f.options, maximumApprovalValiditySeconds: 0 }),
  ).toThrow(CatalogError);
});

it("detects a partial clock rollback after observing a later instant", async () => {
  const f = setup();
  f.holder.holdUntilTransactionCompletes.mockImplementationOnce(async () => {
    f.clock("2026-10-02T12:00:00.002Z");
  });
  f.late(() => f.clock("2026-10-02T12:00:00.001Z"));
  await expect(f.post()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});

it.each(["initial", "late"] as const)(
  "classifies a malformed %s server clock as unavailable, never invalid user input",
  async (phase) => {
    const f = setup();
    if (phase === "initial") f.clock("SYNTHETIC_INVALID_CLOCK");
    else f.late(() => f.clock("SYNTHETIC_INVALID_CLOCK"));
    await expect(f.post()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    if (phase === "initial") expect(f.run).not.toHaveBeenCalled();
  },
);
it("retains a shorter source policy deadline through outer commit without renewing it", async () => {
  const f = setup(),
    original = mocks.execute.getMockImplementation();
  f.sources.withCurrentPolicy.mockImplementation(async (_tx, _input, work) =>
    work({ validUntil: "2026-10-02T12:00:01.000Z" }),
  );
  mocks.execute.mockImplementation(
    async (options: ProductPublicationStoreOptionsV2, command: unknown) => {
      const result = await original?.(options, command);
      await options.transactions.run((tx) =>
        options.sources.withCurrentPolicy(
          tx,
          { policyReference: id(30), policyVersion: 1, observedAt: at },
          async () => undefined,
        ),
      );
      f.clock("2026-10-02T12:00:01.000Z");
      return result;
    },
  );
  await expect(f.post()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});
it("rolls back when a later awaited owning guard exhausts the command's original lease", async () => {
  const f = setup(),
    original = mocks.execute.getMockImplementation();
  mocks.execute.mockImplementation(
    async (options: ProductPublicationStoreOptionsV2, command: unknown) => {
      const result = await original?.(options, command);
      await options.transactions.run(async (tx) => {
        if (!options.registerBeforeCommit) throw new Error("Missing owning commit hook");
        await options.registerBeforeCommit(
          tx,
          async () => {
            await Promise.resolve();
            f.clock("2026-10-02T12:00:05.000Z");
          },
          () => undefined,
        );
      });
      return result;
    },
  );
  await expect(f.post()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.holder.holdUntilTransactionCompletes).toHaveBeenCalledTimes(2);
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it("poisons a swallowed double source callback", async () => {
  const f = setup(),
    original = mocks.execute.getMockImplementation();
  f.sources.withCurrentPolicy.mockImplementation(async (_tx, _input, work) => {
    const first = await work({ validUntil: "2026-10-02T12:00:03.000Z" });
    try {
      await work({ validUntil: "2026-10-02T12:00:04.000Z" });
    } catch {
      /* Deliberate untrusted adapter swallowing. */
    }
    return first;
  });
  mocks.execute.mockImplementation(
    async (options: ProductPublicationStoreOptionsV2, command: unknown) => {
      const result = await original?.(options, command);
      await options.transactions.run((tx) =>
        options.sources.withCurrentPolicy(
          tx,
          { policyReference: id(30), policyVersion: 1, observedAt: at },
          async () => undefined,
        ),
      );
      return result;
    },
  );
  await expect(f.post()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});
it("refuses a transaction runner substituting or duplicating its callback result", async () => {
  const f = setup();
  f.run.mockImplementation(async (work) => {
    await work({ query: vi.fn(async () => ({ rows: [] })) });
    return {};
  });
  await expect(f.post()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  const g = setup();
  g.run.mockImplementation(async (work) => {
    const tx = { query: vi.fn(async () => ({ rows: [] })) },
      first = await work(tx);
    try {
      await work(tx);
    } catch {
      /* Deliberate untrusted runner swallowing. */
    }
    return first;
  });
  await expect(g.post()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});

it("preserves the separate server report details through the bounded source callback", async () => {
  const f = setup(),
    original = mocks.execute.getMockImplementation();
  const details = { coverage: "ChecksOnly", impact: "NotRecorded" };
  f.sources.withHeldCurrentFacts.mockImplementation(async (_tx, input, work) => {
    const validation = {
      profile: "CatalogProductPublicationValidationV2",
      replacementIntentDigest: input.command.replacementIntentDigest,
      evidenceReference: id(50),
      productAggregateVersion: input.command.expectedProductAggregateVersion,
      contentDigest: input.command.contentDigest,
      configurationDigest: input.command.configurationDigest,
      scopeDigest: hash(input.command.scopeSet),
      periodDigest: hash(input.command.effectivePeriod),
      policyReference: id(51),
      policyVersion: 1,
      approvalPolicy: "NotRequired",
      checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
      warningAcknowledgement: null,
      checkedAt: at,
      validUntil: "2026-10-02T12:00:03.000Z",
    };
    return work({ validation }, details);
  });
  mocks.execute.mockImplementation(
    async (options: ProductPublicationStoreOptionsV2, parsed: unknown) => {
      const result = await original?.(options, parsed);
      await options.transactions.run((tx) =>
        options.sources.withHeldCurrentFacts(
          tx,
          { command: parsed, aggregate: {}, current: null, content: null, observedAt: at } as never,
          async (_facts, captured) => {
            expect(captured).toEqual(details);
            expect(captured).not.toBe(details);
            details.impact = "SYNTHETIC_LATE_MUTATION";
            expect(captured).toEqual({ coverage: "ChecksOnly", impact: "NotRecorded" });
          },
        ),
      );
      return result;
    },
  );
  await expect(f.post()).resolves.toMatchObject({ status: "Applied" });
  expect(f.sources.withHeldCurrentFacts).toHaveBeenCalledTimes(1);
});

// Factory tests isolate the real authenticated host and source boundary. Their
// controlled writer does not stand in for native reference qualification.
function factorySetup() {
  const f = setup(),
    { sources: supplied, ...base } = f.options,
    inputs: MerchantProductPublicationSourceFactoryV2Input[] = [],
    reads = vi.fn(),
    content = vi.fn(async () => undefined),
    sources: ProductPublicationStoreOptionsV2["sources"] = {
      async withHeldCurrentFacts() {
        throw new Error("No synthetic facts requested by this writer control");
      },
      async withCurrentPolicy(tx, request, work) {
        expect(this).toBe(sources);
        expect(tx).toBe(inputs[0]?.transaction);
        reads(request);
        return work({ validUntil: "2026-10-02T12:00:03.000Z" });
      },
    },
    produced = { sources, editorContentAuthority: content },
    factory: MerchantProductPublicationSourceFactoryV2 = (input) => {
      expect(f.events).toEqual(["BEGIN"]);
      expect(f.authorize).toHaveBeenCalledTimes(1);
      inputs.push(input);
      return produced;
    },
    options = { ...base, sourceFactory: factory },
    execute = createMerchantProductPublicationCommandV2(options);
  void supplied;
  return {
    ...f,
    supplied: f.sources,
    inputs,
    reads,
    produced,
    options,
    postFactory: () =>
      execute({
        sessionCookie: "synthetic",
        csrf: "synthetic",
        command,
        expectedScope: { brandReference: id(5), storeReference: id(6) },
      }),
  };
}
it("creates sources once in the authenticated actual transaction and captures factory/result ports", async () => {
  const f = factorySetup(),
    original = mocks.execute.getMockImplementation();
  f.options.sourceFactory = () => {
    throw new Error("Replaced factory");
  };
  mocks.execute.mockImplementation(
    async (options: ProductPublicationStoreOptionsV2, parsed: unknown) => {
      f.produced.sources.withCurrentPolicy = async () => {
        throw new Error("Replaced source port");
      };
      const result = await original?.(options, parsed);
      await options.transactions.run((tx) =>
        options.sources.withCurrentPolicy(
          tx,
          { policyReference: id(30), policyVersion: 1, observedAt: at },
          async () => undefined,
        ),
      );
      return result;
    },
  );
  await expect(f.postFactory()).resolves.toMatchObject({ status: "Applied" });
  expect(f.inputs).toHaveLength(1);
  expect(f.inputs[0]).toMatchObject({
    command: {
      ...command,
      tenantReference: id(4),
      brandReference: id(5),
      actorReference: id(7),
      actorKind: "User",
    },
    tenantReference: id(4),
    brandReference: id(5),
    actorReference: id(7),
    storeReference: id(6),
    sessionReference: id(8),
    originalValidUntil: "2026-10-02T12:00:05.000Z",
  });
  expect(Object.isFrozen(f.inputs[0])).toBe(true);
  expect(f.reads).toHaveBeenCalledTimes(1);
  expect(f.supplied.withCurrentPolicy).not.toHaveBeenCalled();
  expect(f.events).toEqual(["BEGIN", "COMMIT"]);
});
it("factory replay does not read fresh qualification or policy", async () => {
  const f = factorySetup();
  f.replay();
  f.clock("2026-10-04T12:00:00.000Z");
  await expect(f.postFactory()).resolves.toMatchObject({ status: "Replayed" });
  expect(f.inputs).toHaveLength(1);
  expect(f.reads).not.toHaveBeenCalled();
  expect(f.produced.editorContentAuthority).not.toHaveBeenCalled();
});
it.each([
  ["backwards", "2026-10-02T11:59:59.999Z"],
  ["expired", "2026-10-02T12:00:05.000Z"],
])(
  "permanently poisons a caught factory %s clock failure even after the clock is restored",
  async (_kind, invalidAt) => {
    void _kind;
    const f = factorySetup(),
      execute = createMerchantProductPublicationCommandV2({
        ...f.options,
        sourceFactory(input) {
          f.clock(invalidAt);
          expect(() => input.clock.now()).toThrow(CatalogError);
          f.clock(at);
          return f.produced;
        },
      });
    await expect(
      execute({
        sessionCookie: "synthetic",
        csrf: "synthetic",
        command,
        expectedScope: { brandReference: id(5), storeReference: id(6) },
      }),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(f.reads).not.toHaveBeenCalled();
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
  },
);
it.each(["sources", "currentUniqueScope", "editorContentAuthority"] as const)(
  "rejects ambiguous factory plus legacy %s configuration",
  (field) => {
    const f = factorySetup();
    expect(() =>
      createMerchantProductPublicationCommandV2({
        ...f.options,
        [field]:
          field === "sources"
            ? f.supplied
            : field === "editorContentAuthority"
              ? async () => undefined
              : {},
      } as never),
    ).toThrow(CatalogError);
    expect(f.inputs).toHaveLength(0);
  },
);
it.each([
  null,
  {},
  { sources: {} },
  { sources: {}, editorContentAuthority: null },
  { extra: true },
])("rejects malformed factory result before writer dispatch: %j", async (result) => {
  const f = factorySetup();
  const execute = createMerchantProductPublicationCommandV2({
    ...f.options,
    sourceFactory: () => result as never,
  });
  await expect(
    execute({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      command,
      expectedScope: { brandReference: id(5), storeReference: id(6) },
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it("rejects extra factory result fields even when all required ports are callable", async () => {
  const f = factorySetup(),
    execute = createMerchantProductPublicationCommandV2({
      ...f.options,
      sourceFactory: () => ({ ...f.produced, extra: true }),
    });
  await expect(
    execute({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      command,
      expectedScope: { brandReference: id(5), storeReference: id(6) },
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(mocks.execute).not.toHaveBeenCalled();
});
it("factory guards retain the original deadline after later async work", async () => {
  const f = factorySetup(),
    original = mocks.execute.getMockImplementation();
  mocks.execute.mockImplementation(
    async (options: ProductPublicationStoreOptionsV2, command: unknown) => {
      const result = await original?.(options, command),
        input = f.inputs[0];
      if (!input) throw Error("Missing actual factory input");
      await input.registerBeforeCommit(
        input.transaction,
        async () => {
          await Promise.resolve();
          f.clock("2026-10-02T12:00:05.000Z");
        },
        () => {
          input.clock.now();
        },
      );
      return result;
    },
  );
  await expect(f.postFactory()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it("a caught foreign transaction registration through the factory still poisons the host", async () => {
  const f = factorySetup(),
    original = mocks.execute.getMockImplementation();
  mocks.execute.mockImplementation(
    async (options: ProductPublicationStoreOptionsV2, command: unknown) => {
      const result = await original?.(options, command),
        input = f.inputs[0];
      if (!input) throw Error("Missing actual factory input");
      await input
        .registerBeforeCommit(
          { query: async () => ({ rows: [] }) },
          async () => undefined,
          () => undefined,
        )
        .catch(() => undefined);
      return result;
    },
  );
  await expect(f.postFactory()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
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
    mocks.execute.mockImplementation(
      async (options: ProductPublicationStoreOptionsV2, command: unknown) => {
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
      },
    );
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
    mocks.execute.mockImplementation(
      async (options: ProductPublicationStoreOptionsV2, command: unknown) => {
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
      },
    );
    await expect(f.postFactory()).rejects.toBeInstanceOf(CatalogError);
    expect(calls).toBe(2);
    expect(f.events.at(-1)).toBe("ROLLBACK");
    expect(f.events).not.toContain("COMMIT");
  },
);

it.each([false, true])(
  "holds the concrete runtime field and Screen authority even for replay: %s",
  async (replay) => {
    const f = factorySetup(),
      { authority: _authority, ...base } = f.options;
    void _authority;
    if (replay) f.replay();
    const holdUntilCommit = vi.fn(async () => undefined);
    mocks.runtimeAuthority.mockReturnValue({ publicationAuthority: f.holder });
    mocks.permission.mockReturnValue(
      Object.freeze({
        authorize: vi.fn(),
        authorizeWithRoles: vi.fn(),
        authorizeActionsWithRoles: vi.fn(),
      }),
    );
    const capability = { holdUntilCommit };
    mocks.capability.mockReturnValue(capability);
    const run = createMerchantProductPublicationCommandV2({ ...base, currentRuntime: true });
    await expect(
      run({
        sessionCookie: "synthetic",
        csrf: "synthetic",
        command,
        expectedScope: { brandReference: id(5), storeReference: id(6) },
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
    expect(holdUntilCommit).toHaveBeenCalledTimes(2);
    expect(f.holder.holdUntilTransactionCompletes).toHaveBeenCalledTimes(2);
    expect(f.authorizeActionsWithValidity.mock.calls).toEqual(
      Array.from({ length: 4 }, () => [
        [
          "catalog.manage",
          "catalog.product.manage",
          "catalog.product.read",
          "catalog.product.validate",
        ],
      ]),
    );
  },
);
it("refuses mixed concrete runtime and injected publication authority", () => {
  const f = factorySetup();
  expect(() =>
    createMerchantProductPublicationCommandV2({ ...f.options, currentRuntime: true }),
  ).toThrow(expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }));
});

function runtimeFactorySetup() {
  const f = factorySetup(),
    { authority: omitted, ...base } = f.options;
  void omitted;
  mocks.runtimeAuthority.mockReturnValue({ publicationAuthority: f.holder });
  mocks.capability.mockReturnValue({ holdUntilCommit: vi.fn(async () => undefined) });
  const execute = createMerchantProductPublicationCommandV2({ ...base, currentRuntime: true });
  return {
    ...f,
    postRuntime: () =>
      execute({
        sessionCookie: "synthetic",
        csrf: "synthetic",
        command,
        expectedScope: { brandReference: id(5), storeReference: id(6) },
      }),
  };
}
it.each(["admission", "media"])(
  "retains the runtime %s grant boundary through later null boundaries and all async guards",
  async (target) => {
    const f = runtimeFactorySetup(),
      original = mocks.execute.getMockImplementation(),
      boundary = "2026-10-02T12:00:02.000Z";
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
    mocks.execute.mockImplementation(
      async (options: ProductPublicationStoreOptionsV2, parsed: unknown) => {
        const input = f.inputs[0];
        if (!input || !original) throw new Error("Missing controlled runtime host");
        if (target === "media") await input.authorizeMediaAccess();
        const result = await original(options, parsed);
        await input.registerBeforeCommit(
          input.transaction,
          async () => {
            f.clock(boundary);
          },
          () => undefined,
        );
        return result;
      },
    );
    await expect(f.postRuntime()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    expect(
      f.authorizeActionsWithValidity.mock.calls.filter(([actions]) =>
        actions.includes("catalog.manage"),
      ),
    ).toHaveLength(4);
    if (target === "media")
      expect(f.authorizeActionsWithValidity).toHaveBeenCalledWith(["media.asset.access"]);
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
  },
);
it.each(["denied", "wrong scope"])(
  "refuses runtime admission %s at the later checkpoint",
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
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
  },
);
it("poisons the runtime transaction when a late Media denial is caught", async () => {
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
  mocks.execute.mockImplementation(
    async (options: ProductPublicationStoreOptionsV2, parsed: unknown) => {
      const input = f.inputs[0];
      if (!input || !original) throw new Error("Missing controlled runtime host");
      await input.authorizeMediaAccess();
      const result = await original(options, parsed);
      await input.registerBeforeCommit(
        input.transaction,
        async () => {
          await input.authorizeMediaAccess().catch(() => undefined);
        },
        () => undefined,
      );
      return result;
    },
  );
  await expect(f.postRuntime()).rejects.toBeInstanceOf(CatalogError);
  expect(mediaCalls).toBe(2);
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it("preserves legacy decision-only admission and Media authorization", async () => {
  const f = factorySetup(),
    original = mocks.execute.getMockImplementation();
  mocks.execute.mockImplementation(
    async (options: ProductPublicationStoreOptionsV2, parsed: unknown) => {
      const input = f.inputs[0];
      if (!input || !original) throw new Error("Missing controlled runtime host");
      await input.authorizeMediaAccess();
      return original(options, parsed);
    },
  );
  await expect(f.postFactory()).resolves.toMatchObject({ status: "Applied" });
  expect(f.authorizeActionsWithValidity).not.toHaveBeenCalled();
  expect(f.authorizeAction).toHaveBeenCalledWith("media.asset.access");
  expect(f.holder.holdUntilTransactionCompletes).toHaveBeenCalledTimes(2);
});

it("preserves legacy permission construction instead of opting unrelated consumers into transaction optimization", async () => {
  const f = factorySetup();
  await f.postFactory();
  expect(mocks.permission).not.toHaveBeenCalled();
  for (const args of mocks.brandFactory.mock.calls) expect(args).toHaveLength(1);
});
it("refuses a missing transaction Permission source in currentRuntime rather than falling back to legacy", async () => {
  const f = factorySetup(),
    { authority, ...base } = f.options;
  expect(authority).toBeDefined();
  mocks.permission.mockReturnValue(undefined);
  await expect(
    createMerchantProductPublicationCommandV2({ ...base, currentRuntime: true })({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      command,
      expectedScope: { brandReference: id(5), storeReference: id(6) },
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.reads).not.toHaveBeenCalled();
  expect(mocks.execute).not.toHaveBeenCalled();
});
