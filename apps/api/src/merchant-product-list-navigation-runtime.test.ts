import { beforeEach, expect, it, vi } from "vitest";
import { createAuthenticationSession, createIdentityActor } from "@bop/identity";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { createMembership, createStoreAssignment } from "@bop/membership";
import { createFeatureControlAdministrationDefinition } from "@bop/feature-control";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantProductListNavigationRuntime } from "./merchant-product-list-navigation-runtime.js";
import { createPersistentMerchantBffService } from "./persistent-merchant-bff.js";

const ports = vi.hoisted(() => ({ selection: vi.fn(), membership: vi.fn(), policy: vi.fn() }));
vi.mock("@bop/membership", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/membership")>()),
  createPostgresCurrentMembershipSource: (...args: unknown[]) => ports.membership(...args),
}));
vi.mock("@bop/permission", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/permission")>()),
  createPostgresCurrentPermissionPolicySource: (tx: unknown) => ({
    authorize: async (input: unknown) => (await ports.policy(tx, input)).decision,
    authorizeWithRoles: (input: unknown) => ports.policy(tx, input),
  }),
}));
vi.mock("./merchant-selected-context.js", () => ({
  createMerchantSelectedContext:
    (
      options: Parameters<
        typeof import("./merchant-selected-context.js").createMerchantSelectedContext
      >[0],
    ) =>
    async (
      tx: unknown,
      session: Parameters<
        ReturnType<typeof import("./merchant-selected-context.js").createMerchantSelectedContext>
      >[1],
    ) => {
      const selected = await ports.selection(tx, session, options.now());
      if (
        !(await options.validateSelection(
          tx as Parameters<typeof options.validateSelection>[0],
          session,
          {
            tenantReference: selected.tenantReference,
            brandReference: selected.context.brand.brandReference,
            storeReference: selected.context.store.storeReference,
          },
          selected.context.resolvedAt,
        ))
      )
        throw Error("Synthetic association rejected");
      return selected;
    },
}));

