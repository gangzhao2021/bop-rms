import { expect, it, vi } from "vitest";
import { CatalogError } from "@rms/catalog";
import { createMerchantProductLifecycleCommand } from "./merchant-product-lifecycle-command.js";
// The decode-only runner stops before invoking any owning scope callback.
const currentScope = vi.hoisted(() => ({ resolve: null as null | (() => unknown) }));
vi.mock("./merchant-brand-scope.js", () => ({
  createMerchantBrandScope: () => () => {
    if (!currentScope.resolve) throw new Error("Owning scope cannot run in decode-only unit");
    return currentScope.resolve();
  },
}));
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const command = {
  productReference: id(1),
  skuReference: id(2),
  targetLifecycle: "Suspended",
  expectedAggregateVersion: 3,
  operationReference: id(4),
};
function setup() {
  // Closed decode only: owner SQL/IAM composition is covered by actual persistence fixtures.
  const run = vi.fn(async () => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  });
  const execute = createMerchantProductLifecycleCommand({
    merchant: { transactions: { run }, now: () => "2026-09-29T12:00:00.000Z" } as never,
    authentication: { authorize: async () => ({ sessionReference: id(5) }) } as never,
    auditReference: () => id(6),
  });
  return {
    run,
    post: (value: unknown) =>
      execute({
        sessionCookie: "synthetic",
        csrf: "synthetic",
        command: value,
        expectedScope: { brandReference: id(6), storeReference: id(7) },
      }),
  };
}
it.each(["Suspended", "Discontinued", "Archived", "Draft"])(
  "requires explicit reason before source read for %s",
  async (targetLifecycle) => {
    const f = setup();
    await expect(f.post({ ...command, targetLifecycle })).rejects.toMatchObject({
      code: "CATALOG_INPUT_INVALID",
    });
    expect(f.run).not.toHaveBeenCalled();
  },
);
it.each([
  undefined,
  null,
  "",
  "lower_case",
  "A".repeat(129),
  "REASON\n",
  " REASON",
  "REASON ",
  "REASON:OTHER",
  {},
  1,
])("rejects malformed reason %s before owner read", async (reasonCode) => {
  const f = setup();
  await expect(f.post({ ...command, reasonCode })).rejects.toMatchObject({
    code: "CATALOG_INPUT_INVALID",
  });
  expect(f.run).not.toHaveBeenCalled();
});
it("rejects accessor reason without invoking it", async () => {
  const f = setup(),
    getter = vi.fn(() => "SYNTHETIC");
  const value = Object.defineProperty({ ...command }, "reasonCode", {
    enumerable: true,
    get: getter,
  });
  await expect(f.post(value)).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(getter).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
});
it.each(["SYNTHETIC_REASON", "A".repeat(128)])(
  "passes provided stable reason %s to server authority flow",
  async (reasonCode) => {
    const f = setup();
    await expect(f.post({ ...command, reasonCode })).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.run).toHaveBeenCalledTimes(1);
  },
);
it("keeps reason optional for Activate/Resume target without claiming mutation authorization", async () => {
  const f = setup();
  await expect(f.post({ ...command, targetLifecycle: "Active" })).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.run).toHaveBeenCalledTimes(1);
});

function scopeSetup() {
  const query = vi.fn<
    (
      sql: string,
      values: readonly unknown[],
    ) => Promise<{ rows: readonly unknown[]; rowCount: number }>
  >(async () => ({ rows: [], rowCount: 0 }));
  const run = vi.fn(async (work: (tx: { query: typeof query }) => Promise<unknown>) =>
    work({ query }),
  );
  const scope = {
    tenantReference: id(9),
    selectedStoreReference: id(7),
    actorReference: id(8),
    context: { brand: { brandReference: id(6) } },
    authorizeAction: vi.fn(async (action: string) => ({
      action,
      effect: "Allow",
      scopeKind: "Brand",
    })),
  };
  const authorize = vi.fn(async () => ({ sessionReference: id(5) }));
  currentScope.resolve = () => scope;
  const execute = createMerchantProductLifecycleCommand({
    merchant: { transactions: { run }, now: () => "2026-09-29T12:00:00.000Z" } as never,
    authentication: { authorize } as never,
    auditReference: () => id(10),
    writeAuthority: async () => "Allowed",
  });
  return {
    query,
    run,
    scope,
    authorize,
    post: (expectedScope: unknown, value: unknown = { ...command, targetLifecycle: "Active" }) =>
      execute({ sessionCookie: "synthetic", csrf: "synthetic", command: value, expectedScope }),
  };
}
it.each([
  undefined,
  null,
  {},
  { brandReference: id(6) },
  { brandReference: id(6), storeReference: id(7), tenantReference: id(9) },
  { brandReference: id(6), storeReference: "bad" },
])("rejects malformed scope %s before authority/source", async (expected) => {
  const f = scopeSetup();
  try {
    await expect(f.post(expected)).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  } finally {
    currentScope.resolve = null;
  }
});
it.each([
  { brandReference: id(20), storeReference: id(7) },
  { brandReference: id(6), storeReference: id(21) },
])("denies wrong actual Brand/Store %s before private source", async (expected) => {
  const f = scopeSetup();
  try {
    await expect(f.post(expected)).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(f.query).not.toHaveBeenCalled();
    expect(f.scope.authorizeAction).not.toHaveBeenCalled();
  } finally {
    currentScope.resolve = null;
  }
});
it("denies later server scope drift against the copied original request before Product read", async () => {
  const f = scopeSetup();
  let changed = false;
  f.scope.authorizeAction.mockImplementation(async (action) => {
    if (!changed) {
      f.scope.selectedStoreReference = id(21);
      changed = true;
    }
    return { action, effect: "Allow", scopeKind: "Brand" };
  });
  try {
    await expect(f.post({ brandReference: id(6), storeReference: id(7) })).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    expect(f.query.mock.calls.every(([sql]) => !/rms_catalog\./u.test(String(sql)))).toBe(true);
  } finally {
    currentScope.resolve = null;
  }
});
it("rejects scope injected into command body", async () => {
  const f = scopeSetup();
  try {
    await expect(
      f.post(
        { brandReference: id(6), storeReference: id(7) },
        {
          ...command,
          targetLifecycle: "Active",
          expectedScope: { brandReference: id(6), storeReference: id(7) },
        },
      ),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    expect(f.run).not.toHaveBeenCalled();
  } finally {
    currentScope.resolve = null;
  }
});
