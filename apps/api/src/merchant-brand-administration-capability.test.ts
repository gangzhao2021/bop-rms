import { expect, it } from "vitest";
import { createIdentityActor } from "@bop/identity";
import {
  createBrand,
  createStore,
  createTenantContext,
  createBrandAdministrationContext,
  parseBrandAdministrationContext,
  parseStoreReference,
  parseCanonicalInstant,
} from "@bop/tenant";
import {
  evaluatePermission,
  evaluateBrandAdministrationPermission,
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
  parseRoleReference,
  parseEvidenceReference,
} from "@bop/permission";
import { createFeatureControlAdministrationDefinition } from "@bop/feature-control";
import { BrandConfigurationOperationError, type BrandConfigurationActorScope } from "@bop/tenant";
import {
  createMerchantBrandAdministrationCapability,
  createMerchantCurrentBrandAdministrationCapability,
  type MerchantCurrentBrandAdministrationCapabilityOptions,
  MerchantBrandAdministrationFeatureDisabled,
  type MerchantBrandAdministrationCapabilityOptions,
} from "./merchant-brand-administration-capability.js";
const id = (n: number) => "01902421-1215-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-06T12:00:00.000Z",
  after = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
function definition(overrides: Record<string, unknown> = {}) {
  return createFeatureControlAdministrationDefinition({
    controlId: id(20),
    key: "organization.brand.detail",
    description: "Controlled Brand Detail capability",
    version: 1,
    ownerReference: id(21),
    purposeCode: "BRAND_CAPABILITY_EVALUATION",
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
    authoredByReference: id(22),
    approvedByReference: id(23),
    approvalEvidenceReference: id(24),
    publicationReference: id(25),
    ...overrides,
  });
}
function setup(values = [definition()], mode?: "Command" | "Navigation") {
  const scope: BrandConfigurationActorScope = Object.freeze({
    tenantReference: id(2),
    brandReference: id(2),
    actorReference: id(4),
  });
  const state = {
    now: at,
    stepMs: 0,
    allowed: true,
    storeGrant: false,
    action: "organization.manage",
    actor: id(4),
    lease: after(5000),
    rows: values,
    sqlError: false,
    getter: false,
    getterCalls: 0,
  };
  const queries: string[] = [],
    requests: Parameters<
      MerchantBrandAdministrationCapabilityOptions["holdCurrentBrandAuthority"]
    >[1][] = [],
    hooks: { guard: () => Promise<void>; final: (() => void) | undefined }[] = [];
  const tx: MerchantBrandAdministrationCapabilityOptions["transaction"] = {
    async query<Row = Record<string, unknown>>(sql: string) {
      queries.push(sql);
      if (state.sqlError) throw new Error("unrestricted private source failure");
      const rows = sql.includes("pg_catalog.pg_constraint")
        ? [{ complete: true }]
        : sql.includes("FROM bop_feature_control.control_version")
          ? state.rows.map((d) => ({ definition: d, recordedAt: at, dependencies: [] }))
          : [];
      return { rows: rows as unknown as readonly Row[] };
    },
  };
  const brand = createBrand({
      brandReference: scope.brandReference,
      code: "CONTROLLED",
      displayName: "Controlled",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    store = createStore({
      storeReference: id(3),
      brandReference: scope.brandReference,
      code: "CONTROLLED",
      displayName: "Controlled",
      timeZone: "America/Toronto",
      locale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
  const options: MerchantBrandAdministrationCapabilityOptions = {
    ...(mode === undefined ? {} : { mode }),
    transaction: tx,
    scope,
    clock: {
      now() {
        const observed = state.now;
        state.now = new Date(Date.parse(state.now) + state.stepMs).toISOString();
        return observed;
      },
    },
    originalObservedAt: at,
    originalValidUntil: after(5000),
    async registerBeforeCommit(actual, guard, final) {
      expect(actual).toBe(tx);
      hooks.push({ guard, final });
    },
    async holdCurrentBrandAuthority(actual, request) {
      expect(actual).toBe(tx);
      requests.push(request);
      expect(request.permission).toBe("organization.manage");
      expect(request.purposeCode).toBe("BRAND_CAPABILITY_EVALUATION");
      expect(request.requiredFields).toContain("configuredValue");
      const actor = createIdentityActor({
        actorType: "User",
        actorReference: state.actor,
        accountKind: "Workforce",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt: at,
        recentMfaAt: null,
      });
      const tenantContext = createTenantContext(actor, brand, null, state.now),
        action = parseBusinessAction(state.action);
      if (actor.actorReference === null) throw new Error("Controlled User required");
      const permission = evaluatePermission({
        tenantContext: state.storeGrant
          ? createTenantContext(actor, brand, store, state.now)
          : createTenantContext(actor, brand, null, state.now),
        action,
        resourceScope: state.storeGrant
          ? {
              kind: "Store",
              brandReference: brand.brandReference,
              storeReference: store.storeReference,
            }
          : { kind: "Brand", brandReference: brand.brandReference, storeReference: null },
        policySnapshotReference: parsePolicyReference(id(30)),
        policyVersion: parsePolicyVersion(1),
        evidence: state.allowed
          ? [
              {
                source: "RolePermission",
                evidenceReference: parseEvidenceReference(id(31)),
                action,
                actorReference: actor.actorReference,
                roleReference: parseRoleReference(id(32)),
                brandReference: brand.brandReference,
                storeReference: state.storeGrant ? store.storeReference : null,
                effectiveFrom: parseCanonicalInstant(at),
                effectiveUntil: null,
              },
            ]
          : [],
      });
      const packet = {
        scope,
        tenantContext,
        permission,
        validUntil: state.lease,
      };
      if (state.getter)
        Object.defineProperty(packet, "permission", {
          get() {
            state.getterCalls++;
            throw new Error("must not execute getter");
          },
        });
      return packet;
    },
  };
  const guard = createMerchantBrandAdministrationCapability(options);
  const finalize = async () => {
    expect(hooks).toHaveLength(1);
    for (const h of hooks) await h.guard();
    for (const h of hooks) h.final?.();
    return guard.assertFinalized();
  };
  return { state, scope, tx, options, guard, hooks, queries, requests, finalize };
}
// Real FeatureControl query/resolver and Brand permission constructors with
// controlled SQL facts; these tests do not certify persisted IAM or active membership.
it("holds real Brand permission and the owning definition on the captured transaction through finalization", async () => {
  const f = setup();
  await f.guard.holdUntilCommit();
  await f.guard.holdUntilCommit();
  expect(f.hooks).toHaveLength(1);
  expect(await f.finalize()).toBe(after(5000));
  expect(
    f.queries.filter((sql) => sql.includes("FROM bop_feature_control.control_version")),
  ).toHaveLength(3);
  expect(
    f.requests.every(
      (r) => r.permission === "organization.manage" && r.scope === f.requests[0]?.scope,
    ),
  ).toBe(true);
  expect(f.guard.leaseDeadline()).toBe(after(5000));
});
it("preserves an actual Disabled outcome as the bounded Brand subtype", async () => {
  const f = setup([definition({ configuredValue: "Disabled" })]);
  await expect(f.guard.holdUntilCommit()).rejects.toBeInstanceOf(
    MerchantBrandAdministrationFeatureDisabled,
  );
  expect(() => f.guard.assertFinalized()).toThrow();
});
it("does not treat an absent definition as Disabled or Enabled", async () => {
  const f = setup([]);
  await expect(f.guard.holdUntilCommit()).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    name: "BrandConfigurationOperationError",
  });
});
it.each(["pricing.price-book.manage", "catalog.manage"])(
  "refuses another permission %s",
  async (action) => {
    const f = setup();
    f.state.action = action;
    await expect(f.guard.holdUntilCommit()).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_PERMISSION_DENIED",
    });
  },
);
it("refuses actual Brand denial before consulting definition SQL", async () => {
  const f = setup();
  f.state.allowed = false;
  await expect(f.guard.holdUntilCommit()).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_PERMISSION_DENIED",
  });
  expect(f.queries).toHaveLength(0);
});
it("refuses a historical reader Actor substitution", async () => {
  const f = setup();
  f.state.actor = id(99);
  await expect(f.guard.holdUntilCommit()).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_PERMISSION_DENIED",
  });
});
it("rechecks definitions and fine permission in the actual COMMIT guard", async () => {
  const f = setup();
  await f.guard.holdUntilCommit();
  f.state.rows = [definition({ configuredValue: "Disabled" })];
  await expect(f.finalize()).rejects.toBeInstanceOf(MerchantBrandAdministrationFeatureDisabled);
  const g = setup();
  await g.guard.holdUntilCommit();
  g.state.allowed = false;
  await expect(g.finalize()).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_PERMISSION_DENIED",
  });
});
it("tightens to an actual future override and refuses crossing that source boundary", async () => {
  const f = setup([
    definition(),
    definition({ controlId: id(26), effectiveFrom: after(2000), configuredValue: "Disabled" }),
  ]);
  await f.guard.holdUntilCommit();
  expect(f.guard.leaseDeadline()).toBe(after(2000));
  f.state.now = after(2000);
  await expect(f.finalize()).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  });
});
it("returns the final shortest actual authority lease", async () => {
  const f = setup();
  await f.guard.holdUntilCommit();
  f.state.lease = after(3000);
  expect(await f.finalize()).toBe(after(3000));
});
it("refuses final natural expiry and clock reversal", async () => {
  const f = setup();
  await f.guard.holdUntilCommit();
  f.state.now = after(5000);
  await expect(f.finalize()).rejects.toThrow(BrandConfigurationOperationError);
  const g = setup();
  await g.guard.holdUntilCommit();
  g.state.now = new Date(Date.parse(at) - 1).toISOString();
  await expect(g.guard.holdUntilCommit()).rejects.toThrow();
});
it("captures authority, query and clock ports and poisons mutation", async () => {
  for (const field of ["holdCurrentBrandAuthority", "query", "now"] as const) {
    const f = setup();
    await f.guard.holdUntilCommit();
    if (field === "query")
      Object.defineProperty(f.tx, field, { value: async () => ({ rows: [] }) });
    else if (field === "now") Object.defineProperty(f.options.clock, field, { value: () => at });
    else
      Object.defineProperty(f.options, field, {
        value: async () => {
          throw new Error("replacement");
        },
      });
    await expect(f.finalize()).rejects.toThrow(BrandConfigurationOperationError);
  }
});
it("refuses an unexpected register result and unknown SQL errors without private echo", async () => {
  const f = setup();
  Object.defineProperty(f.options, "registerBeforeCommit", { value: () => 1 });
  const bad = createMerchantBrandAdministrationCapability(f.options);
  await expect(bad.holdUntilCommit()).rejects.toThrow(BrandConfigurationOperationError);
  const g = setup();
  g.state.sqlError = true;
  await expect(g.guard.holdUntilCommit()).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    message: expect.not.stringContaining("private"),
  });
});
it("requires one successful async guard before one sync final and refuses post-check reads", async () => {
  const f = setup();
  await f.guard.holdUntilCommit();
  expect(() => f.hooks[0]?.final?.()).toThrow();
  await expect(f.finalize()).rejects.toThrow();
  const g = setup();
  await g.guard.holdUntilCommit();
  await g.finalize();
  await expect(g.guard.holdUntilCommit()).rejects.toThrow();
});
it("refuses an oversized original window at construction", () => {
  const f = setup();
  expect(() =>
    createMerchantBrandAdministrationCapability({ ...f.options, originalValidUntil: after(5001) }),
  ).toThrow(BrandConfigurationOperationError);
});