const id = (n: number) => `01902421-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-04T12:00:00.000Z";
const after = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
type Options = Parameters<typeof createMerchantProductListNavigationRuntime>[0];
type Tx = Options["transaction"];
beforeEach(() => vi.clearAllMocks());
function definition(overrides: Record<string, unknown> = {}) {
  return createFeatureControlAdministrationDefinition({
    controlId: id(6),
    key: "catalog.product.list",
    description: "Synthetic list control",
    version: 1,
    ownerReference: id(7),
    purposeCode: "PRODUCT_LIST",
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
    authoredByReference: id(7),
    approvedByReference: id(8),
    approvalEvidenceReference: id(9),
    publicationReference: id(10),
    ...overrides,
  });
}
function fixture(sessionAge = 1000, target: Options["target"] = "Product") {
  // Controlled Identity/selection/IAM leaves. The actual FeatureControl SQL
  // reader, resolver, session constructors and two-phase host run unchanged.
  const state = {
    now: at,
    deny: "",
    storeOnly: false,
    association: true,
    actorReference: id(4),
    tenantReference: id(1),
    storeReference: id(3),
    brandReference: id(2),
    definitions: [
      definition(
        target === "OptionSet"
          ? { key: "catalog.optionset.list", purposeCode: "CATALOG_OPTION_SET_LIST" }
          : {},
      ),
    ],
    membershipUntil: null as string | null,
    assignmentUntil: null as string | null,
    permissionUntil: null as string | null,
    permissionAction: target === "OptionSet" ? "catalog.option_set.read" : "catalog.product.read",
    sqlError: false,
  };
  const actor = createIdentityActor({
    actorType: "User",
    accountKind: "Workforce",
    actorReference: id(4),
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: after(-sessionAge),
    recentMfaAt: null,
  });
  const session = createAuthenticationSession({
    sessionReference: id(5),
    actor,
    status: "Active",
    policyCode: "WorkforceStandard",
    maxActiveSessions: 5,
    idleTimeoutMinutes: 30,
    absoluteTimeoutMinutes: 720,
    version: 1,
    authenticatedAt: after(-sessionAge),
    createdAt: after(-sessionAge),
    lastSeenAt: after(-sessionAge),
    idleExpiresAt: after(1800000 - sessionAge),
    absoluteExpiresAt: after(43200000 - sessionAge),
    rotatedFromSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  });
  const brand = (reference = id(2)) =>
    createBrand({
      brandReference: reference,
      code: "SYNTHETIC",
      displayName: "Synthetic Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: after(-1000),
      updatedAt: after(-1000),
    });
  const store = (reference = id(3), parent = id(2)) =>
    createStore({
      storeReference: reference,
      brandReference: parent,
      code: "SYNTHETIC",
      displayName: "Synthetic Store",
      timeZone: "America/Toronto",
      locale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: after(-1000),
      updatedAt: after(-1000),
    });
  const selected = {
    tenantReference: id(1),
    context: createTenantContext(actor, brand(), store(), at),
  };
  const queries: { sql: string; values: readonly unknown[] }[] = [],
    actions: { action: string; scope: string }[] = [],
    transactions: unknown[] = [];
  const rawTx: Tx = {
    async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
      queries.push({ sql, values });
      if (state.sqlError) throw Error("private database failure");
      const rows = sql.includes("pg_catalog.pg_constraint")
        ? [{ complete: true }]
        : sql.includes("FROM bop_feature_control.control_version")
          ? state.definitions
              .filter((d) => d.key === values[2])
              .map((d) => ({ definition: d, recordedAt: at, dependencies: [] }))
          : [];
      return { rows: rows as unknown as readonly Row[] };
    },
  };
  ports.selection.mockImplementation(async (tx, _session, instant) => {
    transactions.push(tx);
    return {
      tenantReference: state.tenantReference,
      context: createTenantContext(
        actor,
        brand(state.brandReference),
        store(state.storeReference, state.brandReference),
        instant,
      ),
    };
  });
  ports.membership.mockImplementation((tx) => {
    transactions.push(tx);
    const membership = createMembership(
      {
        membershipReference: id(11),
        actorReference: id(4),
        brandReference: id(2),
        workforceRelationshipReference: id(12),
        lifecycle: "Active",
        effectiveFrom: after(-1000),
        effectiveUntil: state.membershipUntil,
        version: 1,
        createdAt: after(-1000),
        updatedAt: after(-1000),
      },
      actor,
    );
    return {
      async findMemberships() {
        return [membership];
      },
      async findStoreAssignments() {
        return [
          createStoreAssignment(
            {
              storeAssignmentReference: id(13),
              membershipReference: id(11),
              actorReference: id(4),
              brandReference: id(2),
              storeReference: id(3),
              lifecycle: "Active",
              effectiveFrom: after(-1000),
              effectiveUntil: state.assignmentUntil,
              version: 1,
              createdAt: after(-1000),
              updatedAt: after(-1000),
            },
            membership,
            store(),
          ),
        ];
      },
    };
  });
  ports.policy.mockImplementation(async (tx, input) => {
    transactions.push(tx);
    actions.push({ action: input.action, scope: input.tenantContext.scopeKind });
    return {
      decision: {
        effect: input.action === state.deny ? "Deny" : "Allow",
        action: input.action,
        scopeKind: state.storeOnly ? "Store" : input.tenantContext.scopeKind,
      },
      activeRoleCodes: [],
      validUntil: input.action === state.permissionAction ? state.permissionUntil : null,
    };
  });
  const currentActor: Options["currentActor"] = vi.fn(
    async (tx, reference, authenticatedAt, observedAt) => {
      transactions.push(tx);
      expect(reference).toBe(id(4));
      expect(authenticatedAt).toBe(session.authenticatedAt);
      expect(observedAt).toBe(state.now);
      return createIdentityActor({ ...actor, actorReference: state.actorReference });
    },
  );
  const validateAssociation: Options["validateAssociation"] = vi.fn(async (tx) => {
    transactions.push(tx);
    return state.association;
  });
  const host = createMerchantCategoryTransactions({
    async run(work) {
      return work(rawTx);
    },
  });
  const execute = (
    afterRead?: (
      tx: Tx,
      allowed: boolean,
      runtime: ReturnType<typeof createMerchantProductListNavigationRuntime>,
    ) => Promise<void>,
    change?: (options: Options) => Options,
  ) =>
    host.transactions.run(async (tx) => {
      const options: Options = {
        ...(target === "OptionSet" ? { target } : {}),
        transaction: tx,
        session,
        selected,
        now: () => state.now,
        currentActor,
        validateAssociation,
        observedAt: at,
        validUntil: after(5000),
        registerBeforeCommit: host.registerBeforeCommit,
      };
      const runtime = createMerchantProductListNavigationRuntime(
        change ? change(options) : options,
      );
      const allowed = await runtime.allows();
      await afterRead?.(tx, allowed, runtime);
      return allowed;
    });
  return {
    state,
    queries,
    actions,
    transactions,
    rawTx,
    currentActor,
    validateAssociation,
    host,
    execute,
    session,
    selected,
  };
}

it("uses actual session/selection and full Brand permissions with one same-transaction List definition load", async () => {
  const f = fixture();
  await expect(
    f.execute(async (tx, shown) => {
      expect(shown).toBe(true);
      await tx.query("SELECT workspace_after_navigation", []);
    }),
  ).resolves.toBe(true);
  expect(new Set(f.transactions).size).toBe(1);
  expect(
    f.actions.filter((a) => a.action !== "merchant.access").every((a) => a.scope === "Brand"),
  ).toBe(true);
  expect(new Set(f.actions.map((a) => a.action))).toEqual(
    new Set([
      "merchant.access",
      "catalog.manage",
      "catalog.product.manage",
      "catalog.product.read",
      "catalog.sku.read",
    ]),
  );
  expect(
    f.queries.filter((q) => q.sql.includes("FROM bop_feature_control.control_version")),
  ).toEqual([{ sql: expect.any(String), values: [id(2), id(3), "catalog.product.list"] }]);
  expect(f.queries.some((q) => q.sql.includes("pg_advisory_xact_lock_shared"))).toBe(true);
  expect(f.currentActor).toHaveBeenCalledTimes(2);
});

it.each([
  "catalog.manage",
  "catalog.product.manage",
  "catalog.product.read",
  "catalog.sku.read",
  "merchant.access",
])("hides initial %s denial without poisoning unrelated workspace work", async (action) => {
  const f = fixture();
  f.state.deny = action;
  await expect(
    f.execute(async (tx, allowed) => {
      expect(allowed).toBe(false);
      await tx.query("SELECT other_workspace", []);
    }),
  ).resolves.toBe(false);
  expect(f.queries.some((q) => q.sql.includes("control_version"))).toBe(false);
});

it("refuses selected Store grants as a substitute for complete Brand list access", async () => {
  const f = fixture();
  f.state.storeOnly = true;
  await expect(f.execute()).resolves.toBe(false);
});

it("uses the current clock for each Brand action after an earlier asynchronous decision", async () => {
  const f = fixture(),
    authorize = ports.policy.getMockImplementation();
  if (!authorize) throw Error("Missing controlled owner");
  ports.policy.mockImplementation(async (tx, input) => {
    const result = await authorize(tx, input);
    if (input.action === "catalog.product.manage") f.state.now = after(1000);
    if (input.action === "catalog.product.read") {
      expect(input.tenantContext.resolvedAt).toBe(after(1000));
      return { ...result, decision: { ...result.decision, effect: "Deny" } };
    }
    return result;
  });
  await expect(f.execute()).resolves.toBe(false);
});

it.each(["missing", "disabled", "future"])(
  "hides %s definitions with no Enabled fallback",
  async (mode) => {
    const f = fixture();
    f.state.definitions =
      mode === "missing"
        ? []
        : [
            definition(
              mode === "disabled"
                ? { configuredValue: "Disabled" }
                : { effectiveFrom: after(1000) },
            ),
          ];
    await expect(f.execute()).resolves.toBe(false);
  },
);

it("rejects late catalog revocation after later workspace reads", async () => {
  const f = fixture();
  await expect(
    f.execute(async (tx) => {
      await tx.query("SELECT another_store_candidate", []);
      f.state.deny = "catalog.sku.read";
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});

it.each(["actor", "tenant", "brand", "store", "association"])(
  "rejects late %s identity/association changes",
  async (change) => {
    const f = fixture();
    await expect(
      f.execute(async () => {
        if (change === "actor") f.state.actorReference = id(80);
        else if (change === "tenant") f.state.tenantReference = id(80);
        else if (change === "brand") f.state.brandReference = id(80);
        else if (change === "store") f.state.storeReference = id(80);
        else f.state.association = false;
      }),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);

it.each(["definition", "future override", "membership", "assignment", "session"])(
  "keeps the original %s boundary through the global final phase",
  async (kind) => {
    const f = fixture(kind === "session" ? 1799000 : 1000);
    if (kind === "definition") f.state.definitions = [definition({ effectiveUntil: after(1000) })];
    if (kind === "future override")
      f.state.definitions.push(
        definition({ controlId: id(80), effectiveFrom: after(1000), configuredValue: "Disabled" }),
      );
    if (kind === "membership") f.state.membershipUntil = after(1000);
    if (kind === "assignment") f.state.assignmentUntil = after(1000);
    await expect(
      f.execute(async (tx) => {
        await f.host.registerBeforeCommit(
          tx,
          async () => {
            f.state.now = after(1000);
          },
          () => undefined,
        );
      }),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);

it.each([
  ["grant expiry", "catalog.product.read"],
  ["future Deny", "merchant.access"],
] as const)(
  "retains the owning %s boundary after later asynchronous commit guards",
  async (_kind, action) => {
    const f = fixture();
    // This is the additive, validated Permission source lease, not a calculated
    // navigation timeout. Native coverage supplies the actual locked policy rows.
    f.state.permissionAction = action;
    f.state.permissionUntil = after(1000);
    await expect(
      f.execute(async (tx, shown) => {
        expect(shown).toBe(true);
        await f.host.registerBeforeCommit(
          tx,
          async () => {
            f.state.now = after(1000);
          },
          () => undefined,
        );
      }),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);

it("does not renew the five-second lease or clear a caught duplicate admission", async () => {
  const f = fixture();
  await expect(
    f.execute(async () => {
      f.state.now = after(5000);
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  const other = fixture();
  await expect(
    other.execute(async (_tx, _allowed, runtime) => {
      await expect(runtime.allows()).rejects.toThrow("MERCHANT_BFF_UNAVAILABLE");
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});

it("does not downgrade malformed/failed SQL to hidden navigation", async () => {
  const f = fixture();
  f.state.sqlError = true;
  await expect(f.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});

it("captures configured owner methods before asynchronous work", async () => {
  const f = fixture();
  await expect(
    f.execute(undefined, (options) => {
      const saved = options.currentActor;
      const changed = { ...options };
      changed.currentActor = async (...args) => {
        changed.currentActor = async () => {
          throw Error("replacement must not run");
        };
        changed.validateAssociation = async () => false;
        return saved(...args);
      };
      return changed;
    }),
  ).resolves.toBe(true);
});

it("rejects mixed current-runtime and externally supplied navigation holders", () => {
  expect(() =>
    createPersistentMerchantBffService({
      now: () => at,
      currentActor: async () => undefined,
      validateAssociation: async () => true,
      catalogProductNavigation: {
        currentRuntime: true,
        holdUntilTransactionCompletes: async () => undefined,
      },
    } as never),
  ).toThrow();
});

// The controlled IAM leaves are shared with Product; the real Option owning
// binding and FeatureControl reader/resolver select only the Option control.
it("admits Option List only with its owning Brand read grants and independent control", async () => {
  const f = fixture(1000, "OptionSet");
  await expect(f.execute()).resolves.toBe(true);
  expect(new Set(f.actions.map((a) => a.action))).toEqual(
    new Set(["merchant.access", "catalog.manage", "catalog.option_set.read"]),
  );
  expect(
    f.actions.filter((a) => a.action !== "merchant.access").every((a) => a.scope === "Brand"),
  ).toBe(true);
  expect(
    f.queries.filter((q) => q.sql.includes("FROM bop_feature_control.control_version")),
  ).toEqual([{ sql: expect.any(String), values: [id(2), id(3), "catalog.optionset.list"] }]);
  expect(new Set(f.transactions).size).toBe(1);
  expect(f.currentActor).toHaveBeenCalledTimes(2);
});
it.each(["catalog.product.manage", "catalog.product.read", "catalog.sku.read"])(
  "Option does not require unrelated %s",
  async (action) => {
    const f = fixture(1000, "OptionSet");
    f.state.deny = action;
    await expect(f.execute()).resolves.toBe(true);
    expect(f.actions.some((a) => a.action === action)).toBe(false);
  },
);
it.each(["catalog.manage", "catalog.option_set.read", "merchant.access"])(
  "hides initial Option %s denial while other work remains usable",
  async (action) => {
    const f = fixture(1000, "OptionSet");
    f.state.deny = action;
    await expect(
      f.execute(async (tx, shown) => {
        expect(shown).toBe(false);
        await tx.query("SELECT unrelated_workspace", []);
      }),
    ).resolves.toBe(false);
    expect(f.queries.some((q) => q.sql.includes("control_version"))).toBe(false);
  },
);
it.each(["missing", "disabled", "Product only"])(
  "Option %s definition never defaults to Enabled",
  async (mode) => {
    const f = fixture(1000, "OptionSet");
    f.state.definitions =
      mode === "missing"
        ? []
        : [
            definition(
              mode === "disabled"
                ? {
                    key: "catalog.optionset.list",
                    purposeCode: "CATALOG_OPTION_SET_LIST",
                    configuredValue: "Disabled",
                  }
                : {},
            ),
          ];
    await expect(f.execute()).resolves.toBe(false);
  },
);
it("rejects late Option fine permission withdrawal before commit", async () => {
  const f = fixture(1000, "OptionSet");
  await expect(
    f.execute(async () => {
      f.state.deny = "catalog.option_set.read";
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it.each(["actor", "tenant", "brand", "store", "association"])(
  "poisons late Option %s identity changes",
  async (change) => {
    const f = fixture(1000, "OptionSet");
    await expect(
      f.execute(async () => {
        if (change === "actor") f.state.actorReference = id(80);
        else if (change === "tenant") f.state.tenantReference = id(80);
        else if (change === "brand") f.state.brandReference = id(80);
        else if (change === "store") f.state.storeReference = id(80);
        else f.state.association = false;
      }),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
it.each(["definition", "membership", "assignment", "permission", "session"])(
  "Option retains original %s expiry through finalization",
  async (kind) => {
    const f = fixture(kind === "session" ? 1799000 : 1000, "OptionSet");
    if (kind === "definition")
      f.state.definitions = [
        definition({
          key: "catalog.optionset.list",
          purposeCode: "CATALOG_OPTION_SET_LIST",
          effectiveUntil: after(1000),
        }),
      ];
    if (kind === "membership") f.state.membershipUntil = after(1000);
    if (kind === "assignment") f.state.assignmentUntil = after(1000);
    if (kind === "permission") f.state.permissionUntil = after(1000);
    await expect(
      f.execute(async (tx, shown) => {
        expect(shown).toBe(true);
        await f.host.registerBeforeCommit(
          tx,
          async () => {
            f.state.now = after(1000);
          },
          () => undefined,
        );
      }),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
it("Option rejects expired five-second admission and caught repeated admission", async () => {
  const f = fixture(1000, "OptionSet");
  await expect(
    f.execute(async () => {
      f.state.now = after(5000);
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  const other = fixture(1000, "OptionSet");
  await expect(
    other.execute(async (_tx, _shown, runtime) => {
      await expect(runtime.allows()).rejects.toThrow("MERCHANT_BFF_UNAVAILABLE");
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("Option selected Store grants cannot substitute for owning Brand read rights", async () => {
  const f = fixture(1000, "OptionSet");
  f.state.storeOnly = true;
  await expect(f.execute()).resolves.toBe(false);
});
it("explicit Product target preserves the default Product actions and control", async () => {
  const f = fixture();
  await expect(f.execute(undefined, (o) => ({ ...o, target: "Product" }))).resolves.toBe(true);
  expect(new Set(f.actions.map((a) => a.action))).toEqual(
    new Set([
      "merchant.access",
      "catalog.manage",
      "catalog.product.manage",
      "catalog.product.read",
      "catalog.sku.read",
    ]),
  );
  expect(
    f.queries.find((q) => q.sql.includes("FROM bop_feature_control.control_version"))?.values,
  ).toEqual([id(2), id(3), "catalog.product.list"]);
});

it.each([null, "Unknown", false])("refuses a noncanonical server target %j", async (target) => {
  const f = fixture();
  await expect(
    f.execute(undefined, (o) =>
      Object.defineProperty({ ...o }, "target", { value: target, enumerable: true }),
    ),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.actions).toEqual([]);
});
it("Option retains the future definition transition under its original final guard", async () => {
  const f = fixture(1000, "OptionSet");
  f.state.definitions.push(
    definition({
      key: "catalog.optionset.list",
      purposeCode: "CATALOG_OPTION_SET_LIST",
      controlId: id(80),
      effectiveFrom: after(1000),
      configuredValue: "Disabled",
    }),
  );
  await expect(
    f.execute(async (tx, shown) => {
      expect(shown).toBe(true);
      await f.host.registerBeforeCommit(
        tx,
        async () => {
          f.state.now = after(1000);
        },
        () => undefined,
      );
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
