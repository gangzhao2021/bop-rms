import { beforeEach, expect, it, vi } from "vitest";
import { createIdentityActor } from "@bop/identity";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { createFeatureControlAdministrationDefinition } from "@bop/feature-control";
import {
  evaluatePermission,
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
  parseEvidenceReference,
  parseRoleReference,
  parseEvidenceInstant,
} from "@bop/permission";
import { createMerchantProductListRuntime } from "./merchant-product-list-runtime.js";

const ports = vi.hoisted(() => ({ store: vi.fn(), brand: vi.fn(), initial: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({
  createMerchantStoreScope: () => ports.store,
  createInitiallyAuthorizedMerchantStoreScope: () => ports.initial,
}));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => ports.brand }));
const id = (n: number) => `01902421-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-04T12:00:00.000Z";
const after = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
const filters = () => ({
  search: null,
  lifecycle: null,
  productType: null,
  limit: 50,
  cursor: null,
  includeArchived: false,
  hasActiveSku: null,
  missingTranslationLocale: null,
  updatedFrom: null,
  updatedUntil: null,
  createdFrom: null,
  createdUntil: null,
  sort: "updatedAt",
  direction: "DESC",
});
type Options = Parameters<typeof createMerchantProductListRuntime>[0];
beforeEach(() => vi.clearAllMocks());
function fixture() {
  // Controlled owner/SQL boundary; real list, bridge and FeatureControl parsers run.
  const state = {
    now: at,
    allowed: true,
    control: "Enabled",
    rows: true,
    expireAfterRead: false,
    expireAt: 5000,
    permissionValidUntil: null as string | null,
    revokeAt: Infinity,
    calls: 0,
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
    locale: "fr-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const allowed = vi.fn(async () => {
    events.push("navigation");
    return state.allowed && ++state.calls < state.revokeAt;
  });
  const decision = (action: string) => ({
    effect: state.allowed ? "Allow" : "Deny",
    scopeKind: "Brand",
    action,
  });
  const authorizeActions = vi.fn(async (actions: readonly string[]) => {
    events.push("brand-iam");
    return actions.map(decision);
  });
  const scope = {
    tenantReference: id(1),
    actorReference: id(4),
    selectedStoreReference: id(3),
    context: createTenantContext(actor, brand, null, at),
    authorizeActions,
    authorizeActionsWithValidity: async (actions: readonly string[]) => ({
      decisions: await authorizeActions(actions),
      validUntil: state.permissionValidUntil,
    }),
    authorizeAction: vi.fn(async (action: string) => decision(action)),
  };
  const selected = {
    selected: { tenantReference: id(1) },
    actorReference: id(4),
    sessionReference: id(5),
    context: createTenantContext(actor, brand, store, at),
    store,
    allowed,
    authorizationValidUntil: () => null,
  };
  const seenTransactions: unknown[] = [];
  ports.store.mockImplementation(async (tx, _cookie, action, session) => {
    expect(action).toBe("merchant.access");
    if (session !== undefined) expect(session).toBe(id(5));
    seenTransactions.push(tx);
    return selected;
  });
  ports.initial.mockImplementation(async (tx, cookie, session) => {
    const current = await ports.store(tx, cookie, "merchant.access", session);
    const action = parseBusinessAction("merchant.access"),
      actorReference = actor.actorReference;
    if (!actorReference) throw new Error("Fixture requires actual User");
    const admitted = await current.allowed();
    const initialAuthorization = evaluatePermission({
      tenantContext: current.context,
      action,
      resourceScope: {
        kind: "Store",
        brandReference: brand.brandReference,
        storeReference: store.storeReference,
      },
      policySnapshotReference: parsePolicyReference(id(70)),
      policyVersion: parsePolicyVersion(1),
      evidence: admitted
        ? [
            {
              source: "RolePermission",
              evidenceReference: parseEvidenceReference(id(71)),
              action,
              actorReference,
              roleReference: parseRoleReference(id(72)),
              brandReference: brand.brandReference,
              storeReference: store.storeReference,
              effectiveFrom: parseEvidenceInstant(at),
              effectiveUntil: null,
            },
          ]
        : [],
    });
    return Object.freeze({
      ...current,
      initialAuthorization,
      initialObservedAt: current.context.resolvedAt,
    });
  });
  ports.brand.mockImplementation(async (tx, _cookie, session) => {
    expect(session).toBe(id(5));
    seenTransactions.push(tx);
    return scope;
  });
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    if (sql.includes("pg_catalog.pg_constraint"))
      return { rows: [{ complete: true }], rowCount: 1 };
    if (sql.includes("FROM bop_feature_control.control_version")) {
      expect(values).toEqual([id(2), id(3), "catalog.product.list"]);
      events.push("feature-read");
      return {
        rows: state.rows
          ? [
              {
                definition: createFeatureControlAdministrationDefinition({
                  controlId: id(6),
                  key: "catalog.product.list",
                  description: "Synthetic Product list control",
                  version: 1,
                  ownerReference: id(7),
                  purposeCode: "PRODUCT_LIST",
                  scope: { kind: "Brand", brandReference: id(2), storeReference: null },
                  source: "BrandOverride",
                  defaultValue: "Disabled",
                  configuredValue: state.control,
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
                }),
                recordedAt: at,
                dependencies: [],
              },
            ]
          : [],
        rowCount: state.rows ? 1 : 0,
      };
    }
    if (sql.includes("LEFT JOIN rms_catalog.product_source_head"))
      return {
        rows: [
          {
            generation: {
              generationReference: id(600),
              brandReference: id(2),
              sourceRevision: "0",
              sourceDigest: "sha256:" + "1".repeat(64),
              projectedAt: at,
              productCount: 0,
              coverage: "CatalogProductDraftV1",
              partial: true,
            },
            revision: "0",
            count: "0",
          },
        ],
        rowCount: 1,
      };
    if (sql.includes("WITH source AS")) {
      expect(values).toContain("fr-CA");
      events.push("catalog-read");
      if (state.expireAfterRead) state.now = after(state.expireAt);
      return { rows: [{ asOfUtc: at, items: [] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const tx = { query };
  const run: Options["merchant"]["transactions"]["run"] = async (work) => {
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
  const merchant = {
    now: () => state.now,
    transactions: { run },
    currentActor: vi.fn(),
    validateAssociation: vi.fn(),
  } as unknown as Options["merchant"];
  const options = { merchant, cursorKey: new Uint8Array(32).fill(17) };
  const load = createMerchantProductListRuntime(options);
  const request = { sessionCookie: "synthetic-cookie", filters: filters() };
  return {
    state,
    events,
    scope,
    selected,
    query,
    tx,
    seenTransactions,
    authorizeActions,
    merchant,
    options,
    load,
    request,
  };
}
it("uses one physical transaction and real list/control readers with actual Store locale", async () => {
  const f = fixture();
  const result = await f.load(f.request);
  expect(result.items).toEqual([]);
  expect(f.events.filter((event) => event === "BEGIN")).toHaveLength(1);
  expect(f.events.at(-1)).toBe("COMMIT");
  expect(new Set(f.seenTransactions).size).toBe(1);
  expect(f.events.indexOf("feature-read")).toBeLessThan(f.events.indexOf("catalog-read"));
  expect(f.events.lastIndexOf("brand-iam")).toBeGreaterThan(f.events.indexOf("catalog-read"));
  expect(
    f.authorizeActions.mock.calls.some(
      ([actions]) =>
        actions.includes("catalog.product.read") && actions.includes("catalog.sku.read"),
    ),
  ).toBe(true);
  expect(f.authorizeActions.mock.calls.flatMap(([actions]) => actions)).not.toContain(
    "organization.manage",
  );
});
it.each(["Disabled", "Missing"])(
  "does not read Products for an actual %s capability",
  async (control) => {
    const f = fixture();
    f.state.control = "Disabled";
    f.state.rows = control !== "Missing";
    await expect(f.load(f.request)).rejects.toMatchObject({ code: "FeatureDisabled" });
    expect(f.events).not.toContain("catalog-read");
    expect(f.events.at(-1)).toBe("ROLLBACK");
  },
);
it("denies current Brand IAM and mismatched Store identity without Catalog reads", async () => {
  const f = fixture();
  f.state.allowed = false;
  await expect(f.load(f.request)).rejects.toMatchObject({ code: "Denied" });
  expect(f.events).not.toContain("catalog-read");
  const g = fixture();
  g.scope.selectedStoreReference = id(99);
  await expect(g.load(g.request)).rejects.toMatchObject({ code: "Denied" });
  expect(g.events).not.toContain("catalog-read");
});
it("retains the original five-second deadline after the owning query", async () => {
  const f = fixture();
  f.state.expireAfterRead = true;
  await expect(f.load(f.request)).rejects.toMatchObject({ code: "Unavailable" });
  expect(f.events).toContain("catalog-read");
  expect(f.events.at(-1)).toBe("ROLLBACK");
});
it("rechecks navigation through the final authority guard", async () => {
  const baseline = fixture();
  await baseline.load(baseline.request);
  const f = fixture();
  f.state.revokeAt = baseline.state.calls;
  await expect(f.load(f.request)).rejects.toThrow();
  expect(f.events).toContain("catalog-read");
  expect(f.events.at(-1)).toBe("ROLLBACK");
});
it("captures the cursor, runtime ports, and filters before awaits", async () => {
  const f = fixture();
  const first = ports.store.getMockImplementation();
  if (!first) throw Error("Missing synthetic scope source");
  ports.store.mockImplementationOnce(async (...args) => {
    f.request.filters.limit = 999;
    Object.assign(f.merchant, { now: () => after(6000), transactions: { run: vi.fn() } });
    f.options.cursorKey.fill(0);
    return first(...args);
  });
  expect((await f.load(f.request)).items).toEqual([]);
  expect(f.events.at(-1)).toBe("COMMIT");
});
it("rejects accessor filter values without executing them", async () => {
  const f = fixture(),
    getter = vi.fn();
  Object.defineProperty(f.request.filters, "search", { enumerable: true, get: getter });
  await expect(f.load(f.request)).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(f.events).not.toContain("BEGIN");
});

it("refuses owning action expiry during the list query before the original five seconds", async () => {
  const f = fixture();
  f.state.permissionValidUntil = after(1000);
  f.state.expireAfterRead = true;
  f.state.expireAt = 1000;
  await expect(f.load(f.request)).rejects.toMatchObject({ code: "Unavailable" });
  expect(f.events).toContain("catalog-read");
  expect(f.events.at(-1)).toBe("ROLLBACK");
});
