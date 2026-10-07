import { expect, it } from "vitest";
import { createIdentityActor } from "@bop/identity";
import { createBrand, createStore, createTenantContext, parseCanonicalInstant } from "@bop/tenant";
import {
  evaluatePermission,
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
  parseRoleReference,
  parseEvidenceReference,
} from "@bop/permission";
import { createFeatureControlAdministrationDefinition } from "@bop/feature-control";
import { TaxConfigWorkflowError, parseTaxConfigAuthoringScope } from "@rms/pricing";
import {
  createMerchantTaxConfigCapability,
  MerchantTaxConfigFeatureDisabled,
  type MerchantTaxConfigCapabilityOptions,
} from "./merchant-tax-config-capability.js";
const id = (n: number) => "01902421-1215-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-06T12:00:00.000Z",
  after = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
function definition(overrides: Record<string, unknown> = {}) {
  return createFeatureControlAdministrationDefinition({
    controlId: id(20),
    key: "pricing.taxconfig.authoring",
    description: "Controlled Tax capability",
    version: 1,
    ownerReference: id(21),
    purposeCode: "TAX_CONFIG",
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
function setup(values = [definition()]) {
  const scope = parseTaxConfigAuthoringScope({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  });
  const state = {
    now: at,
    stepMs: 0,
    allowed: true,
    action: "pricing.tax-config.manage",
    actor: id(4),
    lease: after(5000),
    rows: values,
    sqlError: false,
    getter: false,
    getterCalls: 0,
  };
  const queries: string[] = [],
    requests: Parameters<MerchantTaxConfigCapabilityOptions["holdCurrentTaxAuthority"]>[1][] = [],
    hooks: { guard: () => Promise<void>; final: (() => void) | undefined }[] = [];
  const tx: MerchantTaxConfigCapabilityOptions["transaction"] = {
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
      storeReference: scope.storeReference,
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
  const options: MerchantTaxConfigCapabilityOptions = {
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
    async holdCurrentTaxAuthority(actual, request) {
      expect(actual).toBe(tx);
      requests.push(request);
      expect(request.permission).toBe("pricing.tax-config.manage");
      expect(request.purposeCode).toBe("STORE_CAPABILITY_EVALUATION");
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
      const tenantContext = createTenantContext(actor, brand, store, state.now),
        action = parseBusinessAction(state.action);
      if (actor.actorReference === null) throw new Error("Controlled User required");
      const permission = evaluatePermission({
        tenantContext,
        action,
        resourceScope: {
          kind: "Store",
          brandReference: brand.brandReference,
          storeReference: store.storeReference,
        },
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
                storeReference: store.storeReference,
                effectiveFrom: parseCanonicalInstant(at),
                effectiveUntil: null,
              },
            ]
          : [],
      });
      const packet = { scope, tenantContext, permission, validUntil: state.lease };
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
  const guard = createMerchantTaxConfigCapability(options);
  const finalize = async () => {
    expect(hooks).toHaveLength(1);
    for (const h of hooks) await h.guard();
    for (const h of hooks) h.final?.();
    return guard.assertFinalized();
  };
  return { state, scope, tx, options, guard, hooks, queries, requests, finalize };
}
// Real FeatureControl query/resolver and Domain permission constructors with
// controlled SQL facts; these tests do not certify persisted IAM or tax approval.
it("holds real Store Tax permission and the owning definition on the captured transaction through finalization", async () => {
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
      (r) => r.permission === "pricing.tax-config.manage" && r.scope === f.requests[0]?.scope,
    ),
  ).toBe(true);
  expect(f.guard.leaseDeadline()).toBe(after(5000));
});
it("preserves an actual Disabled outcome as the bounded Tax subtype", async () => {
  const f = setup([definition({ configuredValue: "Disabled" })]);
  await expect(f.guard.holdUntilCommit()).rejects.toBeInstanceOf(MerchantTaxConfigFeatureDisabled);
  expect(() => f.guard.assertFinalized()).toThrow();
});
it("does not treat an absent definition as Disabled or Enabled", async () => {
  const f = setup([]);
  await expect(f.guard.holdUntilCommit()).rejects.toMatchObject({
    code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
    name: "TaxConfigWorkflowError",
  });
});
it.each(["pricing.price-book.manage", "catalog.manage"])(
  "refuses another permission %s",
  async (action) => {
    const f = setup();
    f.state.action = action;
    await expect(f.guard.holdUntilCommit()).rejects.toMatchObject({
      code: "TAX_CONFIG_PERMISSION_DENIED",
    });
  },
);
it("refuses actual fine denial before consulting definition SQL", async () => {
  const f = setup();
  f.state.allowed = false;
  await expect(f.guard.holdUntilCommit()).rejects.toMatchObject({
    code: "TAX_CONFIG_PERMISSION_DENIED",
  });
  expect(f.queries).toHaveLength(0);
});
it("refuses a historical reader Actor substitution", async () => {
  const f = setup();
  f.state.actor = id(99);
  await expect(f.guard.holdUntilCommit()).rejects.toMatchObject({
    code: "TAX_CONFIG_PERMISSION_DENIED",
  });
});
it("rechecks definitions and fine permission in the actual COMMIT guard", async () => {
  const f = setup();
  await f.guard.holdUntilCommit();
  f.state.rows = [definition({ configuredValue: "Disabled" })];
  await expect(f.finalize()).rejects.toBeInstanceOf(MerchantTaxConfigFeatureDisabled);
  const g = setup();
  await g.guard.holdUntilCommit();
  g.state.allowed = false;
  await expect(g.finalize()).rejects.toMatchObject({ code: "TAX_CONFIG_PERMISSION_DENIED" });
});
it("tightens to an actual future override and refuses crossing that source boundary", async () => {
  const f = setup([
    definition(),
    definition({ controlId: id(26), effectiveFrom: after(2000), configuredValue: "Disabled" }),
  ]);
  await f.guard.holdUntilCommit();
  expect(f.guard.leaseDeadline()).toBe(after(2000));
  f.state.now = after(2000);
  await expect(f.finalize()).rejects.toMatchObject({ code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE" });
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
  await expect(f.finalize()).rejects.toThrow(TaxConfigWorkflowError);
  const g = setup();
  await g.guard.holdUntilCommit();
  g.state.now = new Date(Date.parse(at) - 1).toISOString();
  await expect(g.guard.holdUntilCommit()).rejects.toThrow();
});
it("captures authority, query and clock ports and poisons mutation", async () => {
  for (const field of ["holdCurrentTaxAuthority", "query", "now"] as const) {
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
    await expect(f.finalize()).rejects.toThrow(TaxConfigWorkflowError);
  }
});
it("refuses an unexpected register result and unknown SQL errors without private echo", async () => {
  const f = setup();
  Object.defineProperty(f.options, "registerBeforeCommit", { value: () => 1 });
  const bad = createMerchantTaxConfigCapability(f.options);
  await expect(bad.holdUntilCommit()).rejects.toThrow(TaxConfigWorkflowError);
  const g = setup();
  g.state.sqlError = true;
  await expect(g.guard.holdUntilCommit()).rejects.toMatchObject({
    code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
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
    createMerchantTaxConfigCapability({ ...f.options, originalValidUntil: after(5001) }),
  ).toThrow(TaxConfigWorkflowError);
});

it("refuses authority accessors without executing them", async () => {
  const f = setup();
  f.state.getter = true;
  await expect(f.guard.holdUntilCommit()).rejects.toThrow(TaxConfigWorkflowError);
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
    code: "TAX_CONFIG_PERMISSION_DENIED",
  });
  expect(() => h.final?.()).toThrow();
});

it("poisons an early final assertion instead of recovering authority", async () => {
  const f = setup();
  await f.guard.holdUntilCommit();
  expect(() => f.guard.assertFinalized()).toThrow();
  await expect(f.guard.holdUntilCommit()).rejects.toThrow();
});

it("uses the genuine later Store context observation with an advancing clock and unchanged original deadline", async () => {
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
  await expect(f.finalize()).rejects.toMatchObject({ code: "TAX_CONFIG_PERMISSION_DENIED" });
  const g = setup();
  g.state.stepMs = 2;
  await g.guard.holdUntilCommit();
  g.state.now = after(5000);
  await expect(g.finalize()).rejects.toThrow(TaxConfigWorkflowError);
});