it("refuses authority accessors without executing them", async () => {
  const f = setup();
  f.state.getter = true;
  await expect(f.guard.holdUntilCommit()).rejects.toThrow(BrandConfigurationOperationError);
  expect(f.state.getterCalls).toBe(0);
});
it("allows later owning async guards to freshly hold the same capability before all sync finals", async () => {
  const f = setup();
  await f.guard.holdUntilCommit();
  const h = f.hooks[0];
  if (!h || !h.final) throw new Error("Missing actual hook");
  await h.guard();
  await f.guard.holdUntilCommit();
  expect(f.hooks).toHaveLength(1);
  h.final();
  expect(f.guard.assertFinalized()).toBe(after(5000));
});
it("preserves late fine withdrawal during a later owning async guard", async () => {
  const f = setup();
  await f.guard.holdUntilCommit();
  const h = f.hooks[0];
  if (!h) throw new Error("Missing actual hook");
  await h.guard();
  f.state.allowed = false;
  await expect(f.guard.holdUntilCommit()).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_PERMISSION_DENIED",
  });
  expect(() => h.final?.()).toThrow();
});

it("poisons an early final assertion instead of recovering authority", async () => {
  const f = setup();
  await f.guard.holdUntilCommit();
  expect(() => f.guard.assertFinalized()).toThrow();
  await expect(f.guard.holdUntilCommit()).rejects.toThrow();
});

