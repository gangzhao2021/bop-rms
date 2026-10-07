import { beforeEach, expect, it, vi } from "vitest";
import { createAuthenticationSession, createIdentityActor } from "@bop/identity";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { createMembership, createStoreAssignment } from "@bop/membership";
import { createFeatureControlAdministrationDefinition } from "@bop/feature-control";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantBrandNavigationRuntime } from "./merchant-brand-navigation-runtime.js";

const ports = vi.hoisted(() => ({ selection: vi.fn(), membership: vi.fn(), policy: vi.fn() }));
vi.mock("@bop/membership", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/membership")>()),
  createPostgresCurrentMembershipSource: (...args: unknown[]) => ports.membership(...args),
}));
vi.mock("@bop/permission", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/permission")>()),
  createPostgresTransactionCurrentPermissionPolicySource: (tx: unknown) => ({
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
type Options = Parameters<typeof createMerchantBrandNavigationRuntime>[0];
type Tx = Options["transaction"];
beforeEach(() => vi.clearAllMocks());
function definition(overrides: Record<string, unknown> = {}) {
  return createFeatureControlAdministrationDefinition({
    controlId: id(6),
    key: "organization.brand.detail",
    description: "Synthetic list control",
    version: 1,
    ownerReference: id(7),
    purposeCode: "BRAND_STORE_TOPOLOGY_DRAFT",
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
function fixture(sessionAge = 1000) {
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
    definitions: [definition()],
    membershipUntil: null as string | null,
    assignmentUntil: null as string | null,
    permissionUntil: null as string | null,
    permissionAction: "organization.manage",
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
        reason: input.action === state.deny ? "DEFAULT_DENY" : "ROLE_PERMISSION",
        source: input.action === state.deny ? "DefaultDeny" : "RolePermission",
        policySnapshotReference: id(30),
        policyVersion: 1,
        audit: {
          effect: input.action === state.deny ? "Deny" : "Allow",
          reason: input.action === state.deny ? "DEFAULT_DENY" : "ROLE_PERMISSION",
          source: input.action === state.deny ? "DefaultDeny" : "RolePermission",
        },
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
      entry: Awaited<ReturnType<ReturnType<typeof createMerchantBrandNavigationRuntime>["read"]>>,
      runtime: ReturnType<typeof createMerchantBrandNavigationRuntime>,
    ) => Promise<void>,
    change?: (options: Options) => Options,
  ) => {
    const completion: { runtime?: ReturnType<typeof createMerchantBrandNavigationRuntime> } = {};
    return host.transactions
      .run(async (tx) => {
        const options: Options = {
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
        const runtime = createMerchantBrandNavigationRuntime(change ? change(options) : options);
        completion.runtime = runtime;
        const entry = await runtime.read();
        await afterRead?.(tx, entry, runtime);
        return entry;
      })
      .then((entry) => {
        if (!completion.runtime) throw new Error("missing runtime");
        completion.runtime.assertFinalized();
        return entry;
      });
  };
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

it("derives the Brand detail link from actual scope with independent Brand Org and Store navigation grants", async () => {
  const f = fixture();
  expect(await f.execute()).toEqual({
    screenId: "ORG-BRAND-DETAIL",
    href: "/app/organization/brands/" + id(2),
  });
  expect(new Set(f.transactions).size).toBe(1);
  expect(
    f.actions.filter((a) => a.action === "organization.manage").every((a) => a.scope === "Brand"),
  ).toBe(true);
  expect(
    f.actions.filter((a) => a.action === "merchant.access").every((a) => a.scope === "Store"),
  ).toBe(true);
  expect(new Set(f.actions.map((a) => a.action))).toEqual(
    new Set(["merchant.access", "organization.manage"]),
  );
});
it.each(["organization.manage", "merchant.access"])(
  "keeps initial %s denial hidden and held through unrelated workspace work",
  async (action) => {
    const f = fixture();
    f.state.deny = action;
    expect(
      await f.execute(async (tx, entry) => {
        expect(entry).toBeNull();
        await tx.query("SELECT unrelated_workspace", []);
      }),
    ).toBeNull();
    expect(f.queries.some((q) => q.sql.includes("control_version"))).toBe(false);
  },
);
it("Store-only Org cannot create a Brand navigation entry", async () => {
  const f = fixture();
  f.state.storeOnly = true;
  expect(await f.execute()).toBeNull();
});
it("Disabled actual Feature definition hides the entry without poisoning workspace", async () => {
  const f = fixture();
  f.state.definitions = [definition({ configuredValue: "Disabled", lifecycle: "Disabled" })];
  expect(
    await f.execute(async (tx, entry) => {
      expect(entry).toBeNull();
      await tx.query("SELECT unrelated_workspace", []);
    }),
  ).toBeNull();
});
it("Missing Feature definition fails closed rather than becoming static phase admission", async () => {
  const f = fixture();
  f.state.definitions = [];
  await expect(f.execute()).rejects.toMatchObject({
    code: "BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE",
  });
});
it.each(["organization.manage", "merchant.access"])(
  "late %s withdrawal rejects a stale positive entry",
  async (action) => {
    const f = fixture();
    await expect(
      f.execute(async () => {
        f.state.deny = action;
      }),
    ).rejects.toBeInstanceOf(Error);
  },
);
it("a denied initial decision cannot silently become Allow during final checks", async () => {
  const f = fixture();
  f.state.deny = "organization.manage";
  await expect(
    f.execute(async () => {
      f.state.deny = "";
    }),
  ).rejects.toBeInstanceOf(Error);
});
it("late real Feature definition change rejects the initial visibility", async () => {
  const f = fixture();
  await expect(
    f.execute(async () => {
      f.state.definitions = [
        definition({ configuredValue: "Disabled", lifecycle: "Disabled", version: 2 }),
      ];
    }),
  ).rejects.toBeInstanceOf(Error);
});
it.each(["actorReference", "tenantReference", "brandReference", "storeReference"])(
  "late %s change rejects captured navigation scope",
  async (key) => {
    const f = fixture();
    await expect(
      f.execute(async () => {
        f.state[key as "actorReference"] = id(90);
      }),
    ).rejects.toBeInstanceOf(Error);
  },
);
it("current association refusal rejects the original session selection", async () => {
  const f = fixture();
  f.state.association = false;
  await expect(f.execute()).rejects.toBeInstanceOf(Error);
});
it("original five-second deadline is never extended by final current evaluation", async () => {
  const f = fixture();
  await expect(
    f.execute(async () => {
      f.state.now = after(5000);
    }),
  ).rejects.toBeInstanceOf(Error);
});
it("full permission and membership natural boundaries shorten held navigation lease", async () => {
  const f = fixture();
  f.state.permissionUntil = after(1000);
  await expect(
    f.execute(async () => {
      f.state.now = after(1000);
    }),
  ).rejects.toBeInstanceOf(Error);
});
it("early final assertion poisons the producer and prevents a second read", async () => {
  const f = fixture();
  await expect(
    f.execute(async (_tx, _entry, runtime) => {
      expect(() => runtime.assertFinalized()).toThrow();
    }),
  ).rejects.toBeInstanceOf(Error);
});
it("one read cannot be repeated on the same session admission", async () => {
  const f = fixture();
  await expect(
    f.execute(async (_tx, _entry, runtime) => {
      await runtime.read();
    }),
  ).rejects.toBeInstanceOf(Error);
});
it("backward clock rejects before finalization", async () => {
  const f = fixture();
  await expect(
    f.execute(async () => {
      f.state.now = after(-1);
    }),
  ).rejects.toBeInstanceOf(Error);
});

it("captured authority port replacement refuses the old entry", async () => {
  const f = fixture();
  const captured: { options?: Options } = {};
  await expect(
    f.execute(
      async () => {
        if (!captured.options) throw new Error("missing options");
        Object.defineProperty(captured.options, "currentActor", {
          value: f.currentActor.bind(null),
          enumerable: true,
        });
      },
      (options) => {
        captured.options = options;
        return options;
      },
    ),
  ).rejects.toBeInstanceOf(Error);
});
it("advancing genuine observation milliseconds remain within the original five seconds", async () => {
  const f = fixture();
  let tick = 0;
  expect(
    await f.execute(undefined, (options) => ({
      ...options,
      now: () => {
        f.state.now = after(++tick);
        return f.state.now;
      },
    })),
  ).toEqual({ screenId: "ORG-BRAND-DETAIL", href: "/app/organization/brands/" + id(2) });
});
