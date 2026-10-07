import { beforeEach, expect, it, vi } from "vitest";
import { createIdentityActor } from "@bop/identity";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { createFeatureControlAdministrationDefinition } from "@bop/feature-control";
import {
  createMerchantStoreCapability,
  type MerchantStoreCapabilityOptions,
} from "./merchant-store-capability.js";
const ports = vi.hoisted(() => ({ store: vi.fn(), brand: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => ports.store }));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => ports.brand }));
const id = (n: number) => `01902421-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-04T12:00:00.000Z";
const after = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
beforeEach(() => vi.clearAllMocks());
function fixture() {
  // Synthetic scope/IAM and SQL records; the owning capability resolver is real.
  const state = {
    now: at,
    allowed: true,
    permissionValidUntil: null as string | null,
    control: "Enabled",
    missing: false,
    effectiveUntil: null as string | null,
    navigationCalls: 0,
    revokeAt: Infinity,
    deniedActions: new Set<string>(),
  };
  const events: string[] = [];
  const actor = createIdentityActor({
    actorType: "User",
    actorReference: id(4),
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: at,
    recentMfaAt: null,
  });
  const brand = createBrand({
    brandReference: id(2),
    code: "SYNTHETIC",
    displayName: "Synthetic Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const store = createStore({
    storeReference: id(3),
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
  });
  const allowed = vi.fn(async () => state.allowed && ++state.navigationCalls < state.revokeAt);
  const authorizeActions = vi.fn(async (actions: readonly string[]) => {
    events.push("iam");
    return actions.map((action) => ({
      action,
      scopeKind: "Brand",
      effect: state.allowed && !state.deniedActions.has(action) ? "Allow" : "Deny",
    }));
  });
  const selected = {
    selected: { tenantReference: id(1) },
    context: createTenantContext(actor, brand, store, at),
    store,
    actorReference: id(4),
    sessionReference: id(5),
    allowed,
    authorizationValidUntil: () => state.permissionValidUntil,
  };
  const scope = {
    tenantReference: id(1),
    context: createTenantContext(actor, brand, null, at),
    selectedStoreReference: id(3),
    actorReference: id(4),
    authorizeActions,
    authorizeActionsWithValidity: async (actions: readonly string[]) => ({
      decisions: await authorizeActions(actions),
      validUntil: state.permissionValidUntil,
    }),
  };
  const seenTransactions: unknown[] = [];
  ports.store.mockImplementation(async (tx, _cookie, _action, session) => {
    expect(session).toBe(id(5));
    seenTransactions.push(tx);
    return selected;
  });
  ports.brand.mockImplementation(async (tx) => {
    seenTransactions.push(tx);
    return scope;
  });
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    if (sql.includes("pg_catalog.pg_constraint"))
      return { rows: [{ complete: true }], rowCount: 1 };
    if (sql.includes("FROM bop_feature_control.control_version")) {
      events.push("definitions");
      return {
        rows: state.missing
          ? []
          : [
              {
                definition: createFeatureControlAdministrationDefinition({
                  controlId: id(6),
                  key: values[2],
                  description: "Synthetic Product control",
                  version: 1,
                  ownerReference: id(7),
                  purposeCode: "PRODUCT_READ",
                  scope: { kind: "Brand", brandReference: id(2), storeReference: null },
                  source: "BrandOverride",
                  defaultValue: "Disabled",
                  configuredValue: state.control,
                  lifecycle: "Published",
                  temporary: false,
                  effectiveFrom: at,
                  effectiveUntil: state.effectiveUntil,
                  reviewAt: after(86400000),
                  expiresAt: null,
                  dependencies: [],
                  authoredByReference: id(7),
                  approvedByReference: id(8),
                  approvalEvidenceReference: id(9),
                  publicationReference: id(10),
                }),
                recordedAt: at,
                dependencies: [],
              },
            ],
        rowCount: state.missing ? 0 : 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  const tx = { query };
  const run: MerchantStoreCapabilityOptions["persistence"]["transactions"]["run"] = async (
    work,
  ) => {
    events.push("BEGIN");
    try {
      const result = await work(tx as never);
      events.push("COMMIT");
      return result;
    } catch (error) {
      events.push("ROLLBACK");
      throw error;
    }
  };
  const authenticate = vi.fn(async () => ({ sessionReference: id(5) }));
  const options: MerchantStoreCapabilityOptions = {
    persistence: {
      now: () => state.now,
      transactions: { run },
      currentActor: vi.fn(),
      validateAssociation: vi.fn(),
    } as unknown as MerchantStoreCapabilityOptions["persistence"],
    authentication: {
      authorize: authenticate,
    } as unknown as MerchantStoreCapabilityOptions["authentication"],
    currentProductRuntime: true,
  };
  const request = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    query: { capabilityKey: "catalog.cat_product_list" },
  };
  return {
    state,
    events,
    scope,
    selected,
    query,
    seenTransactions,
    authorizeActions,
    authenticate,
    options,
    request,
    build: () => createMerchantStoreCapability(options),
  };
}
it.each(["product_list", "product_create", "product_detail", "product_edit", "sku_detail"])(
  "observes actual Product %s using Brand Catalog authority and owning mapping",
  async (suffix) => {
    const f = fixture(),
      key = `catalog.cat_${suffix}`;
    const result = await f.build().observe({ ...f.request, query: { capabilityKey: key } });
    expect(result).toMatchObject({
      capabilityKey: key,
      controlKey: `catalog.${suffix.replace("_", ".")}`,
      backendExecution: "Allow",
      frontendVisibility: "Show",
      reason: "Enabled",
      controlReference: id(6),
    });
    expect(
      f.authorizeActions.mock.calls.every(
        ([actions]) => actions.join() === "catalog.manage,catalog.product.manage",
      ),
    ).toBe(true);
    expect(ports.store.mock.calls.every((call) => call[2] === "merchant.access")).toBe(true);
    expect(new Set(f.seenTransactions).size).toBe(1);
    expect(f.events.filter((value) => value === "BEGIN")).toHaveLength(1);
    expect(f.events.at(-1)).toBe("COMMIT");
    expect(f.events.lastIndexOf("iam")).toBeGreaterThan(f.events.indexOf("definitions"));
  },
);
it.each([false, true])(
  "returns a real disabled/unavailable observation rather than an invented Allow, missing: %s",
  async (missing) => {
    const f = fixture();
    f.state.control = "Disabled";
    f.state.missing = missing;
    expect(await f.build().observe(f.request)).toMatchObject({
      backendExecution: "Deny",
      frontendVisibility: "Hide",
      reason: missing ? "Unavailable" : "Disabled",
      controlReference: missing ? null : id(6),
    });
    expect(f.events.at(-1)).toBe("COMMIT");
  },
);
it.each(["organization.store_capability", "catalog.unknown"])(
  "refuses unmapped/non-Product key %s before authentication or SQL",
  async (key) => {
    const f = fixture();
    await expect(
      f.build().observe({ ...f.request, query: { capabilityKey: key } }),
    ).rejects.toThrow();
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  },
);
it("requires real current Brand actions and matching Tenant/Brand/Store/Actor", async () => {
  const f = fixture();
  f.state.allowed = false;
  await expect(f.build().observe(f.request)).rejects.toThrow();
  expect(f.events).not.toContain("definitions");
  const g = fixture();
  g.scope.tenantReference = id(99);
  await expect(g.build().observe(g.request)).rejects.toThrow();
  expect(g.events).not.toContain("definitions");
});
it.each(["definitionsAuthority", "bindings", "dependencies"])(
  "rejects mixing current runtime with external %s",
  (key) => {
    const f = fixture();
    expect(() => createMerchantStoreCapability({ ...f.options, [key]: {} })).toThrow();
    expect(f.authenticate).not.toHaveBeenCalled();
  },
);
it("keeps the original deadline and current revocation guard through commit", async () => {
  const f = fixture();
  await expect(
    f
      .build()
      .withCapability(f.request, "catalog.cat_product_list", "catalog.product.manage", async () => {
        f.state.now = after(5000);
        return "tentative";
      }),
  ).rejects.toThrow();
  expect(f.events.at(-1)).toBe("ROLLBACK");
  const baseline = fixture();
  await baseline.build().observe(baseline.request);
  const g = fixture();
  g.state.revokeAt = baseline.state.navigationCalls;
  await expect(g.build().observe(g.request)).rejects.toThrow();
  expect(g.events).toContain("definitions");
  expect(g.events.at(-1)).toBe("ROLLBACK");
});
it("retains the actual control effective boundary and captures startup ports", async () => {
  const f = fixture();
  f.state.effectiveUntil = after(1000);
  const runtime = f.build();
  Object.assign(f.options.persistence, { now: () => after(6000) });
  Object.assign(f.options.authentication, {
    authorize: vi.fn(async () => {
      throw Error("substituted");
    }),
  });
  await expect(
    runtime.withCapability(
      f.request,
      "catalog.cat_product_list",
      "catalog.product.manage",
      async () => {
        f.state.now = after(1000);
        return "tentative";
      },
    ),
  ).rejects.toThrow();
  expect(f.authenticate).toHaveBeenCalledTimes(1);
  expect(f.events.at(-1)).toBe("ROLLBACK");
});
it("retains legacy organization authority and supplied owner holder when current mode is absent", async () => {
  const f = fixture();
  const withAuthorizedDefinitionsScope = vi.fn(async (_input, work: () => Promise<unknown>) =>
    work(),
  );
  const runtime = createMerchantStoreCapability({
    persistence: f.options.persistence,
    authentication: f.options.authentication,
    definitionsAuthority: { withAuthorizedDefinitionsScope } as never,
  });
  expect(await runtime.observe(f.request)).toMatchObject({ backendExecution: "Allow" });
  expect(ports.store.mock.calls[0]?.[2]).toBe("organization.manage");
  expect(ports.brand).not.toHaveBeenCalled();
  expect(withAuthorizedDefinitionsScope).toHaveBeenCalled();
});
it("does not allow a caller-selected action to broaden current mode or invoke a denied guard", async () => {
  const f = fixture(),
    consumer = vi.fn();
  await expect(
    f.build().guard(f.request, "catalog.cat_product_list", "organization.manage", consumer),
  ).rejects.toThrow();
  expect(f.authenticate).not.toHaveBeenCalled();
  f.state.control = "Disabled";
  await expect(
    f.build().guard(f.request, "catalog.cat_product_list", "catalog.product.manage", consumer),
  ).rejects.toThrow();
  expect(consumer).not.toHaveBeenCalled();
  expect(f.events.at(-1)).toBe("ROLLBACK");
});

it("permits a Product capability observation before actual current permission expiry", async () => {
  const f = fixture();
  f.state.permissionValidUntil = after(1000);
  const result = await f.build().observe(f.request);
  expect(result.backendExecution).toBe("Allow");
  expect(f.events.at(-1)).toBe("COMMIT");
});
it("rejects permission expiry consumed by the capability consumer", async () => {
  const f = fixture();
  f.state.permissionValidUntil = after(1000);
  await expect(
    f
      .build()
      .withCapability(f.request, "catalog.cat_product_list", "catalog.product.manage", async () => {
        f.state.now = after(1000);
      }),
  ).rejects.toThrow();
  expect(f.events.at(-1)).toBe("ROLLBACK");
});

it("refuses malformed owning validity metadata instead of advertising the default lease", async () => {
  const f = fixture();
  f.state.permissionValidUntil = "invalid";
  await expect(f.build().observe(f.request)).rejects.toThrow();
  expect(f.events.at(-1)).toBe("ROLLBACK");
});

it.each(["create", "detail", "edit", "list"])(
  "observes canonical Option Set %s under its own control and read permission",
  async (page) => {
    const f = fixture();
    const capabilityKey = `catalog.cat_optionset_${page}`;
    const request = { ...f.request, query: { capabilityKey } };
    const result = await f.build().observe(request);
    expect(result).toMatchObject({
      capabilityKey,
      controlKey: `catalog.optionset.${page}`,
      backendExecution: "Allow",
      frontendVisibility: "Show",
      reason: "Enabled",
    });
    expect(
      f.authorizeActions.mock.calls.every(
        ([actions]) => actions.join() === "catalog.manage,catalog.option_set.read",
      ),
    ).toBe(true);
    expect(new Set(f.seenTransactions).size).toBe(1);
    expect(f.events.at(-1)).toBe("COMMIT");
    const disabled = fixture();
    disabled.state.control = "Disabled";
    expect(
      await disabled.build().observe({ ...disabled.request, query: { capabilityKey } }),
    ).toMatchObject({
      backendExecution: "Deny",
      frontendVisibility: "Hide",
      reason: "Disabled",
    });
    const absent = fixture();
    absent.state.missing = true;
    expect(
      await absent.build().observe({ ...absent.request, query: { capabilityKey } }),
    ).toMatchObject({
      backendExecution: "Deny",
      frontendVisibility: "Hide",
      reason: "Unavailable",
    });
  },
);

it.each(["list", "editor"])(
  "observes ordinary Pricing %s with its owning mapping and fine permission",
  async (page) => {
    const f = fixture(),
      capabilityKey = `pricing.price_book_${page}`;
    const result = await f.build().observe({ ...f.request, query: { capabilityKey } });
    expect(result).toMatchObject({
      capabilityKey,
      controlKey: `pricing.pricebook.${page}`,
      backendExecution: "Allow",
      frontendVisibility: "Show",
      reason: "Enabled",
    });
    expect(
      f.authorizeActions.mock.calls.every(
        ([actions]) => actions.join() === "pricing.price-book.manage",
      ),
    ).toBe(true);
    expect(ports.store.mock.calls.every((call) => call[2] === "merchant.access")).toBe(true);
    expect(new Set(f.seenTransactions).size).toBe(1);
    expect(f.events.at(-1)).toBe("COMMIT");
    const disabled = fixture();
    disabled.state.control = "Disabled";
    expect(
      await disabled.build().observe({ ...disabled.request, query: { capabilityKey } }),
    ).toMatchObject({ backendExecution: "Deny", frontendVisibility: "Hide", reason: "Disabled" });
    const absent = fixture();
    absent.state.missing = true;
    expect(
      await absent.build().observe({ ...absent.request, query: { capabilityKey } }),
    ).toMatchObject({
      backendExecution: "Deny",
      frontendVisibility: "Hide",
      reason: "Unavailable",
    });
  },
);
it.each(["list", "editor"])(
  "rejects Pricing %s fine denial while navigation remains allowed",
  async (page) => {
    const f = fixture();
    f.state.deniedActions.add("pricing.price-book.manage");
    await expect(
      f.build().observe({ ...f.request, query: { capabilityKey: `pricing.price_book_${page}` } }),
    ).rejects.toThrow();
    expect(f.state.allowed).toBe(true);
    expect(f.events).not.toContain("definitions");
    expect(f.events.at(-1)).toBe("ROLLBACK");
  },
);
it("does not admit Pricing through Catalog rights or invoke a disabled writer", async () => {
  const f = fixture(),
    work = vi.fn();
  await expect(
    f.build().guard(f.request, "pricing.price_book_editor", "catalog.product.manage", work),
  ).rejects.toThrow();
  expect(f.authenticate).not.toHaveBeenCalled();
  f.state.control = "Disabled";
  await expect(
    f.build().guard(f.request, "pricing.price_book_editor", "pricing.price-book.manage", work),
  ).rejects.toThrow();
  expect(work).not.toHaveBeenCalled();
  expect(f.events.at(-1)).toBe("ROLLBACK");
});
it("rejects Pricing scope/Actor mismatch before reading definitions", async () => {
  const f = fixture();
  f.selected.actorReference = id(99);
  await expect(
    f.build().observe({ ...f.request, query: { capabilityKey: "pricing.price_book_list" } }),
  ).rejects.toThrow();
  expect(f.events).not.toContain("definitions");
  expect(f.events.at(-1)).toBe("ROLLBACK");
});
it.each(["originalDeadline", "fineRevocation", "permissionExpiry"])(
  "keeps Pricing %s through final admission",
  async (reason) => {
    const f = fixture();
    if (reason === "permissionExpiry") f.state.permissionValidUntil = after(1000);
    await expect(
      f
        .build()
        .withCapability(
          f.request,
          "pricing.price_book_editor",
          "pricing.price-book.manage",
          async () => {
            if (reason === "fineRevocation") f.state.deniedActions.add("pricing.price-book.manage");
            else f.state.now = after(reason === "originalDeadline" ? 5000 : 1000);
          },
        ),
    ).rejects.toThrow();
    expect(f.events).toContain("definitions");
    expect(f.events.at(-1)).toBe("ROLLBACK");
  },
);