it("uses the genuine later Brand context observation with an advancing clock and unchanged original deadline", async () => {
  const f = setup();
  f.state.stepMs = 2;
  await f.guard.holdUntilCommit();
  await f.guard.holdUntilCommit();
  expect(await f.finalize()).toBe(after(5000));
  expect(Date.parse(f.state.now)).toBeGreaterThan(Date.parse(at));
  expect(f.requests.every((request) => request.validUntil <= after(5000))).toBe(true);
});
it("retains late denial and expiry with the genuinely advancing clock", async () => {
  const f = setup();
  f.state.stepMs = 2;
  await f.guard.holdUntilCommit();
  f.state.allowed = false;
  await expect(f.finalize()).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_PERMISSION_DENIED",
  });
  const g = setup();
  g.state.stepMs = 2;
  await g.guard.holdUntilCommit();
  g.state.now = after(5000);
  await expect(g.finalize()).rejects.toThrow(BrandConfigurationOperationError);
});

it("rejects a Store-only grant even when the capability definition is enabled", async () => {
  const f = setup();
  f.state.storeGrant = true;
  await expect(f.guard.holdUntilCommit()).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_PERMISSION_DENIED",
  });
  expect(f.queries).toHaveLength(0);
});
it("rejects replacement of the captured Brand scope", async () => {
  const f = setup();
  await f.guard.holdUntilCommit();
  Object.defineProperty(f.options, "scope", {
    value: { ...f.scope, tenantReference: id(99), brandReference: id(99) },
  });
  await expect(f.finalize()).rejects.toThrow(BrandConfigurationOperationError);
});

