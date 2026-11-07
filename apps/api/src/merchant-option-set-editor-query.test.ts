import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  materializeFullOptionSetCreation,
  parseCatalogOptionSetEditorContent,
  type createPostgresCurrentFullOptionSetDraftStore,
} from "@rms/catalog";
import { createMerchantOptionSetEditorQuery } from "./merchant-option-set-editor-query.js";
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
  createPostgresCurrentFullOptionSetDraftStore: (options: unknown) => ({
    readCurrent: (command: unknown) => mocks.store(options, command),
  }),
}));
beforeEach(() => vi.clearAllMocks());
const id = (n: number) => "01902421-7600-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z";
const after = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
type Owner = Parameters<typeof createPostgresCurrentFullOptionSetDraftStore>[0];
type Tx = Parameters<Owner["authority"]["holdUntilTransactionCompletes"]>[0];
const fields = [
  "optionSetReference",
  "versionReference",
  "defaultLocale",
  "localizedNames",
  "localizedDescriptions",
  "displayStyle",
  "minimumSelection",
  "maximumSelection",
  "allowRepeatedOption",
  "perOptionMaximumQuantity",
  "maximumTotalQuantity",
  "options",
  "optionDetails",
  "conditionalRules",
  "conflictRules",
  "scopeSet",
  "effectivePeriod",
];
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

