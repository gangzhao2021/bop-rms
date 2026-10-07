import { beforeEach, expect, it, vi } from "vitest";
import {
  buildCatalogProductAuthoringResolution,
  productAuthoringResolutionFields,
  type ProductAuthoringResolutionStoreOptions,
} from "@rms/catalog";
import { createMerchantProductAuthoringResolutionCommand } from "./merchant-product-authoring-resolution-command.js";
const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  store: vi.fn(),
  current: vi.fn(),
  capability: vi.fn(),
}));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => mocks.scope }));
vi.mock("./merchant-product-current-authorization.js", () => ({
  createMerchantProductCurrentAuthorization: (options: unknown) => mocks.current(options),
}));
vi.mock("./merchant-product-store-capability.js", () => ({
  createMerchantProductStoreCapabilityGuard: (options: unknown) => mocks.capability(options),
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresProductAuthoringResolutionStore: (options: unknown) => ({
    execute: (command: unknown) => mocks.store(options, command),
  }),
}));
beforeEach(() => vi.clearAllMocks());
const id = (n: number) => "019a2421-0016-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T12:00:00.000Z";
type Command = Parameters<
  ProductAuthoringResolutionStoreOptions["authority"]["holdUntilTransactionCompletes"]
>[1]["command"];
function fixture(
  action: "Create" | "ReplaceDraft" = "Create",
  outcome: "Committed" | "Abandoned" = "Committed",
) {
  const body = {
    profile: "CatalogProductAuthoringResolutionRequestV1",
    tenantReference: id(1),
    action,
    operationReference: id(4),
    productReference: action === "Create" ? null : id(5),
    expectedAggregateVersion: action === "Create" ? null : 7,
  };
  const state = { now: at, deny: false },
    tx = { query: vi.fn(async () => ({ rows: [] })) },
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
  let actualTx:
    | Parameters<
        ProductAuthoringResolutionStoreOptions["authority"]["holdUntilTransactionCompletes"]
      >[0]
    | undefined;
  mocks.scope.mockImplementation(
    async (
      actual: Parameters<
        ProductAuthoringResolutionStoreOptions["authority"]["holdUntilTransactionCompletes"]
      >[0],
    ) => {
      actualTx = actual;
      return {
        tenantReference: id(1),
        context: { brand: { brandReference: id(2) } },
        actorReference: id(3),
        selectedStoreReference: id(8),
      };
    },
  );
  mocks.current.mockReturnValue(current);
  mocks.capability.mockReturnValue(capability);
  mocks.store.mockImplementation(
    async (options: ProductAuthoringResolutionStoreOptions, command: Command) =>
      options.transactions.run(async (actual) => {
        expect(actual).toBe(actualTx);
        await options.authority.holdUntilTransactionCompletes(actual, {
          command,
          purposeCode: "CATALOG_PRODUCT_AUTHORING_OPERATION_RESOLUTION",
          permission: "catalog.manage",
          requiredPermissions: [
            "catalog.manage",
            "catalog.product.manage",
            "catalog.product.read",
            "catalog.product.history.read",
          ],
          requiredFields: productAuthoringResolutionFields,
          requiredScope: "FullBrandScope",
          actorKind: "User",
          observedAt: at,
        });
        return buildCatalogProductAuthoringResolution({
          command,
          outcome,
          productReference: outcome === "Committed" ? id(5) : command.productReference,
          versionReference: outcome === "Committed" ? id(6) : null,
          aggregateVersion: outcome === "Committed" ? (action === "Create" ? 1 : 8) : null,
          originalIntentDigest: outcome === "Committed" ? "sha256:" + "1".repeat(64) : null,
          recordedAt: at,
        });
      }),
  );
  const options = {
    merchant: {
      transactions: {
        async run<T>(work: (actual: typeof tx) => Promise<T>) {
          return work(tx);
        },
      },
      now: () => state.now,
    } as never,
    authentication: authentication as never,
    auditReference: () => id(90),
  };
  return {
    state,
    body,
    options,
    current,
    capability,
    authentication,
    request: {
      command: body,
      expectedScope: { brandReference: id(2), storeReference: id(8) },
      sessionCookie: "SYNTHETIC_SESSION",
      csrf: "SYNTHETIC_CSRF",
    },
  };
}
it.each(["Create", "ReplaceDraft"] as const)(
  "resolves %s through actual current-runtime adapters and owning transaction",
  async (action) => {
    const s = fixture(action),
      result = await createMerchantProductAuthoringResolutionCommand(s.options)(s.request);
    expect(result).toMatchObject({
      storeReference: id(8),
      resolution: {
        outcome: "Committed",
        command: { actorReference: id(3), action },
        aggregateVersion: action === "Create" ? 1 : 8,
      },
    });
    expect(mocks.current.mock.calls[0]?.[0]).toMatchObject({
      capabilityKey:
        action === "Create" ? "catalog.cat_product_create" : "catalog.cat_product_edit",
    });
    expect(s.current.authorizeActions).toHaveBeenCalledWith([
      "catalog.manage",
      "catalog.product.manage",
      "catalog.product.read",
      "catalog.product.history.read",
    ]);
  },
);
it("an uncreated Create abandonment never invents Product or Version", async () => {
  const s = fixture("Create", "Abandoned"),
    result = await createMerchantProductAuthoringResolutionCommand(s.options)(s.request);
  expect(result.resolution).toMatchObject({
    outcome: "Abandoned",
    productReference: null,
    versionReference: null,
    aggregateVersion: null,
  });
});
it("rejects stale Tenant cursor under a different actual session without resolving original", async () => {
  const s = fixture();
  s.body.tenantReference = id(99);
  await expect(
    createMerchantProductAuthoringResolutionCommand(s.options)(s.request),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(mocks.store).not.toHaveBeenCalled();
});
it("does not permit caller Actor claims or full Draft bodies in recovery", async () => {
  const s = fixture();
  Object.assign(s.body, { actorReference: id(99), draft: {} });
  await expect(
    createMerchantProductAuthoringResolutionCommand(s.options)(s.request),
  ).rejects.toThrow();
  expect(s.authentication.authorize).not.toHaveBeenCalled();
  expect(mocks.store).not.toHaveBeenCalled();
});
it("current permission loss refuses outcome resolution", async () => {
  const s = fixture();
  s.state.deny = true;
  await expect(
    createMerchantProductAuthoringResolutionCommand(s.options)(s.request),
  ).rejects.toThrow();
});
it("original deadline covers authentication as well as owning work", async () => {
  const s = fixture();
  s.authentication.authorize.mockImplementation(async () => {
    s.state.now = "2026-10-04T12:00:05.000Z";
    return { sessionReference: id(9) };
  });
  await expect(
    createMerchantProductAuthoringResolutionCommand(s.options)(s.request),
  ).rejects.toThrow();
  expect(mocks.store).not.toHaveBeenCalled();
});