it.each(["Enabled", "Disabled"] as const)(
  "holds actual %s navigation through COMMIT without a command admission",
  async (configuredValue) => {
    const f = setup([definition({ configuredValue })], "Navigation");
    expect(await f.guard.holdForNavigation()).toBe(configuredValue === "Enabled");
    expect(await f.guard.holdForNavigation()).toBe(configuredValue === "Enabled");
    expect(f.hooks).toHaveLength(1);
    expect(await f.finalize()).toBe(after(5000));
    expect(
      f.queries.filter((sql) => sql.includes("FROM bop_feature_control.control_version")),
    ).toHaveLength(3);
  },
);
it.each(["Enabled", "Disabled"] as const)(
  "rejects changed %s navigation visibility at the actual final recheck",
  async (configuredValue) => {
    const f = setup([definition({ configuredValue })], "Navigation");
    await f.guard.holdForNavigation();
    f.state.rows = [
      definition({ configuredValue: configuredValue === "Enabled" ? "Disabled" : "Enabled" }),
    ];
    await expect(f.finalize()).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
  },
);
it("refuses a changed definition even if its visible outcome remains disabled", async () => {
  const f = setup([definition({ configuredValue: "Disabled" })], "Navigation");
  expect(await f.guard.holdForNavigation()).toBe(false);
  f.state.rows = [definition({ configuredValue: "Disabled", version: 2 })];
  await expect(f.finalize()).rejects.toThrow(BrandConfigurationOperationError);
});
it("never treats a missing navigation definition as a disabled admission", async () => {
  const f = setup([], "Navigation");
  await expect(f.guard.holdForNavigation()).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  });
  expect(() => f.guard.assertFinalized()).toThrow();
});
it("keeps command and navigation modes exclusive and captures the mode", async () => {
  const f = setup();
  await expect(f.guard.holdForNavigation()).rejects.toThrow();
  await expect(f.guard.holdUntilCommit()).rejects.toThrow();
  const g = setup([definition()], "Navigation");
  await expect(g.guard.holdUntilCommit()).rejects.toThrow();
  const h = setup([definition()], "Navigation");
  await h.guard.holdForNavigation();
  Object.defineProperty(h.options, "mode", { value: "Command" });
  await expect(h.finalize()).rejects.toThrow();
});
it("retains permission withdrawal and actual future boundaries for hidden navigation", async () => {
  const f = setup([definition({ configuredValue: "Disabled" })], "Navigation");
  expect(await f.guard.holdForNavigation()).toBe(false);
  f.state.allowed = false;
  await expect(f.finalize()).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_PERMISSION_DENIED",
  });
  const g = setup(
    [
      definition({ configuredValue: "Disabled" }),
      definition({ controlId: id(26), effectiveFrom: after(2000), configuredValue: "Enabled" }),
    ],
    "Navigation",
  );
  expect(await g.guard.holdForNavigation()).toBe(false);
  expect(g.guard.leaseDeadline()).toBe(after(2000));
  g.state.now = after(2000);
  await expect(g.finalize()).rejects.toThrow();
});