// Controlled source ports exercise the actual runtime holder/category host; this is not native IAM/SQL evidence.
function harness(expectedAggregateVersion: number | null = null) {
  const state = {
    now: at,
    deadline: until,
    capabilityDeadline: until,
    allowed: true,
    committed: false,
    commitFails: false,
  };
  const body = { optionSetReference: id(6), expectedAggregateVersion };
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
  let actual: Tx | undefined;
  mocks.scope.mockImplementation(async (tx: Tx) => {
    actual = tx;
    return {
      tenantReference: id(1),
      actorReference: id(4),
      context: { brand: { brandReference: id(2) } },
      selectedStoreReference: id(3),
    };
  });
  const owner = async (o: Owner, command: typeof body) =>
    o.transactions.run(async (tx) => {
      expect(tx).toBe(actual);
      expect(command).toEqual(body);
      const content = full(),
        { sourceAggregate, ...details } = content,
        parsed = parseCatalogOptionSetEditorContent(sourceAggregate, details),
        input = {
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(4),
          actorKind: "User" as const,
          permission: "catalog.manage" as const,
          action: "catalog.option_set.read" as const,
          purposeCode: "CATALOG_OPTION_SET_DRAFT" as const,
          requiredFields: [
            "internalCode",
            "brandReference",
            "lifecycle",
            "aggregateVersion",
            "createdAt",
            "createdByActorReference",
            "updatedAt",
            ...fields,
          ],
          optionSetReference: command.optionSetReference,
          observedAt: at,
          content: null as unknown,
        };
      await o.authority.holdUntilTransactionCompletes(tx, input);
      await tx.query("SELECT synthetic_source_port", []);
      if (command.expectedAggregateVersion !== null && command.expectedAggregateVersion !== 1)
        throw new CatalogError("CATALOG_VERSION_CONFLICT");
      const lease = await o.authority.holdUntilTransactionCompletes(tx, { ...input, content });
      return {
        content: parsed.content,
        sourceDigest: parsed.sourceDigest,
        contentDigest: parsed.contentDigest,
        configurationDigest: parsed.configurationDigest,
        observedAt: at,
        validUntil: lease.validUntil,
        referenceEligibility: "NotEvaluated",
      };
    });
  mocks.store.mockImplementation(owner);
  const authentication = { authorize: vi.fn(async () => ({ sessionReference: id(5) })) },
    tx = { query: vi.fn(async () => ({ rows: [] })) },
    merchant = {
      now: () => state.now,
      transactions: {
        async run<T>(work: (t: typeof tx) => Promise<T>) {
          const value = await work(tx);
          if (state.commitFails) throw Error("Synthetic late host failure");
          state.committed = true;
          return value;
        },
      },
    },
    options = {
      merchant: merchant as unknown as Parameters<
        typeof createMerchantOptionSetEditorQuery
      >[0]["merchant"],
      authentication: authentication as unknown as Parameters<
        typeof createMerchantOptionSetEditorQuery
      >[0]["authentication"],
    },
    request = {
      sessionCookie: "synthetic-session",
      csrf: "synthetic-csrf",
      expectedScope: { brandReference: id(2), storeReference: id(3) },
      command: body,
    };
  return {
    state,
    body,
    current,
    capability,
    authentication,
    merchant,
    options,
    request,
    owner,
    tx,
    execute: () => createMerchantOptionSetEditorQuery(options)(request),
  };
}
it.each([null, 1])(
  "reads actual full Draft for expected version %s and returns only after COMMIT",
  async (version) => {
    const h = harness(version),
      r = await h.execute();
    expect(h.state.committed).toBe(true);
    expect(r).toMatchObject({
      profile: "CatalogOptionSetCurrentEditorResultV1",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(4),
      storeReference: id(3),
      content: full(),
      referenceEligibility: "NotEvaluated",
    });
    expect(r).not.toHaveProperty("validUntil");
    expect(r).not.toHaveProperty("observedAt");
    expect(h.current.authorizeActions).toHaveBeenCalledWith([
      "catalog.manage",
      "catalog.option_set.read",
    ]);
    expect(mocks.capability.mock.calls[0]?.[0].capabilityKey).toBe("catalog.cat_optionset_detail");
    expect(mocks.store).toHaveBeenCalledTimes(1);
  },
);
it.each([
  { expectedAggregateVersion: 0 },
  { expectedAggregateVersion: 1.5 },
  { expectedAggregateVersion: 2147483648 },
  { optionSetReference: "invalid" },
  { actorReference: id(4) },
  { tenantReference: id(1) },
  { content: {} },
  { observedAt: at },
])("malformed body is InputInvalid before any dependency: %j", async (change) => {
  const h = harness();
  h.request.command = { ...h.body, ...change } as typeof h.body;
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(h.authentication.authorize).not.toHaveBeenCalled();
  expect(mocks.scope).not.toHaveBeenCalled();
});
it("rejects explicit stale root rather than replacing it with current version", async () => {
  const h = harness(2);
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_VERSION_CONFLICT" });
  expect(h.state.committed).toBe(false);
});
it.each(["brandReference", "storeReference"] as const)(
  "denies mismatched selected %s",
  async (key) => {
    const h = harness();
    h.request.expectedScope[key] = id(99);
    await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(mocks.store).not.toHaveBeenCalled();
  },
);
it("missing owning Store is unavailable", async () => {
  const h = harness();
  mocks.scope.mockResolvedValue({
    tenantReference: id(1),
    actorReference: id(4),
    context: { brand: { brandReference: id(2) } },
    selectedStoreReference: null,
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it.each(["current", "capability"] as const)(
  "missing actual %s lease observer fails closed",
  async (which) => {
    const h = harness();
    mocks[which].mockReturnValue({ ...h[which], leaseDeadline: undefined });
    await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(mocks.store).not.toHaveBeenCalled();
  },
);
it("shortens to actual Feature boundary and does not renew it", async () => {
  const h = harness();
  h.state.capabilityDeadline = after(800);
  expect((await h.execute()).content.sourceAggregate.aggregateVersion).toBe(1);
});
it("fails final guard after later Feature boundary expiry", async () => {
  const h = harness();
  h.state.capabilityDeadline = after(800);
  mocks.store.mockImplementation(async (o: Owner, c: typeof h.body) => {
    const result = await h.owner(o, c);
    h.state.now = after(800);
    return result;
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("late permission withdrawal is rejected before host commits", async () => {
  const h = harness();
  mocks.store.mockImplementation(async (o: Owner, c: typeof h.body) => {
    const result = await h.owner(o, c);
    h.state.allowed = false;
    return result;
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(h.state.committed).toBe(false);
});
it("a late host failure cannot return editable content", async () => {
  const h = harness();
  h.state.commitFails = true;
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("captures original body and scope before authentication await", async () => {
  const h = harness();
  const original = { ...h.body };
  h.authentication.authorize.mockImplementation(async () => {
    h.body.optionSetReference = id(99);
    h.request.expectedScope.brandReference = id(99);
    return { sessionReference: id(5) };
  });
  mocks.store.mockImplementation(async (o: Owner, c: typeof h.body) => {
    expect(c).toEqual(original);
    h.body.optionSetReference = id(6);
    return h.owner(o, c);
  });
  expect((await h.execute()).content.sourceAggregate.optionSetReference).toBe(id(6));
});
it("authentication does not renew initial five-second deadline", async () => {
  const h = harness();
  h.authentication.authorize.mockImplementation(async () => {
    h.state.now = after(5000);
    return { sessionReference: id(5) };
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(mocks.store).not.toHaveBeenCalled();
});
it("requires the one owning runner invocation", async () => {
  const h = harness();
  mocks.store.mockImplementation(async (o: Owner, c: typeof h.body) => {
    const result = await h.owner(o, c);
    await h.owner(o, c);
    return result;
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it.each(["sourceDigest", "contentDigest", "configurationDigest"])(
  "rejects substituted %s",
  async (key) => {
    const h = harness();
    mocks.store.mockImplementation(async (o: Owner, c: typeof h.body) => ({
      ...(await h.owner(o, c)),
      [key]: "sha256:" + "0".repeat(64),
    }));
    await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(h.state.committed).toBe(false);
  },
);
it("rejects fabricated reference eligibility", async () => {
  const h = harness();
  mocks.store.mockImplementation(async (o: Owner, c: typeof h.body) => ({
    ...(await h.owner(o, c)),
    referenceEligibility: "Pass",
  }));
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("captures original factory clock and runner", async () => {
  const h = harness();
  h.authentication.authorize.mockImplementation(async () => {
    h.merchant.now = () => after(10000);
    h.merchant.transactions.run = async () => {
      throw Error("replacement runner");
    };
    return { sessionReference: id(5) };
  });
  expect((await h.execute()).content.sourceAggregate.aggregateVersion).toBe(1);
  expect(h.state.committed).toBe(true);
});

it("captures original real ports before the owning read awaits", async () => {
  const h = harness();
  mocks.store.mockImplementation(async (o: Owner, c: typeof h.body) => {
    h.current.authorizeActions = vi.fn(async () => {
      throw Error("replacement authorize");
    });
    h.current.assertCurrent = vi.fn(() => {
      throw Error("replacement assert");
    });
    h.current.leaseDeadline = vi.fn(() => after(0));
    h.capability.holdUntilCommit = vi.fn(async () => {
      throw Error("replacement hold");
    });
    h.capability.leaseDeadline = vi.fn(() => after(0));
    return h.owner(o, c);
  });
  expect((await h.execute()).content.sourceAggregate.aggregateVersion).toBe(1);
});
it("rejects query replacement rather than borrowing another transaction", async () => {
  const h = harness();
  mocks.store.mockImplementation(async (o: Owner, c: typeof h.body) =>
    o.transactions.run(async (tx) => {
      Object.defineProperty(tx, "query", { value: h.tx.query });
      return h.owner(o, c);
    }),
  );
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("malformed owning content is a dependency failure, not browser input", async () => {
  const h = harness();
  mocks.store.mockImplementation(async (o: Owner, c: typeof h.body) => ({
    ...(await h.owner(o, c)),
    content: null,
  }));
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("rejects later backwards source clocks", async () => {
  const h = harness();
  mocks.store.mockImplementation(async (o: Owner, c: typeof h.body) => {
    const result = await h.owner(o, c);
    h.state.now = "2026-10-05T11:59:59.999Z";
    return result;
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
