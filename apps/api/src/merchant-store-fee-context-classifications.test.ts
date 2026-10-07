import { beforeEach, expect, it, vi } from "vitest";
import { createIdentityActor } from "@bop/identity";
import { createBrand, createTenantContext, parseCanonicalInstant } from "@bop/tenant";
import {
  evaluatePermission,
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
  parseRoleReference,
  parseEvidenceReference,
} from "@bop/permission";
import {
  parseCatalogTaxClassificationRegistryCommand,
  catalogTaxClassificationRegistryRequest,
  catalogTaxClassificationRegistryEventId,
  type ProductTaxClassificationRegistryStoreOptions,
} from "@rms/catalog";
import { StoreSetupOperationError } from "@rms/store";
import {
  createMerchantStoreFeeContextClassifications,
  merchantStoreFeeContextChoicesIntent,
} from "./merchant-store-fee-context-classifications.js";
const mock = vi.hoisted(() => ({ brand: vi.fn() }));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => mock.brand }));
beforeEach(() => vi.resetAllMocks());
const id = (n: number) => `01902421-4500-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
type Tx = Parameters<
  ProductTaxClassificationRegistryStoreOptions["authority"]["holdUntilTransactionCompletes"]
>[0];
function fixture() {
  const state = {
    now: at,
    deadline: new Date(Date.parse(at) + 5000).toISOString(),
    denied: false,
    foreign: false,
    storeOnly: false,
    missing: false,
    freshDenied: false,
    step: 0,
    getter: false,
    getterCalls: 0,
    policyMalformed: false,
  };
  const command = parseCatalogTaxClassificationRegistryCommand({
    purposeCode: "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(4),
    actorKind: "User",
    operationReference: id(6),
    expectedRegistryVersion: 0,
    occurredAt: at,
    reasonCode: "INTERNAL_TEST",
    registry: {
      profile: "CatalogProductTaxClassificationRegistryV1",
      tenantReference: id(1),
      brandReference: id(2),
      registryReference: id(7),
      versionReference: id(8),
      registryVersion: 1,
      defaultLocale: "en-CA",
      previousSnapshotDigest: null,
      registeredAt: at,
      defaultClassificationReference: id(9),
      definitions: [
        {
          classificationReference: id(9),
          code: "STANDARD",
          localizedNames: { "en-CA": "Standard" },
          lifecycle: "Active",
        },
      ],
    },
  });
  const row = {
    command: catalogTaxClassificationRegistryRequest(command),
    registry: command.registry,
    intent_digest: command.intentDigest,
    snapshot_digest: command.snapshotDigest,
    event_id: catalogTaxClassificationRegistryEventId(command),
    coherent: true,
  };
  const statements: string[] = [];
  const tx: Tx = {
    async query<Row = Record<string, unknown>>(sql: string) {
      statements.push(sql);
      const rows =
        sql === "SELECT current_setting('transaction_isolation') isolation"
          ? [{ isolation: "read committed" }]
          : sql.startsWith("SELECT count(*)::text")
            ? [{ n: state.missing ? "0" : "1", bytes: state.missing ? "0" : "2048" }]
            : sql.startsWith("SELECT command_json")
              ? state.missing
                ? []
                : [row]
              : [];
      return { rows: rows as unknown as readonly Row[], rowCount: rows.length };
    },
  };
  const brand = createBrand({
    brandReference: id(2),
    code: "CONTROLLED",
    displayName: "Controlled",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
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
  if (actor.actorReference === null) throw new Error("Controlled reader required");
  const actorReference = actor.actorReference;
  const calls: string[][] = [];
  mock.brand.mockImplementation(async (actual, cookie, session) => {
    expect(actual).toBe(tx);
    expect(cookie).toBe("controlled");
    expect(session).toBe(id(5));
    return {
      tenantReference: state.foreign ? id(99) : id(1),
      actorReference: id(4),
      context: { brand },
      selectedStoreReference: id(3),
      async authorizeActionsWithValidity(actions: readonly string[]) {
        calls.push([...actions]);
        const tenantContext = createTenantContext(actor, brand, null, state.now);
        return {
          validUntil: state.deadline,
          decisions: actions.map((value) => {
            const action = parseBusinessAction(value);
            const decision = evaluatePermission({
              tenantContext,
              action,
              resourceScope: {
                kind: "Brand",
                brandReference: brand.brandReference,
                storeReference: null,
              },
              policySnapshotReference: parsePolicyReference(id(20)),
              policyVersion: parsePolicyVersion(1),
              evidence: state.denied
                ? []
                : [
                    {
                      source: "RolePermission",
                      evidenceReference: parseEvidenceReference(id(21)),
                      action,
                      actorReference,
                      roleReference: parseRoleReference(id(22)),
                      brandReference: brand.brandReference,
                      storeReference: null,
                      effectiveFrom: parseCanonicalInstant(at),
                      effectiveUntil: null,
                    },
                  ],
            });
            if (state.getter) {
              const malformed = { ...decision };
              Object.defineProperty(malformed, "audit", {
                enumerable: true,
                get() {
                  state.getterCalls++;
                  throw new Error("must not execute");
                },
              });
              return malformed;
            }
            if (state.policyMalformed) return { ...decision, policyVersion: 0 };
            return state.storeOnly ? { ...decision, scopeKind: "Store" } : decision;
          }),
        };
      },
    };
  });
  const hooks: { guard: () => Promise<void>; final: () => void }[] = [];
  const check = () => {
    const current = state.now;
    if (current >= state.deadline)
      throw new StoreSetupOperationError("STORE_SETUP_OPERATION_DEPENDENCY_UNAVAILABLE");
    state.now = new Date(Date.parse(current) + state.step).toISOString();
    return current;
  };
  const options: Parameters<typeof createMerchantStoreFeeContextClassifications>[0] = {
    persistence: {} as Parameters<
      typeof createMerchantStoreFeeContextClassifications
    >[0]["persistence"],
    transaction: tx,
    sessionCookie: "controlled",
    sessionReference: id(5),
    scope,
    originalObservedAt: at,
    check,
    deadline: () => state.deadline,
    tighten: (until) => {
      if (until < state.deadline) state.deadline = until;
      check();
    },
    fresh: async () => {
      check();
      if (state.freshDenied)
        throw new StoreSetupOperationError("STORE_SETUP_OPERATION_PERMISSION_DENIED");
    },
    registerBeforeCommit: async (actual, guard, final) => {
      expect(actual).toBe(tx);
      hooks.push({ guard, final });
    },
  };
  // Real Catalog owner/parser and genuine public Permission evaluation; SQL,
  // Brand session resolution and current Store authority are controlled ports.
  const source = createMerchantStoreFeeContextClassifications(options);
  const read = () => source.read(merchantStoreFeeContextChoicesIntent(scope));
  const commit = async () => {
    for (const hook of hooks) await hook.guard();
    for (const hook of hooks) hook.final();
    return source.assertFinalized();
  };
  return { source, read, commit, state, options, statements, calls, hooks };
}
it("holds the actual public registry and independent Brand fine permissions through final assertions", async () => {
  const f = fixture();
  const result = await f.read();
  expect(result).toMatchObject({
    profile: "TaxConfigClassificationChoicesV1",
    ...scope,
    sourceQualification: "NotEvaluated",
    choices: [{ classificationReference: id(9), code: "STANDARD" }],
  });
  expect(f.statements.some((sql) => sql.includes("pg_advisory_xact_lock_shared"))).toBe(true);
  await f.commit();
  expect(
    f.calls.every(
      (actions) =>
        JSON.stringify(actions) ===
        JSON.stringify(["catalog.manage", "catalog.tax-classification.read"]),
    ),
  ).toBe(true);
  expect(f.hooks).toHaveLength(1);
});
it.each(["denied", "storeOnly", "foreign"] as const)(
  "rejects %s Brand authority before exposing choices",
  async (key) => {
    const f = fixture();
    f.state[key] = true;
    await expect(f.read()).rejects.toMatchObject({
      code: "STORE_SETUP_OPERATION_PERMISSION_DENIED",
    });
  },
);
it("does not invent a registry when the actual owner has no records", async () => {
  const f = fixture();
  f.state.missing = true;
  await expect(f.read()).rejects.toMatchObject({
    code: "STORE_SETUP_OPERATION_DEPENDENCY_UNAVAILABLE",
  });
});
it("late fine withdrawal refuses COMMIT", async () => {
  const f = fixture();
  await f.read();
  f.state.denied = true;
  await expect(f.commit()).rejects.toMatchObject({
    code: "STORE_SETUP_OPERATION_PERMISSION_DENIED",
  });
});
it("late Store authority withdrawal remains mandatory", async () => {
  const f = fixture();
  await f.read();
  f.state.freshDenied = true;
  await expect(f.commit()).rejects.toMatchObject({
    code: "STORE_SETUP_OPERATION_PERMISSION_DENIED",
  });
});
it("tightens original lease and refuses natural expiry without renewal", async () => {
  const f = fixture();
  f.state.deadline = new Date(Date.parse(at) + 1000).toISOString();
  const result = await f.read();
  expect(result.validUntil).toBe(f.state.deadline);
  f.state.now = f.state.deadline;
  await expect(f.commit()).rejects.toMatchObject({
    code: "STORE_SETUP_OPERATION_DEPENDENCY_UNAVAILABLE",
  });
});
it("accepts a genuine advancing observation within the original deadline", async () => {
  const f = fixture();
  f.state.step = 2;
  const result = await f.read();
  expect(result.observedAt > at).toBe(true);
  await f.commit();
  expect(f.state.deadline).toBe(new Date(Date.parse(at) + 5000).toISOString());
});
it("captured port drift poisons held source", async () => {
  const f = fixture();
  await f.read();
  f.options.fresh = async () => undefined;
  await expect(f.commit()).rejects.toMatchObject({
    code: "STORE_SETUP_OPERATION_DEPENDENCY_UNAVAILABLE",
  });
});
it("requires completed host assertions before returning a finalized lease", async () => {
  const f = fixture();
  await f.read();
  expect(() => f.source.assertFinalized()).toThrowError(
    expect.objectContaining({ code: "STORE_SETUP_OPERATION_DEPENDENCY_UNAVAILABLE" }),
  );
});

it("rejects policy provenance corruption rather than accepting positive-shaped packets", async () => {
  const f = fixture();
  f.state.policyMalformed = true;
  await expect(f.read()).rejects.toMatchObject({
    code: "STORE_SETUP_OPERATION_DEPENDENCY_UNAVAILABLE",
  });
});
it("denies authority getters without executing them", async () => {
  const f = fixture();
  f.state.getter = true;
  await expect(f.read()).rejects.toMatchObject({
    code: "STORE_SETUP_OPERATION_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.state.getterCalls).toBe(0);
});
