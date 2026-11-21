import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantProductAuthoringContextQuery } from "./merchant-product-authoring-context-query.js";
const mocks = vi.hoisted(() => ({ scope: vi.fn(), current: vi.fn(), capability: vi.fn() }));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => mocks.scope }));
vi.mock("./merchant-product-current-authorization.js", () => ({
  createMerchantProductCurrentAuthorization: (options: unknown) => mocks.current(options),
}));
vi.mock("./merchant-product-store-capability.js", () => ({
  createMerchantProductStoreCapabilityGuard: (options: unknown) => mocks.capability(options),
}));
beforeEach(() => vi.clearAllMocks());
const id = (n: number) => "019a2421-0017-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T12:00:00.000Z";
function fixture(action: "Create" | "ReplaceDraft" = "Create") {
  const state = { now: at, deny: false },
    query = vi.fn(async () => ({ rows: [] })),
    tx = { query },
    authentication = { authorize: vi.fn(async () => ({ sessionReference: id(9) })) },
    current = {
      assertCurrent: vi.fn(() => {
        if (state.deny) throw Error("Synthetic identity revoked");
      }),
      authorizeActions: vi.fn(async () => {
        if (state.deny) throw Error("Synthetic permission revoked");
      }),
      withCurrentStoreScope: vi.fn(),
    },
    capability = { holdUntilCommit: vi.fn(async () => undefined) };
  mocks.scope.mockResolvedValue({
    tenantReference: id(1),
    context: { brand: { brandReference: id(2) } },
    actorReference: id(3),
    selectedStoreReference: id(8),
  });
  mocks.current.mockReturnValue(current);
  mocks.capability.mockReturnValue(capability);
  return {
    state,
    query,
    current,
    capability,
    authentication,
    options: {
      merchant: {
        transactions: {
          async run<T>(work: (actual: typeof tx) => Promise<T>) {
            return work(tx);
          },
        },
        now: () => state.now,
      } as never,
      authentication: authentication as never,
    },
    request: {
      command: { action },
      expectedScope: { brandReference: id(2), storeReference: id(8) },
      sessionCookie: "SYNTHETIC_SESSION",
      csrf: "SYNTHETIC_CSRF",
    },
  };
}
it.each(["Create", "ReplaceDraft"] as const)(
  "reads trustworthy minimal %s context through actual adapters without business writes",
  async (action) => {
    const s = fixture(action),
      result = await createMerchantProductAuthoringContextQuery(s.options)(s.request);
    expect(result).toEqual({
      profile: "CatalogProductAuthoringContextV1",
      action,
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      storeReference: id(8),
      observedAt: at,
      validUntil: "2026-10-04T12:00:05.000Z",
    });
    expect(mocks.current.mock.calls[0]?.[0]).toMatchObject({
      capabilityKey:
        action === "Create" ? "catalog.cat_product_create" : "catalog.cat_product_edit",
    });
    expect(s.query.mock.calls).toEqual([]);
    expect(s.current.authorizeActions).toHaveBeenCalledWith([
      "catalog.manage",
      "catalog.product.manage",
      "catalog.product.read",
      "catalog.product.history.read",
    ]);
  },
);
it("refuses caller supplied Tenant or Actor instead of trusting claims", async () => {
  const s = fixture();
  Object.assign(s.request.command, { actorReference: id(99) });
  await expect(createMerchantProductAuthoringContextQuery(s.options)(s.request)).rejects.toThrow();
  expect(s.authentication.authorize).not.toHaveBeenCalled();
});
it("refuses mismatched current Store selection", async () => {
  const s = fixture();
  s.request.expectedScope.storeReference = id(99);
  await expect(createMerchantProductAuthoringContextQuery(s.options)(s.request)).rejects.toThrow();
});
it("does not return identity after current permission revocation", async () => {
  const s = fixture();
  s.state.deny = true;
  await expect(createMerchantProductAuthoringContextQuery(s.options)(s.request)).rejects.toThrow();
});
it("does not renew five-second context after slow authentication", async () => {
  const s = fixture();
  s.authentication.authorize.mockImplementation(async () => {
    s.state.now = "2026-10-04T12:00:05.000Z";
    return { sessionReference: id(9) };
  });
  await expect(createMerchantProductAuthoringContextQuery(s.options)(s.request)).rejects.toThrow();
});