it("does not invent a distinct Tenant identity for a Brand-only context", () => {
  const f = setup();
  expect(() =>
    createMerchantBrandAdministrationCapability({
      ...f.options,
      scope: { ...f.scope, tenantReference: id(99) },
    }),
  ).toThrow();
});
it("keeps completed-state assertion pure after the pre-COMMIT seals and outer commit", async () => {
  const f = setup();
  await f.guard.holdUntilCommit();
  await f.finalize();
  f.state.now = after(10000);
  f.state.sqlError = true;
  f.state.allowed = false;
  expect(f.guard.assertFinalized()).toBe(after(5000));
});

function setupAdministration(
  values = [definition()],
  mode?: "Command" | "Navigation",
  lifecycle = "Draft",
  screen?: "List" | "Detail",
) {
  const f = setup(values, mode);
  const requests: Parameters<
    MerchantCurrentBrandAdministrationCapabilityOptions["holdCurrentBrandAdministrationAuthority"]
  >[1][] = [];
  const options: MerchantCurrentBrandAdministrationCapabilityOptions = {
    ...(screen === undefined ? {} : { screen }),
    ...(f.options.mode === undefined ? {} : { mode: f.options.mode }),
    transaction: f.tx,
    scope: f.scope,
    clock: f.options.clock,
    originalObservedAt: f.options.originalObservedAt,
    originalValidUntil: f.options.originalValidUntil,
    registerBeforeCommit: f.options.registerBeforeCommit,
    async holdCurrentBrandAdministrationAuthority(actual, request) {
      requests.push(request);
      expect(request.purposeCode).toBe("BRAND_ADMINISTRATION");
      const original = await f.options.holdCurrentBrandAuthority(actual, {
        ...request,
        purposeCode: "BRAND_CAPABILITY_EVALUATION",
      });
      const administrationContext = createBrandAdministrationContext(
        original.tenantContext.actor,
        createBrand({ ...original.tenantContext.brand, lifecycle }),
        original.tenantContext.resolvedAt,
      );
      const action = parseBusinessAction(f.state.action);
      const actor = administrationContext.actor;
      if (actor.actorReference === null) throw new Error("Controlled User required");
      const permission = evaluateBrandAdministrationPermission({
        administrationContext,
        action,
        resourceScope: {
          kind: "Brand",
          brandReference: administrationContext.brand.brandReference,
          storeReference: null,
        },
        policySnapshotReference: parsePolicyReference(id(30)),
        policyVersion: parsePolicyVersion(1),
        evidence: f.state.allowed
          ? [
              {
                source: "RolePermission",
                evidenceReference: parseEvidenceReference(id(31)),
                action,
                actorReference: actor.actorReference,
                roleReference: parseRoleReference(id(32)),
                brandReference: administrationContext.brand.brandReference,
                storeReference: f.state.storeGrant ? parseStoreReference(id(3)) : null,
                effectiveFrom: parseCanonicalInstant(at),
                effectiveUntil: null,
              },
            ]
          : [],
      });
      return {
        scope: original.scope,
        administrationContext,
        permission,
        validUntil: original.validUntil,
      };
    },
  };
  const guard = createMerchantCurrentBrandAdministrationCapability(options);
  const finalize = async () => {
    expect(f.hooks).toHaveLength(1);
    for (const hook of f.hooks) await hook.guard();
    for (const hook of f.hooks) hook.final?.();
    return guard.assertFinalized();
  };
  return { ...f, options, guard, finalize, administrativeRequests: requests };
}
it.each(["Draft", "Active"])(
  "holds genuine %s administrative Context and finite definition sources through finalization",
  async (lifecycle) => {
    const f = setupAdministration(undefined, undefined, lifecycle);
    f.state.stepMs = 2;
    await f.guard.holdUntilCommit();
    expect(await f.finalize()).toBe(after(5000));
    expect(f.administrativeRequests.length).toBeGreaterThan(1);
    expect(
      f.administrativeRequests.every(
        (r) => r.purposeCode === "BRAND_ADMINISTRATION" && r.validUntil <= after(5000),
      ),
    ).toBe(true);
  },
);
it("preserves administrative permission refusal and late owning guard withdrawal", async () => {
  const f = setupAdministration();
  f.state.allowed = false;
  await expect(f.guard.holdUntilCommit()).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_PERMISSION_DENIED",
  });
  expect(f.queries).toHaveLength(0);
  const g = setupAdministration();
  await g.guard.holdUntilCommit();
  const h = g.hooks[0];
  if (!h) throw new Error("Missing hook");
  await h.guard();
  g.state.allowed = false;
  await expect(g.guard.holdUntilCommit()).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_PERMISSION_DENIED",
  });
  expect(() => h.final?.()).toThrow();
});
it("admits the held empty administrative baseline without enabling an existing definition", async () => {
  const f = setupAdministration([]);
  await f.guard.holdUntilCommit();
  await f.finalize();
  const g = setupAdministration([definition({ configuredValue: "Disabled" })]);
  await expect(g.guard.holdUntilCommit()).rejects.toBeInstanceOf(
    MerchantBrandAdministrationFeatureDisabled,
  );
  const h = setupAdministration();
  await h.guard.holdUntilCommit();
  h.state.rows = [definition({ configuredValue: "Disabled" })];
  await expect(h.finalize()).rejects.toBeInstanceOf(MerchantBrandAdministrationFeatureDisabled);
});
it("captures the administrative authority port and refuses final expiry", async () => {
  const f = setupAdministration();
  await f.guard.holdUntilCommit();
  Object.defineProperty(f.options, "holdCurrentBrandAdministrationAuthority", {
    value: async () => {
      throw new Error("replacement");
    },
  });
  await expect(f.finalize()).rejects.toThrow(BrandConfigurationOperationError);
  const g = setupAdministration();
  await g.guard.holdUntilCommit();
  g.state.now = after(5000);
  await expect(g.finalize()).rejects.toThrow(BrandConfigurationOperationError);
});
it.each(["Enabled", "Disabled"] as const)(
  "preserves actual administrative %s navigation without command admission",
  async (configuredValue) => {
    const f = setupAdministration([definition({ configuredValue })], "Navigation");
    expect(await f.guard.holdForNavigation()).toBe(configuredValue === "Enabled");
    expect(await f.finalize()).toBe(after(5000));
    const g = setupAdministration([definition({ configuredValue })], "Navigation");
    await g.guard.holdForNavigation();
    g.state.rows = [definition({ configuredValue, version: 2 })];
    await expect(g.finalize()).rejects.toThrow(BrandConfigurationOperationError);
  },
);
it("keeps old operation authority distinct from an Active administrative packet", async () => {
  const f = setup();
  const original = f.options.holdCurrentBrandAuthority;
  Object.defineProperty(f.options, "holdCurrentBrandAuthority", {
    value: async (
      actual: Parameters<typeof original>[0],
      request: Parameters<typeof original>[1],
    ) => {
      const packet = await original(actual, request);
      const administrationContext = createBrandAdministrationContext(
        packet.tenantContext.actor,
        packet.tenantContext.brand,
        packet.tenantContext.resolvedAt,
      );
      return {
        ...packet,
        tenantContext: Object.freeze({ ...administrationContext, scopeKind: "Brand" }),
      };
    },
  });
  const guard = createMerchantBrandAdministrationCapability(f.options);
  await expect(guard.holdUntilCommit()).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  });
});
it("rejects administrative context scope/time substitution before definition access", async () => {
  for (const field of ["resolvedAt", "brand"] as const) {
    const f = setupAdministration();
    const original = f.options.holdCurrentBrandAdministrationAuthority;
    Object.defineProperty(f.options, "holdCurrentBrandAdministrationAuthority", {
      value: async (
        actual: Parameters<typeof original>[0],
        request: Parameters<typeof original>[1],
      ) => {
        const packet = await original(actual, request);
        const change =
          field === "resolvedAt"
            ? { resolvedAt: after(1) }
            : { brand: { ...packet.administrationContext.brand, brandReference: id(99) } };
        return {
          ...packet,
          administrationContext: parseBrandAdministrationContext({
            ...packet.administrationContext,
            ...change,
          }),
        };
      },
    });
    const guard = createMerchantCurrentBrandAdministrationCapability(f.options);
    await expect(guard.holdUntilCommit()).rejects.toThrow(BrandConfigurationOperationError);
    expect(f.queries).toHaveLength(0);
  }
});
it("refuses administrative packet extra fields and accessors without invoking them", async () => {
  for (const field of ["extra", "getter"] as const) {
    const f = setupAdministration();
    const original = f.options.holdCurrentBrandAdministrationAuthority;
    let touched = false;
    Object.defineProperty(f.options, "holdCurrentBrandAdministrationAuthority", {
      value: async (
        actual: Parameters<typeof original>[0],
        request: Parameters<typeof original>[1],
      ) => {
        const packet = await original(actual, request);
        if (field === "extra") return { ...packet, tenantContext: packet.administrationContext };
        Object.defineProperty(packet, "permission", {
          enumerable: true,
          get() {
            touched = true;
            throw new Error("must not invoke");
          },
        });
        return packet;
      },
    });
    const guard = createMerchantCurrentBrandAdministrationCapability(f.options);
    await expect(guard.holdUntilCommit()).rejects.toThrow(BrandConfigurationOperationError);
    expect(touched).toBe(false);
    expect(f.queries).toHaveLength(0);
  }
});

