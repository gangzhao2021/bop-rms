import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  createCatalogOptionSetAuthoringIdentity,
  createCatalogOptionSetAuthoringResolution,
  materializeFullOptionSetCreation,
  materializeFullOptionSetEdit,
  parseCatalogOptionSetEditorContent,
  optionSetAuthoringResolutionFields,
  parseCatalogReference,
  parseCatalogInstant,
  type OptionSetAuthoringResolutionStoreOptions,
} from "@rms/catalog";
import { createMerchantOptionSetAuthoringResolutionCommand } from "./merchant-option-set-authoring-resolution-command.js";
const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  store: vi.fn(),
  current: vi.fn(),
  capability: vi.fn(),
}));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => mocks.scope }));
vi.mock("./merchant-product-current-authorization.js", () => ({
  createMerchantProductCurrentAuthorization: (o: unknown) => mocks.current(o),
}));
vi.mock("./merchant-product-store-capability.js", () => ({
  createMerchantProductStoreCapabilityGuard: (o: unknown) => mocks.capability(o),
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresOptionSetAuthoringResolutionStore: (options: unknown) => ({
    resolveInTransaction: (tx: unknown, command: unknown) => mocks.store(options, tx, command),
    resolve: () => {
      throw Error("Standalone resolver must not run inside the actual host");
    },
  }),
}));
beforeEach(() => vi.clearAllMocks());
const id = (n: number) => "01902421-7600-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z";
const after = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
type OwnerOptions = OptionSetAuthoringResolutionStoreOptions;
type Tx = Parameters<OwnerOptions["registerBeforeCommit"]>[0];
type Command = Parameters<OwnerOptions["authority"]["holdUntilTransactionCompletes"]>[1]["command"];
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

