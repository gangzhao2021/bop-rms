import { expect, it, vi } from "vitest";
import { CatalogError, productVariantHistoryFields } from "@rms/catalog";
import { createMerchantProductVariantHistoryAuthority } from "./merchant-product-variant-history-authority.js";
const native = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => native.resolve }));
const id = (n: number) => `01909680-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-01T18:00:00.000Z";
function fixture() {
  const control = {
    at,
    denied: "",
    scopeKind: "Brand",
    wrongAction: false,
    tenant: id(1),
    brand: id(2),
    store: id(3),
    actor: id(4),
  };
  const tx = { query: vi.fn(async () => ({ rows: [] })) };
  const authorize = vi.fn(async (action: string) => ({
    effect: control.denied === action ? "Deny" : "Allow",
    scopeKind: control.scopeKind,
    action: control.wrongAction ? "wrong.action" : action,
  }));
  native.resolve.mockReset();
  native.resolve.mockImplementation(async (actual, cookie, session) => {
    expect(actual).toBe(tx);
    expect(cookie).toBe("synthetic-session");
    expect(session).toBe(id(7));
    return {
      tenantReference: control.tenant,
      context: { brand: { brandReference: control.brand } },
      selectedStoreReference: control.store,
      actorReference: control.actor,
      authorizeAction: authorize,
    };
  });
  const hold = vi.fn(async (): Promise<void> => undefined);
  const options = {
    merchant: { now: () => control.at } as never,
    transaction: tx,
    sessionCookie: "synthetic-session",
    sessionReference: id(7),
    scope: {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      actorReference: id(4),
      productReference: id(8),
    },
    authority: { holdUntilTransactionCompletes: hold },
  };
  const packet = () => ({
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(4),
    purposeCode: "CATALOG_PRODUCT_VARIANT_IDENTITY_HISTORY" as const,
    permission: "catalog.product.history.read" as const,
    request: {
      productReference: id(8),
      expectedAggregateVersion: 1,
      originalIntentDigest: "sha256:" + "a".repeat(64),
    },
    requiredFields: productVariantHistoryFields,
    observedAt: control.at,
  });
  return {
    control,
    tx,
    authorize,
    hold,
    options,
    packet,
    ...createMerchantProductVariantHistoryAuthority(options),
  };
}
it("holds native current Brand and referenced history permissions around independent policy", async () => {
  const f = fixture();
  expect(await f.authority.holdUntilTransactionCompletes(f.tx, f.packet())).toBeUndefined();
  expect(f.authorize.mock.calls.map(([action]) => action)).toEqual([
    "catalog.manage",
    "catalog.product.history.read",
    "catalog.manage",
    "catalog.product.history.read",
  ]);
  expect(f.hold).toHaveBeenCalledTimes(1);
});
it.each(["tenant", "brand", "store", "actor"] as const)(
  "rejects current changed %s before policy",
  async (key) => {
    const f = fixture();
    f.control[key] = id(99);
    await expect(f.authority.holdUntilTransactionCompletes(f.tx, f.packet())).rejects.toMatchObject(
      {
        code: "CATALOG_PERMISSION_DENIED",
      },
    );
    expect(f.hold).not.toHaveBeenCalled();
  },
);
it.each(["catalog.product.history.read", "catalog.manage"])(
  "rejects independent current %s denial",
  async (action) => {
    const f = fixture();
    f.control.denied = action;
    await expect(f.authority.holdUntilTransactionCompletes(f.tx, f.packet())).rejects.toMatchObject(
      {
        code: "CATALOG_PERMISSION_DENIED",
      },
    );
    expect(f.hold).not.toHaveBeenCalled();
  },
);
it.each(["Store", "WrongAction"])(
  "refuses non-Brand or wrong-action permission (%s)",
  async (mode) => {
    const f = fixture();
    if (mode === "Store") f.control.scopeKind = mode;
    else f.control.wrongAction = true;
    await expect(f.authority.holdUntilTransactionCompletes(f.tx, f.packet())).rejects.toMatchObject(
      {
        code: "CATALOG_PERMISSION_DENIED",
      },
    );
    expect(f.hold).not.toHaveBeenCalled();
  },
);
it("rejects referenced grant withdrawn after the awaited field policy and poisons the transaction", async () => {
  const f = fixture();
  f.hold.mockImplementation(async () => {
    f.control.denied = "catalog.manage";
    return undefined;
  });
  await expect(f.authority.holdUntilTransactionCompletes(f.tx, f.packet())).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  f.control.denied = "";
  await expect(f.authority.holdUntilTransactionCompletes(f.tx, f.packet())).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.hold).toHaveBeenCalledTimes(1);
});
it.each(["expiry", "reversal", "query"])(
  "rejects a late %s without renewing source lease",
  async (mode) => {
    const f = fixture();
    f.hold.mockImplementation(async () => {
      if (mode === "query") f.tx.query = vi.fn(async () => ({ rows: [] }));
      else f.control.at = new Date(Date.parse(at) + (mode === "expiry" ? 5000 : -1)).toISOString();
      return undefined;
    });
    await expect(f.authority.holdUntilTransactionCompletes(f.tx, f.packet())).rejects.toMatchObject(
      {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      },
    );
  },
);
it("retains the first transaction deadline across multiple held Read and Write policy calls", async () => {
  const f = fixture();
  await f.authority.holdUntilTransactionCompletes(f.tx, f.packet());
  f.control.at = new Date(Date.parse(at) + 4999).toISOString();
  await f.authority.holdUntilTransactionCompletes(f.tx, f.packet());
  f.control.at = new Date(Date.parse(at) + 5000).toISOString();
  await expect(f.authority.holdUntilTransactionCompletes(f.tx, f.packet())).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.hold).toHaveBeenCalledTimes(2);
});
it.each([
  { actorKind: "System" },
  { requiredFields: [] },
  { purposeCode: "OTHER" },
  { action: "catalog.content-registry.manage" },
])("refuses rebound or incomplete packets before a history grant", async (patch) => {
  const f = fixture();
  await expect(
    f.authority.holdUntilTransactionCompletes(f.tx, { ...f.packet(), ...patch } as never),
  ).rejects.toBeInstanceOf(CatalogError);
  expect(f.hold).not.toHaveBeenCalled();
});
it("does not evaluate source or packet accessors", async () => {
  const f = fixture(),
    getter = vi.fn();
  const packet = { ...f.packet() };
  Object.defineProperty(packet, "observedAt", { enumerable: true, get: getter });
  await expect(f.authority.holdUntilTransactionCompletes(f.tx, packet)).rejects.toBeInstanceOf(
    CatalogError,
  );
  expect(getter).not.toHaveBeenCalled();
  expect(f.hold).not.toHaveBeenCalled();
});
it("requires an independent holder and refuses a foreign transaction", async () => {
  const f = fixture();
  expect(() =>
    createMerchantProductVariantHistoryAuthority({
      ...f.options,
      authority: undefined,
    } as never),
  ).toThrow(CatalogError);
  await expect(
    f.authority.holdUntilTransactionCompletes({ query: f.tx.query }, f.packet()),
  ).rejects.toBeInstanceOf(CatalogError);
  expect(f.hold).not.toHaveBeenCalled();
});

it("captures original scope, holder and session before mutable configuration changes", async () => {
  const f = fixture();
  f.options.scope.brandReference = id(99);
  f.options.sessionReference = id(99);
  f.options.authority.holdUntilTransactionCompletes = vi.fn(async () => {
    throw Error("changed holder must not run");
  });
  await f.authority.holdUntilTransactionCompletes(f.tx, f.packet());
  expect(f.hold).toHaveBeenCalledOnce();
});
it("refuses a returned permission DTO rather than treating it as a held source", async () => {
  const f = fixture();
  f.hold.mockResolvedValue({ effect: "Allow" } as never);
  await expect(f.authority.holdUntilTransactionCompletes(f.tx, f.packet())).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
});
it("rejects a future observation and history request accessors without invoking them", async () => {
  const f = fixture();
  await expect(
    f.authority.holdUntilTransactionCompletes(f.tx, {
      ...f.packet(),
      observedAt: new Date(Date.parse(at) + 1).toISOString(),
    }),
  ).rejects.toBeInstanceOf(CatalogError);
  expect(f.hold).not.toHaveBeenCalled();
  const g = fixture(),
    getter = vi.fn();
  await expect(
    g.authority.holdUntilTransactionCompletes(g.tx, {
      ...g.packet(),
      request: Object.defineProperty({}, "productReference", {
        enumerable: true,
        get: getter,
      }) as never,
    }),
  ).rejects.toBeInstanceOf(CatalogError);
  expect(getter).not.toHaveBeenCalled();
  expect(g.hold).not.toHaveBeenCalled();
});
it("latches a recursive holder failure even if the independent holder catches it", async () => {
  const f = fixture();
  f.hold.mockImplementation(async () => {
    await expect(
      f.authority.holdUntilTransactionCompletes(f.tx, f.packet()),
    ).rejects.toBeInstanceOf(CatalogError);
  });
  await expect(f.authority.holdUntilTransactionCompletes(f.tx, f.packet())).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
  expect(f.hold).toHaveBeenCalledOnce();
});

it("current receipt admission checks the native grant without qualifying current history", async () => {
  const f = fixture();
  await f.assertCurrent(f.tx);
  expect(f.hold).not.toHaveBeenCalled();
  f.control.denied = "catalog.product.history.read";
  await expect(f.assertCurrent(f.tx)).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  f.control.denied = "";
  await expect(f.authority.holdUntilTransactionCompletes(f.tx, f.packet())).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
});
it.each([
  { productReference: id(9) },
  { expectedAggregateVersion: 0 },
  { expectedAggregateVersion: 1001 },
  { originalIntentDigest: "client-history" },
])("refuses a rebound or malformed exact owning history request", async (patch) => {
  const f = fixture();
  await expect(
    f.authority.holdUntilTransactionCompletes(f.tx, {
      ...f.packet(),
      request: { ...f.packet().request, ...patch },
    }),
  ).rejects.toBeInstanceOf(CatalogError);
  expect(f.hold).not.toHaveBeenCalled();
});
it("admission cannot escape the original exclusive deadline", async () => {
  const f = fixture();
  await f.assertCurrent(f.tx);
  f.control.at = new Date(Date.parse(at) + 5000).toISOString();
  await expect(f.assertCurrent(f.tx)).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
});
it("a caught recursive admission denial poisons the enclosing field hold", async () => {
  const f = fixture();
  f.hold.mockImplementation(async () => {
    await expect(f.assertCurrent(f.tx)).rejects.toBeInstanceOf(CatalogError);
  });
  await expect(f.authority.holdUntilTransactionCompletes(f.tx, f.packet())).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
});