it.each(["Draft", "Active", "Suspended", "Archived"])(
  "admits actual %s empty administrative navigation without manufacturing a Feature verdict",
  async (lifecycle) => {
    const f = setupAdministration([], "Navigation", lifecycle);
    expect(await f.guard.holdForNavigation()).toBe(true);
    expect(await f.finalize()).toBe(after(5000));
  },
);
it("holds empty administrative source identity and IAM until COMMIT", async () => {
  const f = setupAdministration([]);
  await f.guard.holdUntilCommit();
  f.state.rows = [definition()];
  await expect(f.finalize()).rejects.toThrow(BrandConfigurationOperationError);
  const g = setupAdministration([]);
  await g.guard.holdUntilCommit();
  g.state.allowed = false;
  await expect(g.finalize()).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_PERMISSION_DENIED",
  });
  const h = setupAdministration([]);
  await h.guard.holdUntilCommit();
  h.state.now = after(5000);
  await expect(h.finalize()).rejects.toThrow(BrandConfigurationOperationError);
  const j = setupAdministration([]);
  await j.guard.holdUntilCommit();
  j.state.sqlError = true;
  await expect(j.finalize()).rejects.toThrow(BrandConfigurationOperationError);
});
it("does not admit nonempty unpublished or expired administrative configuration", async () => {
  for (const rows of [
    [
      definition({
        lifecycle: "Draft",
        approvedByReference: null,
        approvalEvidenceReference: null,
        publicationReference: null,
      }),
    ],
    [definition({ effectiveFrom: after(-1000), effectiveUntil: at })],
    [definition(), definition({ controlId: id(26) })],
  ]) {
    const f = setupAdministration(rows);
    await expect(f.guard.holdUntilCommit()).rejects.toThrow(BrandConfigurationOperationError);
  }
});

