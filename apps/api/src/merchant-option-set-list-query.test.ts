import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  CatalogOptionSetListError,
  parseCatalogReference,
  parseOptionSetListRequest,
  parseOptionSetListView,
  optionSetListFields,
  type createPostgresOptionSetListQueryStore,
} from "@rms/catalog";
import { createMerchantOptionSetListQuery } from "./merchant-option-set-list-query.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  current: vi.fn(),
  capability: vi.fn(),
  read: vi.fn(),
  final: vi.fn(),
  owner: vi.fn(),
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
  createPostgresOptionSetListQueryStore: (o: unknown) => {
    mocks.owner(o);
    return {
      loadInTransaction: (tx: unknown, r: unknown) => mocks.read(o, tx, r),
      assertFinalized: (tx: unknown) => mocks.final(o, tx),
    };
  },
}));
beforeEach(() => vi.clearAllMocks());
const id = (n: number) =>
  parseCatalogReference("01902421-7700-7000-8000-" + n.toString(16).padStart(12, "0"));
const at = "2026-10-05T12:00:00.000Z",
  after = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
type Owner = Parameters<typeof createPostgresOptionSetListQueryStore>[0];
type Tx = Parameters<Owner["authority"]["holdUntilTransactionCompletes"]>[0];
type Proof = Parameters<Owner["authority"]["holdUntilTransactionCompletes"]>[1];
// Controlled IAM/FeatureControl/Catalog ports exercise the actual original
// category host and API composition. These tests are not native owner evidence.
function harness() {
  const state = {
    now: at,
    authorizationDeadline: after(5000),
    featureDeadline: after(5000),
    allowed: true,
    disabled: false,
    committed: false,
    ownerFinal: false,
    failCommit: false,
    readCalls: 0,
    afterRead: (): void => {
      return undefined;
    },
  };
  const current = {
    assertCurrent: vi.fn(() => {
      if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return state.now;
    }),
    authorizeActions: vi.fn(async () => {
      if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return undefined;
    }),
    leaseDeadline: vi.fn(() => state.authorizationDeadline),
    withCurrentStoreScope: vi.fn(),
  };
  const capability = {
    holdUntilCommit: vi.fn(async () => {
      if (state.disabled) throw new MerchantProductWriteFeatureDisabled();
      return undefined;
    }),
    leaseDeadline: vi.fn(() => state.featureDeadline),
  };
  const authentication = { authorize: vi.fn(async () => ({ sessionReference: id(5) })) };
  const tx = { query: vi.fn(async () => ({ rows: [] })) };
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
  const identity = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  };
  const filters = parseOptionSetListRequest({
    locale: "fr-CA",
    search: null,
    lifecycle: null,
    selectionType: null,
    includeArchived: false,
    hasProductBinding: null,
    hasPricingReference: null,
    hasConsumptionReference: null,
    hasConflict: null,
    missingTranslationLocale: null,
    publishingStatus: null,
    sort: "name",
    direction: "ASC",
    limit: 20,
    cursor: null,
  });
  const view = parseOptionSetListView({
    projection: {
      name: "catalog_option_set_search_v1",
      version: 1,
      asOfUtc: at,
      stale: false,
      partial: true,
      sourceGeneration: "sha256:" + "a".repeat(64),
    },
    scope: identity,
    locale: "fr-CA",
    items: [],
    hasMore: false,
    nextCursor: null,
  });
  const options = {
    merchant: merchant as unknown as Parameters<
      typeof createMerchantOptionSetListQuery
    >[0]["merchant"],
    authentication: authentication as unknown as Parameters<
      typeof createMerchantOptionSetListQuery
    >[0]["authentication"],
    cursorKey: new Uint8Array(32).fill(7),
  };
  const request = {
    sessionCookie: "synthetic-session",
    csrf: "synthetic-csrf",
    filters: filters as unknown,
    expectedScope: { brandReference: id(2), storeReference: id(3) },
  };
  mocks.scope.mockResolvedValue({
    tenantReference: id(1),
    actorReference: id(4),
    context: { brand: { brandReference: id(2) } },
    selectedStoreReference: id(3),
  });
  mocks.current.mockReturnValue(current);
  mocks.capability.mockReturnValue(capability);
  const proof = (r: unknown): Proof => ({
    ...identity,
    actorKind: "User",
    permission: "catalog.manage",
    requiredPermissions: ["catalog.manage", "catalog.option_set.read"],
    purposeCode: "CATALOG_OPTION_SET_LIST",
    capability: "catalog.cat_optionset_list",
    requiredFields: optionSetListFields,
    request: parseOptionSetListRequest(r),
    observedAt: state.now,
  });
  mocks.read.mockImplementation(async (o: Owner, actual: Tx, r: unknown) => {
    state.readCalls++;
    await o.authority.holdUntilTransactionCompletes(actual, proof(r));
    await o.registerBeforeCommit(
      actual,
      async () => {
        await o.authority.holdUntilTransactionCompletes(actual, proof(r));
        return undefined;
      },
      () => {
        state.ownerFinal = true;
      },
    );
    state.afterRead();
    return view;
  });
  mocks.final.mockImplementation(() => {
    if (!state.committed || !state.ownerFinal)
      throw new CatalogOptionSetListError("DependencyUnavailable");
    return undefined;
  });
  return {
    state,
    current,
    capability,
    authentication,
    tx,
    options,
    request,
    identity,
    filters,
    view,
    proof,
    execute: () => createMerchantOptionSetListQuery(options)(request),
  };
}
it("returns the parsed owning list only after actual host COMMIT and owner finalization", async () => {
  const h = harness(),
    result = await h.execute();
  expect(result).toEqual(h.view);
  expect(h.state.committed).toBe(true);
  expect(mocks.final).toHaveBeenCalledTimes(1);
  expect(h.tx.query).not.toHaveBeenCalled();
  expect(h.current.authorizeActions).toHaveBeenCalledWith([
    "catalog.manage",
    "catalog.option_set.read",
  ]);
  const actual = mocks.read.mock.calls[0]?.[1];
  expect(mocks.current.mock.calls[0]?.[0].transaction).toBe(actual);
  expect(mocks.capability.mock.calls[0]?.[0].transaction).toBe(actual);
  expect(mocks.scope.mock.calls[0]?.[0]).toBe(actual);
  expect(mocks.current.mock.calls[0]?.[0].capabilityKey).toBe("catalog.cat_optionset_list");
  expect(mocks.capability.mock.calls[0]?.[0].capabilityKey).toBe("catalog.cat_optionset_list");
  expect(mocks.owner.mock.calls[0]?.[0]).toMatchObject({
    ...h.identity,
    originalValidUntil: after(5000),
  });
  expect(result.projection.partial).toBe(true);
});
it.each(["tenantReference", "actorReference", "purposeCode", "observedAt", "unknown"])(
  "rejects browser %s in closed filters before authentication",
  async (key) => {
    const h = harness();
    h.request.filters = { ...h.filters, [key]: id(90) };
    await expect(h.execute()).rejects.toMatchObject({ code: "Invalid" });
    expect(h.authentication.authorize).not.toHaveBeenCalled();
  },
);
it.each([0, 31, 65])("requires an explicit %s-byte key to meet owning bounds", (n) => {
  const h = harness();
  h.options.cursorKey = new Uint8Array(n);
  expect(() => createMerchantOptionSetListQuery(h.options)).toThrow(
    expect.objectContaining({ code: "DependencyUnavailable" }),
  );
  expect(h.authentication.authorize).not.toHaveBeenCalled();
});
it("captures a detached server cursor key", async () => {
  const h = harness(),
    execute = createMerchantOptionSetListQuery(h.options);
  h.options.cursorKey.fill(0);
  await execute(h.request);
  expect(mocks.owner.mock.calls[0]?.[0].cursorKey).toEqual(new Uint8Array(32).fill(7));
});
it.each(["brandReference", "storeReference"] as const)(
  "rejects a changed selected %s before Catalog lookup",
  async (key) => {
    const h = harness();
    h.request.expectedScope[key] = id(90);
    await expect(h.execute()).rejects.toMatchObject({ code: "Denied" });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(h.state.committed).toBe(false);
  },
);
it.each(["current", "capability"] as const)("requires real %s lease access", async (which) => {
  const h = harness();
  mocks[which].mockReturnValue({ ...h[which], leaseDeadline: undefined });
  await expect(h.execute()).rejects.toMatchObject({ code: "DependencyUnavailable" });
  expect(mocks.read).not.toHaveBeenCalled();
});
it("refuses disabled actual List capability", async () => {
  const h = harness();
  h.state.disabled = true;
  await expect(h.execute()).rejects.toMatchObject({ code: "FeatureDisabled" });
  expect(mocks.read).not.toHaveBeenCalled();
  expect(h.state.committed).toBe(false);
});
it("rejects late disabled List capability without releasing tentative results", async () => {
  const h = harness();
  h.state.afterRead = () => {
    h.state.disabled = true;
  };
  await expect(h.execute()).rejects.toMatchObject({ code: "FeatureDisabled" });
  expect(h.state.committed).toBe(false);
  expect(mocks.final).not.toHaveBeenCalled();
});
it("rejects actual fine permission withdrawal at final hold", async () => {
  const h = harness();
  h.state.afterRead = () => {
    h.state.allowed = false;
  };
  await expect(h.execute()).rejects.toMatchObject({ code: "Denied" });
  expect(h.state.committed).toBe(false);
  expect(mocks.final).not.toHaveBeenCalled();
});
it.each(["authorizationDeadline", "featureDeadline"] as const)(
  "enforces the shorter actual %s",
  async (key) => {
    const h = harness();
    h.state[key] = after(1000);
    h.state.afterRead = () => {
      h.state.now = after(1000);
    };
    await expect(h.execute()).rejects.toMatchObject({ code: "DependencyUnavailable" });
    expect(h.state.committed).toBe(false);
  },
);
it("keeps the original five-second clock through source completion", async () => {
  const h = harness();
  h.state.afterRead = () => {
    h.state.now = after(5000);
  };
  await expect(h.execute()).rejects.toMatchObject({ code: "DependencyUnavailable" });
  expect(h.state.committed).toBe(false);
});
it("does not return an owning tentative view if COMMIT fails", async () => {
  const h = harness();
  h.state.failCommit = true;
  await expect(h.execute()).rejects.toMatchObject({ code: "DependencyUnavailable" });
  expect(mocks.final).not.toHaveBeenCalled();
});
it.each(["tenantReference", "brandReference", "storeReference", "actorReference"] as const)(
  "rejects returned foreign %s",
  async (key) => {
    const h = harness();
    mocks.read.mockResolvedValue({ ...h.view, scope: { ...h.identity, [key]: id(99) } });
    await expect(h.execute()).rejects.toMatchObject({ code: "DependencyUnavailable" });
    expect(h.state.committed).toBe(false);
  },
);
it.each([
  { locale: "en-CA" },
  {
    projection: {
      name: "catalog_option_set_search_v1",
      version: 1,
      asOfUtc: at,
      stale: false,
      partial: true,
      sourceGeneration: "a".repeat(64),
    },
  },
  { hasMore: true },
])("rejects an incoherent owning view %j", async (change) => {
  const h = harness();
  mocks.read.mockResolvedValue({ ...h.view, ...change });
  await expect(h.execute()).rejects.toMatchObject({ code: "DependencyUnavailable" });
  expect(h.state.committed).toBe(false);
});
it.each([
  "permission",
  "purposeCode",
  "capability",
  "requiredFields",
  "requiredPermissions",
  "request",
  "actorReference",
])("poisons a mismatched owning %s proof", async (key) => {
  const h = harness();
  mocks.read.mockImplementation(async (o: Owner, actual: Tx, r: unknown) => {
    await o.authority.holdUntilTransactionCompletes(actual, {
      ...h.proof(r),
      [key]: "synthetic-invalid",
    });
    return h.view;
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "DependencyUnavailable" });
  expect(h.state.committed).toBe(false);
});
it("does not admit a proof from another transaction", async () => {
  const h = harness();
  mocks.read.mockImplementation(async (o: Owner, _actual: Tx, r: unknown) => {
    await o.authority.holdUntilTransactionCompletes(
      { query: async () => ({ rows: [] }) },
      h.proof(r),
    );
    return h.view;
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "DependencyUnavailable" });
  expect(h.state.committed).toBe(false);
});
it.each(["Stale", "DependencyUnavailable"] as const)(
  "preserves bounded owning %s without exposing foreign internals",
  async (code) => {
    const h = harness();
    mocks.read.mockRejectedValue(new CatalogOptionSetListError(code));
    await expect(h.execute()).rejects.toMatchObject({
      code,
      message: "Option Set list is unavailable",
    });
    expect(h.state.committed).toBe(false);
  },
);
it("sanitizes unknown dependency failure", async () => {
  const h = harness();
  mocks.read.mockRejectedValue(Error("synthetic private driver detail"));
  await expect(h.execute()).rejects.toMatchObject({
    code: "DependencyUnavailable",
    message: "Option Set list is unavailable",
  });
});
it("rejects unawaited reentry rather than borrowing active admission", async () => {
  const h = harness();
  mocks.read.mockImplementation(async (o: Owner, actual: Tx, r: unknown) => {
    const first = o.authority.holdUntilTransactionCompletes(actual, h.proof(r));
    const second = o.authority.holdUntilTransactionCompletes(actual, h.proof(r));
    await Promise.allSettled([first, second]);
    return h.view;
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "DependencyUnavailable" });
  expect(h.state.committed).toBe(false);
});

it("refuses owner guard registration on a swapped transaction", async () => {
  const h = harness();
  mocks.read.mockImplementation(async (o: Owner) => {
    await o.registerBeforeCommit(
      { query: async () => ({ rows: [] }) },
      async () => {
        return undefined;
      },
      () => {
        return undefined;
      },
    );
    return h.view;
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "DependencyUnavailable" });
  expect(h.state.committed).toBe(false);
  expect(mocks.final).not.toHaveBeenCalled();
});
