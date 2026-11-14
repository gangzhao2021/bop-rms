import { expect, it, vi } from "vitest";
import { createIdentityActor } from "@bop/identity";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { createFeatureControlAdministrationDefinition } from "@bop/feature-control";
import { CatalogError } from "@rms/catalog";
import {
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
  type PermissionDecision,
} from "@bop/permission";
import {
  createMerchantProductStoreCapabilityGuard,
  type MerchantProductStoreCapabilityGuardOptions,
} from "./merchant-product-store-capability.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";

const id = (n: number) => `01902421-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-04T12:00:00.000Z";
const after = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
function definition(overrides: Record<string, unknown> = {}) {
  return createFeatureControlAdministrationDefinition({
    controlId: id(6),
    key: "catalog.product.edit",
    description: "Synthetic Product edit control",
    version: 1,
    ownerReference: id(5),
    purposeCode: "PRODUCT_EDIT",
    scope: { kind: "Brand", brandReference: id(2), storeReference: null },
    source: "BrandOverride",
    defaultValue: "Disabled",
    configuredValue: "Enabled",
    lifecycle: "Published",
    temporary: false,
    effectiveFrom: at,
    effectiveUntil: null,
    reviewAt: after(86400000),
    expiresAt: null,
    dependencies: [],
    authoredByReference: id(5),
    approvedByReference: id(7),
    approvalEvidenceReference: id(8),
    publicationReference: id(9),
    ...overrides,
  });
}
const storeDefinition = (overrides: Record<string, unknown> = {}) =>
  definition({
    controlId: id(10),
    scope: { kind: "Store", brandReference: id(2), storeReference: id(3) },
    source: "StoreOverride",
    ...overrides,
  });
const row = (value = definition()) => ({ definition: value, recordedAt: at, dependencies: [] });
function setup(
  values: readonly unknown[] = [row()],
  capabilityKey: NonNullable<
    MerchantProductStoreCapabilityGuardOptions["capabilityKey"]
  > = "catalog.cat_product_edit",
) {
  const state = {
    now: at,
    actorReference: id(4),
    storeReference: id(3),
    allowed: true,
    error: false,
    rows: values,
    badCallback: false,
    doubleCallback: false,
    beforeScope: async (): Promise<void> => undefined,
    registration: async (): Promise<void> => undefined,
  };
  const queries: { sql: string; values: readonly unknown[] }[] = [],
    hooks: { check: () => Promise<void>; final: (() => void) | undefined }[] = [],
    actionCalls: string[][] = [];
  const tx: MerchantProductStoreCapabilityGuardOptions["transaction"] = {
    async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
      queries.push({ sql, values });
      if (state.error) throw Error("private SQL error");
      const rows = sql.includes("pg_catalog.pg_constraint")
        ? [{ complete: true }]
        : sql.includes("FROM bop_feature_control.control_version")
          ? state.rows
          : [];
      return { rows: rows as readonly Row[] };
    },
  };
  const currentAuthorization: MerchantProductStoreCapabilityGuardOptions["currentAuthorization"] = {
    async authorizeActions(requested) {
      actionCalls.push([...requested]);
      if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    },
    async withCurrentStoreScope(input, work) {
      expect(input).toEqual({
        brandReference: id(2),
        storeReference: id(3),
        capabilityKey,
        observedAt: state.now,
      });
      await state.beforeScope();
      if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      const actor = createIdentityActor({
          actorType: "User",
          accountKind: "Workforce",
          actorReference: state.actorReference,
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: "SingleFactor",
          authenticatedAt: at,
          recentMfaAt: null,
        }),
        brand = createBrand({
          brandReference: id(2),
          code: "SYNTHETIC",
          displayName: "Synthetic Brand",
          defaultLocale: "en-CA",
          currencyCode: "CAD",
          lifecycle: "Active",
          version: 1,
          createdAt: at,
          updatedAt: at,
        }),
        store = createStore({
          storeReference: state.storeReference,
          brandReference: id(2),
          code: "SYNTHETIC",
          displayName: "Synthetic Store",
          timeZone: "America/Toronto",
          locale: "en-CA",
          currencyCode: "CAD",
          lifecycle: "Active",
          version: 1,
          createdAt: at,
          updatedAt: at,
        }),
        context = createTenantContext(actor, brand, store, input.observedAt),
        result = await work(context);
      if (state.doubleCallback) await work(context);
      return state.badCallback ? (Object.freeze({ value: result }) as typeof result) : result;
    },
  };
  const options: MerchantProductStoreCapabilityGuardOptions = {
    capabilityKey,
    transaction: tx,
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    clock: { now: () => state.now },
    originalValidUntil: after(5000),
    currentAuthorization,
    async registerBeforeCommit(actual, check, final) {
      expect(actual).toBe(tx);
      hooks.push({ check, final });
      await state.registration();
    },
  };
  const build = () => createMerchantProductStoreCapabilityGuard(options);
  const final = async () => {
    for (const hook of hooks) await hook.check();
    for (const hook of hooks) {
      if (!hook.final) throw Error("Missing synchronous guard");
      expect(hook.final()).toBeUndefined();
    }
  };
  return { state, tx, queries, hooks, actionCalls, options, build, final };
}

it.each([
  ["pricing.price_book_list", "pricing.pricebook.list"],
  ["pricing.price_book_editor", "pricing.pricebook.editor"],
  ["catalog.cat_product_list", "catalog.product.list"],
  ["catalog.cat_product_create", "catalog.product.create"],
  ["catalog.cat_product_detail", "catalog.product.detail"],
  ["catalog.cat_sku_detail", "catalog.sku.detail"],
  ["catalog.cat_optionset_create", "catalog.optionset.create"],
  ["catalog.cat_optionset_detail", "catalog.optionset.detail"],
  ["catalog.cat_optionset_edit", "catalog.optionset.edit"],
  ["catalog.cat_optionset_list", "catalog.optionset.list"],
] as const)(
  "evaluates %s independently of the default Edit control",
  async (capabilityKey, controlKey) => {
    const f = setup([row(definition({ key: controlKey }))], capabilityKey);
    await f.build().holdUntilCommit();
    await f.final();
    expect(
      f.queries.filter(({ sql }) => sql.includes("FROM bop_feature_control.control_version")),
    ).toEqual([{ sql: expect.any(String), values: [id(2), id(3), controlKey] }]);
    const wrong = setup([row()], capabilityKey);
    await expect(wrong.build().holdUntilCommit()).rejects.toThrow();
    expect(() =>
      createMerchantProductStoreCapabilityGuard({
        ...f.options,
        capabilityKey: "catalog.unknown" as never,
      }),
    ).toThrow();
  },
);

it("uses actual owning selection and SQL on the borrowed transaction, with one acquisition", async () => {
  const f = setup([row(), row(storeDefinition())]),
    g = f.build();
  await g.holdUntilCommit();
  const firstCalls = f.actionCalls.length;
  await g.holdUntilCommit();
  expect(f.actionCalls.length).toBeGreaterThan(firstCalls);
  expect(f.actionCalls.every((actions) => actions.join() === "catalog.manage")).toBe(true);
  expect(
    f.queries.filter(({ sql }) => sql.includes("FROM bop_feature_control.control_version")),
  ).toEqual([{ sql: expect.any(String), values: [id(2), id(3), "catalog.product.edit"] }]);
  expect(f.queries.some(({ sql }) => sql.includes("pg_advisory_xact_lock_shared"))).toBe(true);
  expect(f.hooks).toHaveLength(1);
  await f.final();
});

it.each([
  ["missing", []],
  ["disabled Store override", [row(), row(storeDefinition({ configuredValue: "Disabled" }))]],
  [
    "Draft only",
    [
      row(
        definition({
          lifecycle: "Draft",
          approvedByReference: null,
          approvalEvidenceReference: null,
          publicationReference: null,
        }),
      ),
    ],
  ],
  ["future only", [row(definition({ effectiveFrom: after(1000) }))]],
] as const)("refuses %s instead of an enabled default", async (_name, rows) => {
  const f = setup(rows);
  await expect(f.build().holdUntilCommit()).rejects.toBeInstanceOf(
    MerchantProductWriteFeatureDisabled,
  );
  await expect(f.final()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});

it("preserves the owning Brand fallback when a Store proposal is still Draft", async () => {
  const f = setup([
    row(),
    row(
      storeDefinition({
        lifecycle: "Draft",
        approvedByReference: null,
        approvalEvidenceReference: null,
        publicationReference: null,
      }),
    ),
  ]);
  await f.build().holdUntilCommit();
  await f.final();
});

it.each(["CATALOG_DEPENDENCY_UNAVAILABLE", "CATALOG_PERMISSION_DENIED"] as const)(
  "retains the recorded disabled decision through owner sanitization, with %s precedence",
  async (code) => {
    const f = setup([row(definition({ configuredValue: "Disabled" }))]),
      original = f.options.currentAuthorization.withCurrentStoreScope;
    f.options.currentAuthorization.withCurrentStoreScope = async (input, work) => {
      try {
        return await original(input, work);
      } catch {
        // Owning FeatureControl callbacks sanitize consumer errors. The actual
        // Store bridge bounds that owner failure; a real denial still wins.
        throw new CatalogError(code);
      }
    };
    const result = f.build().holdUntilCommit();
    if (code === "CATALOG_PERMISSION_DENIED") await expect(result).rejects.toMatchObject({ code });
    else await expect(result).rejects.toBeInstanceOf(MerchantProductWriteFeatureDisabled);
    await expect(f.final()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);

it("does not fabricate declared dependency evidence", async () => {
  const f = setup([
    {
      ...row(),
      dependencies: [
        {
          storeReference: null,
          definition: {
            dependencyId: id(11),
            kind: "RequiresFutureTrigger",
            targetKey: "catalog.product.future",
            minimumCompatibleVersion: 1,
            status: "Satisfied",
            evidenceReference: id(12),
            evidenceVersion: 1,
          },
        },
      ],
    },
  ]);
  await expect(f.build().holdUntilCommit()).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});

it.each(["actorReference", "storeReference"] as const)(
  "refuses changed %s from current authorization",
  async (key) => {
    const f = setup();
    f.state[key] = id(25);
    await expect(f.build().holdUntilCommit()).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.queries).toHaveLength(0);
  },
);

it.each(["badCallback", "doubleCallback"] as const)(
  "poisons a %s owner contract violation",
  async (key) => {
    const f = setup();
    f.state[key] = true;
    const g = f.build();
    await expect(g.holdUntilCommit()).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    f.state[key] = false;
    await expect(g.holdUntilCommit()).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
  },
);

it("rechecks actual authority before COMMIT and preserves permission denial", async () => {
  const f = setup();
  await f.build().holdUntilCommit();
  f.state.allowed = false;
  await expect(f.final()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
});

it.each([
  ["original five seconds", [row()], 5000],
  ["selected definition expiry", [row(definition({ effectiveUntil: after(2000) }))], 2000],
  [
    "future Store override",
    [row(), row(storeDefinition({ effectiveFrom: after(2000), configuredValue: "Disabled" }))],
    2000,
  ],
] as const)(
  "synchronously refuses %s after later awaited guards consume the original window",
  async (_name, rows, end) => {
    const f = setup([...rows]);
    await f.build().holdUntilCommit();
    for (const hook of f.hooks) await hook.check();
    f.state.now = after(end);
    expect(() => f.hooks[0]?.final?.()).toThrow(CatalogError);
  },
);

it("retains a shorter caller deadline", async () => {
  const f = setup();
  const g = createMerchantProductStoreCapabilityGuard({
    ...f.options,
    originalValidUntil: after(1000),
  });
  await g.holdUntilCommit();
  f.state.now = after(1000);
  await expect(f.final()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});

it("does not restart the clock after a slow guard registration", async () => {
  const f = setup();
  f.state.registration = async () => {
    f.state.now = after(5000);
  };
  await expect(f.build().holdUntilCommit()).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.hooks).toHaveLength(1);
  expect(f.queries).toHaveLength(0);
});

it("installs a rejecting guard for an invalid initial clock", async () => {
  const f = setup();
  f.state.now = "invalid";
  const g = f.build();
  f.state.now = at;
  await expect(g.holdUntilCommit()).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  await expect(f.final()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});

it("a caught clock regression or query replacement cannot regain authority", async () => {
  const f = setup(),
    g = f.build();
  await g.holdUntilCommit();
  f.state.now = after(-1);
  await expect(g.holdUntilCommit()).rejects.toThrow(CatalogError);
  f.state.now = at;
  await expect(f.final()).rejects.toThrow(CatalogError);
  const q = setup(),
    guard = q.build();
  await guard.holdUntilCommit();
  q.tx.query = async () => ({ rows: [] });
  await expect(q.final()).rejects.toThrow(CatalogError);
});

it("captures authorization ports before callers replace their methods", async () => {
  const f = setup(),
    g = f.build();
  const replacement = vi.fn(async () => {
    throw Error("replacement port");
  });
  f.options.currentAuthorization.authorizeActions = replacement;
  await g.holdUntilCommit();
  await f.final();
  expect(replacement).not.toHaveBeenCalled();
});

it("a swallowed reentrant hold poisons the original transaction guard", async () => {
  const f = setup(),
    g = f.build();
  let once = false;
  f.state.beforeScope = async () => {
    if (!once) {
      once = true;
      await g.holdUntilCommit().catch(() => undefined);
    }
  };
  await expect(g.holdUntilCommit()).rejects.toThrow(CatalogError);
  await expect(f.final()).rejects.toThrow(CatalogError);
});

it("rejects final assertion before its async authority check completes", async () => {
  const f = setup();
  await f.build().holdUntilCommit();
  let release: (() => void) | undefined, entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.state.beforeScope = () =>
    new Promise<void>((resolve) => {
      release = resolve;
      entered?.();
    });
  const hook = f.hooks[0];
  if (!hook) throw Error("Missing host guard");
  const pending = hook.check();
  await started;
  expect(() => f.hooks[0]?.final?.()).toThrow(CatalogError);
  if (!release) throw Error("Missing held authority continuation");
  release();
  await expect(pending).rejects.toThrow(CatalogError);
});

it("bounds SQL errors and refuses inconsistent owning scope rows", async () => {
  const f = setup();
  f.state.error = true;
  await expect(f.build().holdUntilCommit()).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  const other = setup([
    row(definition({ scope: { kind: "Brand", brandReference: id(50), storeReference: null } })),
  ]);
  await expect(other.build().holdUntilCommit()).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});

it.each([false, true])(
  "rechecks in a later owning COMMIT guard without repeating FeatureControl SQL, revoked: %s",
  async (revoked) => {
    const f = setup(),
      guard = f.build();
    await guard.holdUntilCommit();
    const queryCount = f.queries.length,
      before = f.actionCalls.length;
    f.hooks.push({
      check: async () => {
        if (revoked) f.state.allowed = false;
        await guard.holdUntilCommit();
      },
      final: () => undefined,
    });
    if (revoked)
      await expect(f.final()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    else {
      await f.final();
      expect(f.actionCalls.length).toBeGreaterThan(before + 1);
      await expect(guard.holdUntilCommit()).rejects.toMatchObject({
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
    }
    expect(f.queries.length).toBe(queryCount);
  },
);

it("observes the real feature expiry and future override boundary without extending it", async () => {
  const f = setup([
    row(),
    row(storeDefinition({ effectiveFrom: after(2000), configuredValue: "Disabled" })),
  ]);
  const guard = f.build();
  expect(() => guard.leaseDeadline?.()).toThrow(CatalogError);
  const fresh = setup([
    row(),
    row(storeDefinition({ effectiveFrom: after(2000), configuredValue: "Disabled" })),
  ]);
  const held = fresh.build();
  await held.holdUntilCommit();
  expect(held.leaseDeadline?.()).toBe(after(2000));
  fresh.state.now = after(1000);
  await held.holdUntilCommit();
  expect(held.leaseDeadline?.()).toBe(after(2000));
  fresh.state.now = after(2000);
  expect(() => held.leaseDeadline?.()).toThrow(CatalogError);
});
it("lease observation refuses a failed capability authority after revalidation", async () => {
  const f = setup([row(definition({ effectiveUntil: after(1500) }))]);
  const guard = f.build();
  await guard.holdUntilCommit();
  expect(guard.leaseDeadline?.()).toBe(after(1500));
  f.state.allowed = false;
  await expect(guard.holdUntilCommit()).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  expect(() => guard.leaseDeadline?.()).toThrow(CatalogError);
});

function fullBatchSetup() {
  const f = setup();
  let fineAllowed = true;
  const packets: (readonly PermissionDecision[])[] = [],
    batches: (readonly string[])[] = [];
  f.options.currentAuthorization.authorizeActionsWithDecisions = async (actions) => {
    batches.push(actions);
    if (!f.state.allowed || !fineAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    // Controlled full owning decisions. This suite tests capability composition;
    // actual owning bridge has its own closed batch/current-policy tests.
    const packet = Object.freeze(
      actions.map((action) =>
        Object.freeze({
          effect: "Allow" as const,
          reason: "ROLE_PERMISSION" as const,
          source: "RolePermission" as const,
          action: parseBusinessAction(action),
          scopeKind: "Brand" as const,
          policySnapshotReference: parsePolicyReference(id(40)),
          policyVersion: parsePolicyVersion(1),
          audit: Object.freeze({
            effect: "Allow" as const,
            reason: "ROLE_PERMISSION" as const,
            source: "RolePermission" as const,
          }),
        }),
      ),
    );
    packets.push(packet);
    return packet;
  };
  return {
    ...f,
    packets,
    batches,
    denyFine: () => {
      fineAllowed = false;
    },
  };
}
const optionActions = Object.freeze([
  "catalog.manage",
  "catalog.option_set.read",
  "catalog.option_set.submit",
]);
async function combined(
  g: ReturnType<typeof createMerchantProductStoreCapabilityGuard>,
  actions: readonly string[] = optionActions,
) {
  if (!g.holdUntilCommitWithDecisions) throw new Error("Missing combined holder");
  return g.holdUntilCommitWithDecisions(actions);
}
it("ready combined hold returns its fresh full batch without an extra standalone manage authorization", async () => {
  const f = fullBatchSetup(),
    g = f.build();
  expect(await g.holdUntilCommit()).toBeUndefined();
  const beforeManage = f.actionCalls.length;
  const first = await combined(g),
    second = await combined(g);
  expect(first).toBe(f.packets[0]);
  expect(second).toBe(f.packets[1]);
  expect(second).not.toBe(first);
  expect(f.batches).toEqual([optionActions, optionActions]);
  expect(f.batches.every(Object.isFrozen)).toBe(true);
  expect(f.actionCalls).toHaveLength(beforeManage);
  await f.final();
  expect(f.actionCalls).toHaveLength(beforeManage + 1); // unchanged COMMIT coarse hold
  expect(f.batches).toHaveLength(2);
});
it("initial combined hold preserves actual Feature source manage checks and its original final guard", async () => {
  const f = fullBatchSetup(),
    g = f.build();
  expect(await combined(g)).toBe(f.packets[0]);
  expect(f.batches).toHaveLength(1);
  expect(f.actionCalls.length).toBeGreaterThan(0);
  expect(
    f.actionCalls.every((actions) => actions.length === 1 && actions[0] === "catalog.manage"),
  ).toBe(true);
  expect(
    f.queries.some((query) => query.sql.includes("FROM bop_feature_control.control_version")),
  ).toBe(true);
  await f.final();
});
it("fine permission refusal poisons combined hold even while standalone manage remains allowed", async () => {
  const f = fullBatchSetup(),
    g = f.build();
  await g.holdUntilCommit();
  f.denyFine();
  await expect(combined(g)).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  await expect(f.final()).rejects.toThrow(CatalogError);
});
it("late authority withdrawal and original expiry are still checked on ready combined holds", async () => {
  const f = fullBatchSetup(),
    g = f.build();
  await combined(g);
  f.state.allowed = false;
  await expect(combined(g)).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  const expired = fullBatchSetup(),
    held = expired.build();
  await combined(held);
  expired.state.now = after(5000);
  await expect(combined(held)).rejects.toThrow(CatalogError);
  expect(expired.batches).toHaveLength(1);
});
it("missing full evidence port remains legacy-compatible but refuses combined invocation", async () => {
  const f = setup(),
    g = f.build();
  await g.holdUntilCommit();
  await expect(combined(g)).rejects.toThrow(CatalogError);
  const legacy = setup();
  await legacy.build().holdUntilCommit();
  await legacy.final();
});
it("combined actions require immutable data and manage; a swallowed reentrant call still poisons", async () => {
  const f = fullBatchSetup(),
    g = f.build();
  await expect(combined(g, ["catalog.option_set.read"])).rejects.toThrow(CatalogError);
  const malformed = fullBatchSetup(),
    guard = malformed.build();
  const actions = ["catalog.manage"];
  Object.defineProperty(actions, "0", { get: () => "catalog.manage", enumerable: true });
  await expect(combined(guard, actions)).rejects.toThrow(CatalogError);
  expect(malformed.batches).toHaveLength(0);
  const reentrant = fullBatchSetup(),
    other = reentrant.build();
  let once = false;
  reentrant.state.beforeScope = async () => {
    if (!once) {
      once = true;
      await combined(other).catch(() => undefined);
    }
  };
  await expect(combined(other)).rejects.toThrow(CatalogError);
  await expect(reentrant.final()).rejects.toThrow(CatalogError);
});

it("combined ready hold completes the actual Store scope before its fresh full Brand batch", async () => {
  const f = fullBatchSetup(),
    order: string[] = [];
  const scopePort = f.options.currentAuthorization.withCurrentStoreScope,
    fullPort = f.options.currentAuthorization.authorizeActionsWithDecisions;
  if (!fullPort) throw new Error("Missing fixture full batch");
  f.options.currentAuthorization.withCurrentStoreScope = async (input, work) => {
    order.push("StoreScopeStart");
    const result = await scopePort(input, work);
    order.push("StoreScopeComplete");
    return result;
  };
  f.options.currentAuthorization.authorizeActionsWithDecisions = async (actions) => {
    order.push("FullBrandBatch");
    return fullPort(actions);
  };
  const g = f.build();
  await g.holdUntilCommit();
  order.length = 0;
  const beforeManage = f.actionCalls.length;
  await combined(g);
  expect(order).toEqual(["StoreScopeStart", "StoreScopeComplete", "FullBrandBatch"]);
  expect(f.actionCalls).toHaveLength(beforeManage);
  await f.final();
});
it("fine withdrawal during the Store scope checkpoint is seen by the subsequent combined full batch", async () => {
  const f = fullBatchSetup(),
    g = f.build();
  await g.holdUntilCommit();
  f.state.beforeScope = async () => {
    f.denyFine();
  };
  await expect(combined(g)).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(f.packets).toHaveLength(0);
  await expect(f.final()).rejects.toThrow(CatalogError);
});

it("initial combined holder authorizes its full Brand batch only after Feature read and final Store checkpoint", async () => {
  const f = fullBatchSetup(),
    order: string[] = [];
  const queryPort = f.tx.query,
    scopePort = f.options.currentAuthorization.withCurrentStoreScope,
    fullPort = f.options.currentAuthorization.authorizeActionsWithDecisions;
  if (!fullPort) throw new Error("Missing fixture full batch");
  f.tx.query = async <Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) => {
    const result = await queryPort<Row>(sql, values);
    if (sql.includes("FROM bop_feature_control.control_version")) order.push("FeatureRead");
    return result;
  };
  f.options.currentAuthorization.withCurrentStoreScope = async (input, work) => {
    const result = await scopePort(input, work);
    order.push("StoreScopeComplete");
    return result;
  };
  f.options.currentAuthorization.authorizeActionsWithDecisions = async (actions) => {
    order.push("FullBrandBatch");
    return fullPort(actions);
  };
  const g = f.build();
  const packet = await combined(g);
  expect(packet).toBe(f.packets[0]);
  expect(f.batches).toHaveLength(1);
  expect(order.indexOf("FeatureRead")).toBeGreaterThanOrEqual(0);
  expect(order.lastIndexOf("StoreScopeComplete")).toBe(order.length - 2);
  expect(order.at(-1)).toBe("FullBrandBatch");
  expect(order.indexOf("FeatureRead")).toBeLessThan(order.lastIndexOf("StoreScopeComplete"));
  await f.final();
});

it("requires actual Pricing permission and rereads it through COMMIT", async () => {
  const f = setup(
    [row(definition({ key: "pricing.pricebook.editor" }))],
    "pricing.price_book_editor",
  );
  const guard = f.build();
  await guard.holdUntilCommit();
  expect(f.actionCalls.every((actions) => actions.join() === "pricing.price-book.manage")).toBe(
    true,
  );
  await expect(guard.holdUntilCommitWithDecisions?.(["catalog.manage"])).rejects.toThrow();
  const revoked = setup(
    [row(definition({ key: "pricing.pricebook.editor" }))],
    "pricing.price_book_editor",
  );
  await revoked.build().holdUntilCommit();
  revoked.state.allowed = false;
  await expect(revoked.final()).rejects.toThrow();
});