function harness(
  action: "Create" | "Edit" = "Create",
  outcome: "Committed" | "Abandoned" = "Abandoned",
) {
  const body = {
    profile: "CatalogOptionSetAuthoringResolutionRequestV1",
    tenantReference: id(1),
    action,
    operationReference: id(7),
    optionSetReference: action === "Create" ? null : id(6),
    expectedAggregateVersion: action === "Create" ? null : 1,
  };
  const state = {
    now: at,
    deadline: until,
    capabilityDeadline: until,
    allowed: true,
    committed: false,
    failCommit: false,
  };
  const tx = { query: vi.fn(async () => ({ rows: [] })) };
  const current = {
      assertCurrent: vi.fn(() => {
        if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return state.now;
      }),
      authorizeActions: vi.fn(async () => {
        if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      }),
      leaseDeadline: vi.fn(() => state.deadline),
      withCurrentStoreScope: vi.fn(),
    },
    capability = {
      holdUntilCommit: vi.fn(async () => undefined),
      leaseDeadline: vi.fn(() => state.capabilityDeadline),
    };
  mocks.current.mockReturnValue(current);
  mocks.capability.mockReturnValue(capability);
  let actualTx: Tx | undefined;
  mocks.scope.mockImplementation(async (actual: Tx) => {
    actualTx = actual;
    return {
      tenantReference: id(1),
      actorReference: id(4),
      context: { brand: { brandReference: id(2) } },
      selectedStoreReference: id(3),
    };
  });
  const authorityInput = (c: Command) => ({
    command: c,
    mode: "Resolve" as const,
    permission: "catalog.manage" as const,
    requiredPermissions: ["catalog.manage", "catalog.option_set.read"],
    requiredFields: optionSetAuthoringResolutionFields,
    purposeCode: "CATALOG_OPTION_SET_AUTHORING_OPERATION_RESOLUTION" as const,
    actorKind: "User" as const,
    requiredScope: "FullBrandScope" as const,
    observedAt: at,
  });
  const owner = async (o: OwnerOptions, t: Tx, c: Command) => {
    expect(t).toBe(actualTx);
    const lease = await o.authority.holdUntilTransactionCompletes(t, authorityInput(c));
    expect(lease).toEqual({
      observedAt: at,
      validUntil:
        state.deadline < state.capabilityDeadline ? state.deadline : state.capabilityDeadline,
    });
    await o.registerBeforeCommit(
      t,
      async () => {
        await o.authority.holdUntilTransactionCompletes(t, authorityInput(c));
      },
      () => undefined,
    );
    if (outcome === "Abandoned") {
      const resolution = createCatalogOptionSetAuthoringResolution({
        outcome,
        command: c,
        identity: null,
        recordedAt: parseCatalogInstant(at),
      });
      const audit = o.audit.create({ command: c, resolution });
      expect(audit).toMatchObject({
        auditId: id(10),
        actor: { type: "User", reference: id(4) },
        brandId: id(2),
        reasonCode: "AUTHORIZED_OPERATION",
        actionCode: "CATALOG_OPTION_SET_AUTHORING_ABANDONED",
        targetType: "CatalogOptionSetAuthoringOperation",
      });
      expect(audit).not.toHaveProperty("storeId");
      return { resolution, content: null };
    }
    const original = full(),
      base = creation();
    const content =
      action === "Create"
        ? original
        : materializeFullOptionSetEdit(
            {
              optionSetReference: id(6),
              expectedAggregateVersion: 1,
              draft: {
                ...base.draft,
                options: base.draft.options.map((option) => ({
                  ...option,
                  identity: { kind: "Existing", optionReference: id(9) },
                })),
              },
              additionalContent: base.additionalContent,
              archiveOptionReferences: [],
              operationReference: id(7),
              occurredAt: at,
              reasonCode: "AUTHORIZED_OPERATION",
            },
            original,
            { actorReference: id(4), newOptions: [] },
          ).content;
    const { sourceAggregate, ...additional } = content;
    const parsed = parseCatalogOptionSetEditorContent(sourceAggregate, additional);
    const identity = createCatalogOptionSetAuthoringIdentity({
      command: c,
      sourceOperationReference: c.operationReference,
      optionSetReference: parseCatalogReference(id(6)),
      versionReference: content.sourceAggregate.draft.versionReference,
      aggregateVersion: action === "Create" ? 1 : 2,
      originalOccurredAt: parseCatalogInstant(at),
      auditReference: parseCatalogReference(id(10)),
      originalIntentDigest: "sha256:" + "1".repeat(64),
      sourceDigest: parsed.sourceDigest,
      contentDigest: parsed.contentDigest,
      configurationDigest: parsed.configurationDigest,
    });
    return {
      resolution: createCatalogOptionSetAuthoringResolution({
        outcome,
        command: c,
        identity,
        recordedAt: parseCatalogInstant(at),
      }),
      content,
    };
  };
  mocks.store.mockImplementation(owner);
  const authentication = { authorize: vi.fn(async () => ({ sessionReference: id(5) })) };
  const merchant = {
    now: () => state.now,
    transactions: {
      async run<T>(work: (t: typeof tx) => Promise<T>) {
        const value = await work(tx);
        if (state.failCommit) throw Error("Synthetic COMMIT failure");
        state.committed = true;
        return value;
      },
    },
  };
  const options = {
    merchant: merchant as unknown as Parameters<
      typeof createMerchantOptionSetAuthoringResolutionCommand
    >[0]["merchant"],
    authentication: authentication as unknown as Parameters<
      typeof createMerchantOptionSetAuthoringResolutionCommand
    >[0]["authentication"],
    auditReference: () => id(10),
  };
  const request = {
    sessionCookie: "synthetic-session",
    csrf: "synthetic-csrf",
    command: body,
    expectedScope: { brandReference: id(2), storeReference: id(3) },
  };
  return {
    body,
    state,
    tx,
    current,
    capability,
    authentication,
    merchant,
    options,
    request,
    owner,
    authorityInput,
    execute: () => createMerchantOptionSetAuthoringResolutionCommand(options)(request),
  };
}
it.each(["Create", "Edit"] as const)(
  "%s absent original uses read admission and actual COMMIT before return",
  async (action) => {
    const h = harness(action);
    const r = await h.execute();
    expect(h.state.committed).toBe(true);
    expect(r).toMatchObject({
      profile: "CatalogOptionSetAuthoringResolutionResultV1",
      storeReference: id(3),
      content: null,
      resolution: {
        outcome: "Abandoned",
        command: {
          actorReference: id(4),
          brandReference: id(2),
          reasonCode: "AUTHORIZED_OPERATION",
          action,
        },
      },
    });
    expect(h.current.authorizeActions).toHaveBeenCalledWith([
      "catalog.manage",
      "catalog.option_set.read",
    ]);
    expect(mocks.capability.mock.calls[0]?.[0].capabilityKey).toBe(
      action === "Create" ? "catalog.cat_optionset_create" : "catalog.cat_optionset_edit",
    );
  },
);
it("returns exact immutable committed identity and original complete content", async () => {
  const h = harness("Create", "Committed");
  const r = await h.execute();
  expect(r.content).toEqual(full());
  expect(r.resolution.identity?.originalOccurredAt).toBe(at);
  expect(h.state.committed).toBe(true);
});
it.each([
  "actorReference",
  "brandReference",
  "storeReference",
  "occurredAt",
  "reasonCode",
  "content",
])("rejects browser %s before source admission", async (key) => {
  const h = harness();
  h.request.command = { ...h.body, [key]: id(11) } as typeof h.body;
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(h.authentication.authorize).not.toHaveBeenCalled();
});
it.each([
  { action: "ReplaceDraft" },
  { optionSetReference: id(6) },
  { expectedAggregateVersion: 1 },
])("rejects malformed Create identity %j", async (change) => {
  const h = harness();
  Object.assign(h.body, change);
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
});
it("denies mismatched Tenant and selected Store", async () => {
  const h = harness();
  h.body.tenantReference = id(11);
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  const s = harness();
  s.request.expectedScope.storeReference = id(11);
  await expect(s.execute()).rejects.toBeDefined();
  expect(s.state.committed).toBe(false);
});
it.each(["current", "capability"] as const)(
  "requires actual %s lease observation",
  async (which) => {
    const h = harness();
    mocks[which].mockReturnValue({ ...h[which], leaseDeadline: undefined });
    await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(mocks.store).not.toHaveBeenCalled();
  },
);
it("holds shortest actual lease and rejects expiry before final COMMIT", async () => {
  const h = harness();
  h.state.deadline = after(1000);
  mocks.store.mockImplementation(async (o: OwnerOptions, t: Tx, c: Command) => {
    const result = await h.owner(o, t, c);
    await o.registerBeforeCommit(
      t,
      async () => {
        h.state.now = after(1000);
      },
      () => undefined,
    );
    return result;
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("rejects permission withdrawal during later owner before-COMMIT guard", async () => {
  const h = harness();
  mocks.store.mockImplementation(async (o: OwnerOptions, t: Tx, c: Command) => {
    const result = await h.owner(o, t, c);
    await o.registerBeforeCommit(
      t,
      async () => {
        h.state.allowed = false;
      },
      () => undefined,
    );
    return result;
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(h.state.committed).toBe(false);
});
it.each([
  { mode: "Write" },
  { requiredPermissions: ["catalog.manage", "catalog.option_set.create"] },
  { purposeCode: "OTHER" },
  { requiredFields: ["operationReference"] },
  { actorKind: "Service" },
  { requiredScope: "StoreScope" },
])("refuses altered owning authority %j", async (change) => {
  const h = harness();
  mocks.store.mockImplementation(async (o: OwnerOptions, t: Tx, c: Command) => {
    await o.authority.holdUntilTransactionCompletes(t, {
      ...h.authorityInput(c),
      ...change,
    } as Parameters<OwnerOptions["authority"]["holdUntilTransactionCompletes"]>[1]);
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("rejects substituted owning transaction", async () => {
  const h = harness();
  mocks.store.mockImplementation(async (o: OwnerOptions, _t: Tx, c: Command) => {
    await o.authority.holdUntilTransactionCompletes(h.tx, h.authorityInput(c));
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("never returns a resolution when actual transaction COMMIT fails", async () => {
  const h = harness();
  h.state.failCommit = true;
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("captures original ports before authentication awaits", async () => {
  const h = harness();
  h.authentication.authorize.mockImplementation(async () => {
    h.options.auditReference = () => id(99);
    h.merchant.now = () => after(10000);
    h.merchant.transactions.run = async () => {
      throw Error("replacement runner");
    };
    return { sessionReference: id(5) };
  });
  const r = await h.execute();
  expect(r.resolution.outcome).toBe("Abandoned");
  expect(h.state.committed).toBe(true);
});
it("authentication time cannot renew the original five-second lease", async () => {
  const h = harness();
  h.authentication.authorize.mockImplementation(async () => {
    h.state.now = after(5000);
    return { sessionReference: id(5) };
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(mocks.scope).not.toHaveBeenCalled();
});

it("captures actual authorization and capability ports despite later replacement", async () => {
  const h = harness();
  mocks.store.mockImplementation(async (o: OwnerOptions, t: Tx, c: Command) => {
    h.current.authorizeActions = vi.fn(async () => {
      throw Error("replacement authorization");
    });
    h.current.assertCurrent = vi.fn(() => {
      throw Error("replacement assert");
    });
    h.current.leaseDeadline = vi.fn(() => after(0));
    h.capability.holdUntilCommit = vi.fn(async () => {
      throw Error("replacement capability");
    });
    h.capability.leaseDeadline = vi.fn(() => after(0));
    return h.owner(o, t, c);
  });
  expect((await h.execute()).resolution.outcome).toBe("Abandoned");
});
it("uses an earlier actual FeatureControl boundary without renewing it", async () => {
  const h = harness();
  h.state.capabilityDeadline = after(900);
  expect((await h.execute()).resolution.outcome).toBe("Abandoned");
});
it("poisons a swallowed invalid authority attempt", async () => {
  const h = harness();
  mocks.store.mockImplementation(async (o: OwnerOptions, t: Tx, c: Command) => {
    await o.authority
      .holdUntilTransactionCompletes(t, { ...h.authorityInput(c), mode: "Write" })
      .catch(() => undefined);
    return h.owner(o, t, c);
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("rejects authority reentry while the actual asynchronous hold is pending", async () => {
  const h = harness();
  let original: OwnerOptions | undefined, actual: Tx | undefined, command: Command | undefined;
  mocks.store.mockImplementation(async (o: OwnerOptions, t: Tx, c: Command) => {
    original = o;
    actual = t;
    command = c;
    return h.owner(o, t, c);
  });
  h.capability.holdUntilCommit.mockImplementation(async () => {
    if (!original || !actual || !command) throw Error("missing original owning packet");
    await original.authority.holdUntilTransactionCompletes(actual, h.authorityInput(command));
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("rejects source content returned alongside an Abandoned identity", async () => {
  const h = harness();
  mocks.store.mockImplementation(async (o: OwnerOptions, t: Tx, c: Command) => ({
    ...(await h.owner(o, t, c)),
    content: full(),
  }));
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("rejects original full content that does not match the committed digest", async () => {
  const h = harness("Create", "Committed");
  mocks.store.mockImplementation(async (o: OwnerOptions, t: Tx, c: Command) => {
    const value = await h.owner(o, t, c),
      content = globalThis.structuredClone(value.content);
    if (!content) throw Error("missing original complete content");
    const altered = {
      ...content,
      sourceAggregate: { ...content.sourceAggregate, updatedAt: after(1) },
    };
    return { ...value, content: altered };
  });
  await expect(h.execute()).rejects.toBeDefined();
  expect(h.state.committed).toBe(false);
});
it("does not return until the actual COMMIT owner completes", async () => {
  const h = harness();
  let release: (() => void) | undefined, entered: (() => void) | undefined;
  const waiting = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  const original = h.merchant.transactions.run;
  h.merchant.transactions.run = async (work) => {
    const value = await original(work);
    h.state.committed = false;
    entered?.();
    await waiting;
    h.state.committed = true;
    return value;
  };
  let returned = false;
  const result = h.execute().then((value) => {
    returned = true;
    return value;
  });
  await started;
  expect(returned).toBe(false);
  expect(h.state.committed).toBe(false);
  release?.();
  expect((await result).resolution.outcome).toBe("Abandoned");
  expect(h.state.committed).toBe(true);
});

it("returns the original complete Edit receipt without creating another version", async () => {
  const h = harness("Edit", "Committed"),
    result = await h.execute();
  expect(result.resolution.identity?.aggregateVersion).toBe(2);
  expect(result.content?.sourceAggregate.aggregateVersion).toBe(2);
  expect(mocks.store).toHaveBeenCalledTimes(1);
  expect(h.state.committed).toBe(true);
});
it("captures original browser identity across asynchronous authentication", async () => {
  const h = harness();
  h.authentication.authorize.mockImplementation(async () => {
    h.body.operationReference = id(88);
    h.request.expectedScope.brandReference = id(89);
    return { sessionReference: id(5) };
  });
  expect((await h.execute()).resolution.command.operationReference).toBe(id(7));
});
it("rejects a substituted Brand anchor", async () => {
  const h = harness();
  h.request.expectedScope.brandReference = id(99);
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(h.state.committed).toBe(false);
});