it("refuses empty baseline query-port replacement and disappearance of configured authority", async () => {
  const f = setupAdministration([]);
  await f.guard.holdUntilCommit();
  Object.defineProperty(f.tx, "query", { value: async () => ({ rows: [] }) });
  await expect(f.finalize()).rejects.toThrow(BrandConfigurationOperationError);
  const g = setupAdministration();
  await g.guard.holdUntilCommit();
  g.state.rows = [];
  await expect(g.finalize()).rejects.toThrow(BrandConfigurationOperationError);
});

it.each(["Draft", "Active", "Suspended", "Archived"])(
  "admits the actual %s Brand list baseline separately from detail",
  async (lifecycle) => {
    const f = setupAdministration([], "Navigation", lifecycle, "List");
    expect(await f.guard.holdForNavigation()).toBe(true);
    expect(await f.finalize()).toBe(after(5000));
  },
);
it("keeps real list Disabled and permission withdrawal authoritative", async () => {
  const f = setupAdministration(
    [definition({ key: "organization.brand.list", configuredValue: "Disabled" })],
    "Navigation",
    "Draft",
    "List",
  );
  expect(await f.guard.holdForNavigation()).toBe(false);
  await f.finalize();
  const g = setupAdministration([], "Navigation", "Draft", "List");
  await g.guard.holdForNavigation();
  g.state.allowed = false;
  await expect(g.finalize()).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_PERMISSION_DENIED",
  });
});
it("captures the selected administrative screen and rejects foreign definitions", async () => {
  const f = setupAdministration([], "Navigation", "Draft", "List");
  await f.guard.holdForNavigation();
  Object.defineProperty(f.options, "screen", { value: "Detail" });
  await expect(f.finalize()).rejects.toThrow();
  const g = setupAdministration([definition()], "Navigation", "Draft", "List");
  await expect(g.guard.holdForNavigation()).rejects.toThrow();
});
