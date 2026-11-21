import { beforeEach, expect, it, vi } from "vitest";
import { CatalogError, parseCatalogReference, parseCatalogInstant } from "@rms/catalog";
import { createMerchantOptionSetAuthoringContextQuery } from "./merchant-option-set-authoring-context-query.js";
import type { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
const mocks = vi.hoisted(() => ({ scope: vi.fn(), current: vi.fn(), capability: vi.fn() }));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => mocks.scope }));
vi.mock("./merchant-product-current-authorization.js", () => ({
  createMerchantProductCurrentAuthorization: (options: unknown) => mocks.current(options),
}));
vi.mock("./merchant-product-store-capability.js", () => ({
  createMerchantProductStoreCapabilityGuard: (options: unknown) => mocks.capability(options),
}));
beforeEach(() => vi.clearAllMocks());
const id = (n: number) =>
    parseCatalogReference("01902421-7600-7000-8000-" + n.toString(16).padStart(12, "0")),
  at = parseCatalogInstant("2026-10-05T12:00:00.000Z");
const after = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
type CapabilityOptions = Parameters<typeof createMerchantProductStoreCapabilityGuard>[0];
// Controlled source ports and the actual original category transaction host;
// native Session/IAM/FeatureControl qualification remains separate acceptance.
function harness(action: "Create" | "Edit" = "Create") {
  const state = {
    now: String(at),
    authorizationDeadline: after(5000),
    featureDeadline: after(5000),
    allowed: true,
    committed: false,
    failCommit: false,
  };
  const current = {
      assertCurrent: vi.fn(() => {
        if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return parseCatalogInstant(state.now);
      }),
      authorizeActions: vi.fn(async () => {
        if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      }),
      leaseDeadline: vi.fn(() => state.authorizationDeadline),
      withCurrentStoreScope: vi.fn(),
    },
    capability = {
      holdUntilCommit: vi.fn(async () => undefined),
      leaseDeadline: vi.fn(() => state.featureDeadline),
    },
    authentication = { authorize: vi.fn(async () => ({ sessionReference: id(5) })) },
    tx = { query: vi.fn(async () => ({ rows: [] })) },
    merchant = {
      now: () => state.now,
      transactions: {
        async run<T>(work: (t: typeof tx) => Promise<T>) {
          const result = await work(tx);
          if (state.failCommit) throw Error("Synthetic COMMIT failure");
          state.committed = true;
          return result;
        },
      },
    },
    options = {
      merchant: merchant as unknown as Parameters<
        typeof createMerchantOptionSetAuthoringContextQuery
      >[0]["merchant"],
      authentication: authentication as unknown as Parameters<
        typeof createMerchantOptionSetAuthoringContextQuery
      >[0]["authentication"],
    },
    body = { action },
    command: unknown = body,
    request = {
      sessionCookie: "synthetic-session",
      csrf: "synthetic-csrf",
      command,
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
  return {
    state,
    current,
    capability,
    authentication,
    tx,
    merchant,
    options,
    request,
    body,
    execute: () => createMerchantOptionSetAuthoringContextQuery(options)(request),
  };
}
it.each(["Create", "Edit"] as const)(
  "returns authoritative %s recovery identity after actual host COMMIT without mutation",
  async (action) => {
    const h = harness(action),
      result = await h.execute();
    expect(h.state.committed).toBe(true);
    expect(result).toEqual({
      profile: "CatalogOptionSetAuthoringContextV1",
      action,
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      actorReference: id(4),
      observedAt: at,
      validUntil: after(5000),
    });
    expect(h.tx.query).not.toHaveBeenCalled();
    expect(h.current.authorizeActions).toHaveBeenCalledWith([
      "catalog.manage",
      "catalog.option_set.read",
    ]);
    expect(mocks.capability.mock.calls[0]?.[0].capabilityKey).toBe(
      action === "Create" ? "catalog.cat_optionset_create" : "catalog.cat_optionset_edit",
    );
    expect(h.capability.holdUntilCommit).toHaveBeenCalledTimes(2);
  },
);
it.each([
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
  "clock",
  "observedAt",
  "content",
  "operationReference",
])("rejects browser %s before authentication", async (key) => {
  const h = harness();
  h.request.command = { ...h.body, [key]: id(99) };
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(h.authentication.authorize).not.toHaveBeenCalled();
});
it("rejects unsupported action and missing action", async () => {
  const h = harness();
  h.request.command = { action: "ReplaceDraft" };
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  const missing = harness();
  missing.request.command = {};
  await expect(missing.execute()).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
});
it.each(["brandReference", "storeReference"] as const)(
  "refuses selected %s mismatch",
  async (key) => {
    const h = harness();
    h.request.expectedScope[key] = id(99);
    await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(h.state.committed).toBe(false);
  },
);
it("missing selected scope fails closed", async () => {
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
  "requires captured actual %s lease accessor",
  async (which) => {
    const h = harness();
    mocks[which].mockReturnValue({ ...h[which], leaseDeadline: undefined });
    await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(h.state.committed).toBe(false);
  },
);
it.each([
  { authorizationDeadline: after(1800), featureDeadline: after(900), expected: after(900) },
  { authorizationDeadline: after(700), featureDeadline: after(2000), expected: after(700) },
])("returns real shortest source deadline %j", async (input) => {
  const h = harness();
  Object.assign(h.state, input);
  expect((await h.execute()).validUntil).toBe(input.expected);
});
it("returns the later before-COMMIT shortening, not the pre-COMMIT bound", async () => {
  const h = harness();
  h.current.authorizeActions.mockImplementation(async () => {
    if (h.current.authorizeActions.mock.calls.length === 2)
      h.state.authorizationDeadline = after(800);
  });
  expect((await h.execute()).validUntil).toBe(after(800));
  expect(h.state.committed).toBe(true);
});
it("observes final lease after the actual COMMIT runner returns", async () => {
  const h = harness(),
    original = h.merchant.transactions.run;
  h.merchant.transactions.run = async (work) => {
    const result = await original(work);
    h.state.featureDeadline = after(600);
    return result;
  };
  expect((await h.execute()).validUntil).toBe(after(600));
});
it("a later observation cannot extend the original shortened lease", async () => {
  const h = harness();
  h.state.featureDeadline = after(700);
  h.current.authorizeActions.mockImplementation(async () => {
    if (h.current.authorizeActions.mock.calls.length === 2) h.state.featureDeadline = after(5000);
  });
  expect((await h.execute()).validUntil).toBe(after(700));
});
it("rejects permission withdrawal before outer COMMIT", async () => {
  const h = harness();
  h.capability.holdUntilCommit.mockImplementation(async () => {
    if (h.capability.holdUntilCommit.mock.calls.length === 2) h.state.allowed = false;
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(h.state.committed).toBe(false);
});
it("later asynchronous source guard expiry prevents COMMIT", async () => {
  const h = harness();
  h.state.featureDeadline = after(600);
  mocks.capability.mockImplementation((o: CapabilityOptions) => {
    let registered = false;
    h.capability.holdUntilCommit.mockImplementation(async () => {
      if (!registered) {
        registered = true;
        await o.registerBeforeCommit(
          o.transaction,
          async () => {
            h.state.now = after(600);
          },
          () => undefined,
        );
      }
    });
    return h.capability;
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("source expiry during actual COMMIT return does not return stale identity", async () => {
  const h = harness(),
    original = h.merchant.transactions.run;
  h.state.featureDeadline = after(800);
  h.merchant.transactions.run = async (work) => {
    const result = await original(work);
    h.state.now = after(800);
    return result;
  };
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(true);
});
it("slow authentication never renews original five seconds", async () => {
  const h = harness();
  h.authentication.authorize.mockImplementation(async () => {
    h.state.now = after(5000);
    return { sessionReference: id(5) };
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(mocks.scope).not.toHaveBeenCalled();
});
it("rejects backwards source clock", async () => {
  const h = harness();
  h.capability.holdUntilCommit.mockImplementation(async () => {
    h.state.now = "2026-10-05T11:59:59.999Z";
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("actual COMMIT failure cannot return cursor identity", async () => {
  const h = harness();
  h.state.failCommit = true;
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("captures browser action and expected scope before authentication awaits", async () => {
  const h = harness();
  h.authentication.authorize.mockImplementation(async () => {
    h.body.action = "Edit";
    h.request.expectedScope.storeReference = id(99);
    return { sessionReference: id(5) };
  });
  expect((await h.execute()).action).toBe("Create");
});
it("captures actual factory clock and runner", async () => {
  const h = harness();
  h.authentication.authorize.mockImplementation(async () => {
    h.merchant.now = () => after(10000);
    h.merchant.transactions.run = async () => {
      throw Error("replacement runner");
    };
    return { sessionReference: id(5) };
  });
  expect((await h.execute()).validUntil).toBe(after(5000));
});
it("captures original actual IAM and capability methods", async () => {
  const h = harness();
  h.capability.holdUntilCommit.mockImplementation(async () => {
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
  });
  expect((await h.execute()).validUntil).toBe(after(5000));
});
it("query substitution is refused by original frozen transaction host", async () => {
  const h = harness();
  mocks.scope.mockImplementation(async (tx: CapabilityOptions["transaction"]) => {
    Object.defineProperty(tx, "query", { value: h.tx.query });
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("a substituted double transaction callback cannot return a successful context", async () => {
  const h = harness();
  h.merchant.transactions.run = async (work) => {
    await work(h.tx);
    return work(h.tx);
  };
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});

it("lease observers must be synchronous and canonical", async () => {
  const h = harness();
  mocks.current.mockReturnValue({ ...h.current, leaseDeadline: async () => after(5000) });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("post-COMMIT source observation failure is bounded", async () => {
  const h = harness();
  h.current.leaseDeadline.mockImplementation(() => {
    if (h.state.committed) throw Error("Synthetic private source failure");
    return h.state.authorizationDeadline;
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(true);
});
