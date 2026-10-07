import {
  createPostgresTransactionCurrentPermissionPolicySource,
  evaluatePermission,
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
  parseEvidenceReference,
  parseRoleReference,
  parseEvidenceInstant,
  type PermissionDecision,
} from "@bop/permission";
import { createIdentityActor } from "@bop/identity";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
const ports = vi.hoisted(() => ({ resolve: vi.fn(), factory: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({
  createInitiallyAuthorizedMerchantStoreScope: (...args: unknown[]) => {
    ports.factory(...args);
    return ports.resolve;
  },
}));
const id = (n: number) => "019024a0-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-04T12:00:00.000Z",
  until = "2026-10-04T12:00:05.000Z";
const actor = createIdentityActor({
  actorType: "User",
  actorReference: id(3),
  accountKind: "Workforce",
  status: "Active",
  authenticationMethod: "Oidc",
  verificationLevel: "SingleFactor",
  authenticatedAt: at,
  recentMfaAt: null,
});
const brand = createBrand({
  brandReference: id(2),
  code: "SYNTH",
  displayName: "Synthetic",
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Active",
  version: 1,
  createdAt: at,
  updatedAt: at,
});
const store = createStore({
  storeReference: id(4),
  brandReference: id(2),
  code: "SYNTH",
  displayName: "Synthetic",
  timeZone: "UTC",
  locale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Active",
  version: 1,
  createdAt: at,
  updatedAt: at,
});
beforeEach(() => vi.clearAllMocks());
function fixture() {
  let clock = at,
    boundary: string | null = null;
  const transaction = { query: vi.fn(async () => ({ rows: [] })) };
  const authorizeActions = vi.fn(async (actions: readonly string[]) =>
    actions.map((action) => ({ effect: "Allow", scopeKind: "Brand", action })),
  );
  const allowed = vi.fn(async () => true);
  const selected = {
    selected: { tenantReference: id(1) },
    context: createTenantContext(actor, brand, store, at),
    store,
    actorReference: id(3),
    sessionReference: id(5),
    initialAuthorization: owningDecision("merchant.access"),
    initialObservedAt: at,
    allowed,
    authorizationValidUntil: () => boundary,
  };
  ports.resolve.mockResolvedValue(selected);
  const scope = {
    tenantReference: id(1),
    context: createTenantContext(actor, brand, null, at),
    selectedStoreReference: id(4),
    actorReference: id(3),
    authorizeActions,
    authorizeActionsWithValidity: vi.fn(async (actions: readonly string[]) => ({
      decisions: await authorizeActions(actions),
      validUntil: boundary,
    })),
  };
  const options = {
    merchant: { now: () => clock, currentActor: vi.fn(), validateAssociation: vi.fn() } as never,
    transaction: transaction as never,
    scope: scope as never,
    sessionCookie: "synthetic-cookie",
    sessionReference: id(5),
    clock: { now: () => clock },
    originalValidUntil: until,
  };
  const bridge = createMerchantProductCurrentAuthorization(options);
  const request = {
    brandReference: id(2),
    storeReference: id(4),
    capabilityKey: "catalog.cat_product_edit",
    observedAt: at,
  };
  return {
    bridge,
    options,
    request,
    transaction,
    selected,
    allowed,
    authorizeActions,
    setBoundary(value: string | null) {
      boundary = value;
    },
    scope,
    setTime(value: string) {
      clock = value;
    },
  };
}
it("captures without reads, uses fresh Brand decisions on each call, and preserves explicit hyphenated actions", async () => {
  const f = fixture();
  expect(f.authorizeActions).not.toHaveBeenCalled();
  expect(ports.resolve).not.toHaveBeenCalled();
  const actions = ["catalog.product.acknowledge-warnings", "pricing.price-book.manage"];
  await f.bridge.authorizeActions(actions);
  f.authorizeActions.mockResolvedValue(
    actions.map((action) => ({ action, effect: "Deny", scopeKind: "Brand" })),
  );
  await expect(f.bridge.authorizeActions(actions)).rejects.toHaveProperty(
    "code",
    "CATALOG_PERMISSION_DENIED",
  );
  expect(f.authorizeActions).toHaveBeenCalledTimes(2);
  expect(() => f.bridge.assertCurrent()).toThrow(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );
});
it.each(["effect", "scopeKind", "action", "missing"])(
  "refuses %s substitution in permission results",
  async (field) => {
    const f = fixture();
    const decisions = [{ action: "catalog.manage", effect: "Allow", scopeKind: "Brand" }];
    if (field === "missing") decisions.pop();
    else Object.assign(decisions[0] ?? {}, { [field]: "Other" });
    f.authorizeActions.mockResolvedValue(decisions);
    await expect(f.bridge.authorizeActions(["catalog.manage"])).rejects.toHaveProperty(
      "code",
      "CATALOG_PERMISSION_DENIED",
    );
  },
);
it("rejects sparse, getter, duplicate, oversized and invalid action lists before permission reads", async () => {
  const getter = vi.fn();
  const accessor: string[] = [];
  Object.defineProperty(accessor, "0", { get: getter, enumerable: true });
  for (const actions of [
    [],
    new Array<string>(1),
    accessor,
    ["catalog.manage", "catalog.manage"],
    Array.from({ length: 17 }, (_, i) => `catalog.action${i}`),
    ["catalog.manage "],
  ]) {
    const f = fixture();
    await expect(f.bridge.authorizeActions(actions)).rejects.toHaveProperty(
      "code",
      "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
    expect(f.authorizeActions).not.toHaveBeenCalled();
  }
  expect(getter).not.toHaveBeenCalled();
});
it("holds the original authenticated Store scope around the capability consumer", async () => {
  const f = fixture(),
    result = {};
  f.setTime("2026-10-04T12:00:00.001Z");
  const callback = vi.fn(async (context) => {
    expect(context).toEqual(createTenantContext(actor, brand, store, at));
    return result;
  });
  expect(await f.bridge.withCurrentStoreScope(f.request, callback)).toBe(result);
  expect(callback).toHaveBeenCalledTimes(1);
  expect(f.allowed).toHaveBeenCalledTimes(1);
  expect(ports.resolve).toHaveBeenCalledExactlyOnceWith(f.transaction, "synthetic-cookie", id(5));
  expect(JSON.stringify(f.bridge)).not.toContain("synthetic-cookie");
});
it.each(["tenant", "brand", "store", "actor", "session", "denied"])(
  "rejects current %s drift before returning a capability context",
  async (change) => {
    const f = fixture();
    const altered = { ...f.selected };
    if (change === "tenant") altered.selected = { tenantReference: id(99) };
    if (change === "brand")
      altered.context = {
        ...altered.context,
        brand: { ...brand, brandReference: id(99) },
      } as never;
    if (change === "store") altered.store = { ...store, storeReference: id(99) } as never;
    if (change === "actor") altered.actorReference = id(99);
    if (change === "session") altered.sessionReference = id(99);
    if (change === "denied") {
      f.allowed.mockResolvedValue(false);
      altered.initialAuthorization = owningDecision("merchant.access", "RolePermission", 3, false);
    }
    ports.resolve.mockResolvedValue(altered);
    const consumer = vi.fn();
    await expect(f.bridge.withCurrentStoreScope(f.request, consumer)).rejects.toHaveProperty(
      "code",
      "CATALOG_PERMISSION_DENIED",
    );
    expect(consumer).not.toHaveBeenCalled();
  },
);
it("rejects late revocation even if the consumer completed successfully", async () => {
  const f = fixture();
  await expect(
    f.bridge.withCurrentStoreScope(f.request, async () => {
      f.allowed.mockResolvedValue(false);
      return "tentative";
    }),
  ).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  expect(() => f.bridge.assertCurrent()).toThrow();
});
it.each(["brandReference", "storeReference", "capabilityKey", "observedAt", "extra"])(
  "rejects mismatched capability %s before Store reads",
  async (key) => {
    const f = fixture();
    await expect(
      f.bridge.withCurrentStoreScope(
        { ...f.request, [key]: key === "observedAt" ? until : "other" },
        vi.fn(),
      ),
    ).rejects.toThrow();
    expect(ports.resolve).not.toHaveBeenCalled();
  },
);
it.each(["expiry", "reverse", "query"])(
  "retains original %s fence across awaited permission reads",
  async (change) => {
    const f = fixture();
    f.authorizeActions.mockImplementation(async (actions) => {
      if (change === "expiry") f.setTime(until);
      if (change === "reverse") f.setTime("2026-10-04T11:59:59.999Z");
      if (change === "query") f.transaction.query = vi.fn(async () => ({ rows: [] }));
      return actions.map((action) => ({ action, effect: "Allow", scopeKind: "Brand" }));
    });
    await expect(f.bridge.authorizeActions(["catalog.manage"])).rejects.toHaveProperty(
      "code",
      "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
  },
);
it("does not retain an expired or renewed five-second lease", () => {
  const f = fixture();
  expect(() =>
    createMerchantProductCurrentAuthorization({ ...f.options, originalValidUntil: at }),
  ).toThrow();
  expect(() =>
    createMerchantProductCurrentAuthorization({
      ...f.options,
      originalValidUntil: "2026-10-04T12:00:05.001Z",
    }),
  ).toThrow();
  f.setTime(until);
  expect(() => f.bridge.assertCurrent()).toThrow();
});

it.each([
  "pricing.price_book_list",
  "pricing.price_book_editor",
  "catalog.cat_product_list",
  "catalog.cat_product_create",
  "catalog.cat_product_detail",
  "catalog.cat_sku_detail",
] as const)(
  "binds fixed capability %s without allowing Edit or arbitrary server keys",
  async (capabilityKey) => {
    const f = fixture();
    const list = createMerchantProductCurrentAuthorization({
      ...f.options,
      capabilityKey,
    });
    const marker = {};
    expect(
      await list.withCurrentStoreScope({ ...f.request, capabilityKey }, async () => marker),
    ).toBe(marker);
    await expect(list.withCurrentStoreScope(f.request, vi.fn())).rejects.toThrow();
    expect(() =>
      createMerchantProductCurrentAuthorization({
        ...f.options,
        capabilityKey: "catalog.unknown" as never,
      }),
    ).toThrow();
  },
);

it("holds the earliest real action boundary through later asynchronous guards", async () => {
  const f = fixture();
  f.setBoundary("2026-10-04T12:00:01.000Z");
  await f.bridge.authorizeActions(["catalog.sku.activate"]);
  f.setTime("2026-10-04T12:00:00.999Z");
  f.setBoundary(null);
  await f.bridge.authorizeActions(["catalog.manage"]);
  f.bridge.assertCurrent();
  f.setTime("2026-10-04T12:00:01.000Z");
  expect(() => f.bridge.assertCurrent()).toThrow();
});
it("retains actual Store and Session boundaries even without a Brand action read", async () => {
  const f = fixture();
  f.setBoundary("2026-10-04T12:00:01.000Z");
  await f.bridge.withCurrentStoreScope(f.request, async () => undefined);
  f.setTime("2026-10-04T12:00:01.000Z");
  expect(() => f.bridge.assertCurrent()).toThrow();
});
it.each([undefined, "invalid", at])(
  "refuses missing, invalid or already-expired owner boundary %s",
  async (boundary) => {
    const f = fixture();
    f.scope.authorizeActionsWithValidity.mockImplementation(async (actions) => ({
      decisions: await f.authorizeActions(actions),
      validUntil: boundary as never,
    }));
    await expect(f.bridge.authorizeActions(["catalog.sku.activate"])).rejects.toHaveProperty(
      "code",
      "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
  },
);
it("rejects expiry reached while the owning batch is still awaited", async () => {
  const f = fixture();
  f.setBoundary("2026-10-04T12:00:01.000Z");
  f.authorizeActions.mockImplementation(async (actions) => {
    f.setTime("2026-10-04T12:00:01.000Z");
    return actions.map((action) => ({ effect: "Allow", scopeKind: "Brand", action }));
  });
  await expect(f.bridge.authorizeActions(["catalog.sku.activate"])).rejects.toThrow();
});

it.each([
  "catalog.cat_optionset_list",
  "catalog.cat_optionset_create",
  "catalog.cat_optionset_detail",
  "catalog.cat_optionset_edit",
] as const)(
  "holds the actual current Store for %s and refuses late withdrawn authority",
  async (capabilityKey) => {
    const f = fixture();
    const bridge = createMerchantProductCurrentAuthorization({ ...f.options, capabilityKey });
    const request = { ...f.request, capabilityKey };
    const result = await bridge.withCurrentStoreScope(request, async (context) => {
      expect(String(context.brand.brandReference)).toBe(id(2));
      expect(String(context.store?.storeReference)).toBe(id(4));
      expect(String(context.actor.actorReference)).toBe(id(3));
      return "Synthetic current scope held";
    });
    expect(result).toBe("Synthetic current scope held");
    await expect(
      bridge.withCurrentStoreScope(request, async () => {
        f.allowed.mockResolvedValue(false);
        return "Withdrawn";
      }),
    ).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
    expect(() => bridge.assertCurrent()).toThrow();
  },
);

it("observes the shortest actual authorization deadline without renewing it or returning Allow", async () => {
  const f = fixture();
  const lease = f.bridge.leaseDeadline;
  expect(typeof lease).toBe("function");
  f.setBoundary("2026-10-04T12:00:02.000Z");
  await f.bridge.authorizeActions(["catalog.manage", "catalog.option_set.update"]);
  expect(lease?.()).toBe("2026-10-04T12:00:02.000Z");
  f.setBoundary(until);
  await f.bridge.authorizeActions(["catalog.manage", "catalog.option_set.update"]);
  expect(lease?.()).toBe("2026-10-04T12:00:02.000Z");
  f.setTime("2026-10-04T12:00:02.000Z");
  expect(() => lease?.()).toThrow(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );
});
it("a denied actual authorization poisons subsequent lease observations", async () => {
  const f = fixture();
  await f.bridge.authorizeActions(["catalog.manage"]);
  f.authorizeActions.mockResolvedValue([
    { action: "catalog.manage", effect: "Deny", scopeKind: "Brand" },
  ]);
  await expect(f.bridge.authorizeActions(["catalog.manage"])).rejects.toHaveProperty(
    "code",
    "CATALOG_PERMISSION_DENIED",
  );
  expect(() => f.bridge.leaseDeadline?.()).toThrow(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );
});

function evidenceFixture() {
  const f = fixture(),
    authorize = f.bridge.authorizeActionsWithDecisions;
  if (typeof authorize !== "function") throw Error("actual decision evidence port missing");
  return {
    ...f,
    bridge: Object.freeze({ ...f.bridge, authorizeActionsWithDecisions: authorize.bind(f.bridge) }),
  };
}
// Synthetic policy identities; the actual public Permission owner computes full
// decision evidence. No three-field fixture is promoted into owning proof.
function owningDecision(
  actionValue: string,
  source: "ExplicitAllow" | "RolePermission" = "RolePermission",
  policyVersion = 3,
  allow = true,
): PermissionDecision {
  const action = parseBusinessAction(actionValue),
    tenantContext = createTenantContext(actor, brand, null, at),
    actorReference = tenantContext.actor.actorReference;
  if (!actorReference) throw Error("Synthetic fixture requires its actual User actor");
  return evaluatePermission({
    tenantContext,
    action,
    resourceScope: { kind: "Brand", brandReference: brand.brandReference, storeReference: null },
    policySnapshotReference: parsePolicyReference(id(60)),
    policyVersion: parsePolicyVersion(policyVersion),
    evidence: allow
      ? [
          {
            source,
            evidenceReference: parseEvidenceReference(id(61)),
            action,
            actorReference,
            roleReference: source === "RolePermission" ? parseRoleReference(id(62)) : null,
            brandReference: brand.brandReference,
            storeReference: null,
            effectiveFrom: parseEvidenceInstant(at),
            effectiveUntil: null,
          },
        ]
      : [],
  });
}
it("returns fresh detached full actual Permission decisions preserving snapshot/version/reason/source/audit", async () => {
  const f = evidenceFixture(),
    actions = ["catalog.manage", "publishing.release.publish"],
    original = actions.map((action) => {
      const d = owningDecision(action, "RolePermission");
      return { ...d, audit: { ...d.audit } };
    });
  f.authorizeActions.mockResolvedValue(original);
  const result = await f.bridge.authorizeActionsWithDecisions(actions);
  expect(result).toEqual(original);
  expect(result).not.toBe(original);
  expect(result[0]).not.toBe(original[0]);
  expect(result[0]?.audit).not.toBe(original[0]?.audit);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result[0])).toBe(true);
  expect(Object.isFrozen(result[0]?.audit)).toBe(true);
  Object.assign(original[0] ?? {}, { policyVersion: 99 });
  Object.assign(original[0]?.audit ?? {}, { source: "InvalidPolicy" });
  expect(result[0]?.policyVersion).toBe(3);
  expect(result[0]?.audit.source).toBe("RolePermission");
  const renewed = actions.map((action) => owningDecision(action, "ExplicitAllow", 4));
  f.authorizeActions.mockResolvedValue(renewed);
  const second = await f.bridge.authorizeActionsWithDecisions(actions);
  expect(second).toEqual(renewed);
  expect(second[0]?.reason).toBe("EXPLICIT_ALLOW");
  expect(second[0]?.policySnapshotReference).toBe(id(60));
  expect(f.authorizeActions).toHaveBeenCalledTimes(2);
});
it("legacy void admission stays compatible while evidence method rejects incomplete decisions and poisons holder", async () => {
  const f = evidenceFixture();
  expect(await f.bridge.authorizeActions(["catalog.manage"])).toBeUndefined();
  await expect(f.bridge.authorizeActionsWithDecisions(["catalog.manage"])).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
  expect(() => f.bridge.assertCurrent()).toThrow();
});
it.each([
  "policySnapshotReference",
  "policyVersion",
  "reason",
  "source",
  "audit",
  "extra",
  "getter",
])("full decision refuses malformed %s rather than synthesizing evidence", async (field) => {
  const f = evidenceFixture(),
    decision = {
      ...owningDecision("catalog.manage"),
      audit: { ...owningDecision("catalog.manage").audit },
    },
    getter = vi.fn();
  if (field === "policySnapshotReference")
    Object.assign(decision, { policySnapshotReference: "absent" });
  if (field === "policyVersion") Object.assign(decision, { policyVersion: 0 });
  if (field === "reason") Object.assign(decision, { reason: "EXPLICIT_ALLOW" });
  if (field === "source") Object.assign(decision, { source: "DefaultDeny" });
  if (field === "audit") Object.assign(decision.audit, { source: "ExplicitAllow" });
  if (field === "extra") Object.assign(decision, { token: "must not escape" });
  if (field === "getter")
    Object.defineProperty(decision, "policySnapshotReference", { get: getter, enumerable: true });
  f.authorizeActions.mockResolvedValue([decision]);
  await expect(f.bridge.authorizeActionsWithDecisions(["catalog.manage"])).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
  expect(getter).not.toHaveBeenCalled();
  expect(() => f.bridge.assertCurrent()).toThrow();
});
it("full evidence never caches an earlier Allow across actual owner denial", async () => {
  const f = evidenceFixture();
  f.authorizeActions.mockResolvedValue([owningDecision("catalog.manage")]);
  await f.bridge.authorizeActionsWithDecisions(["catalog.manage"]);
  f.authorizeActions.mockResolvedValue([
    owningDecision("catalog.manage", "RolePermission", 4, false),
  ]);
  await expect(f.bridge.authorizeActionsWithDecisions(["catalog.manage"])).rejects.toHaveProperty(
    "code",
    "CATALOG_PERMISSION_DENIED",
  );
  expect(f.authorizeActions).toHaveBeenCalledTimes(2);
  expect(() => f.bridge.leaseDeadline?.()).toThrow();
});
it.each(["expiry", "reverse", "query"])(
  "full evidence preserves late %s fence and poisons subsequent reads",
  async (change) => {
    const f = evidenceFixture();
    f.authorizeActions.mockImplementation(async (actions) => {
      if (change === "expiry") f.setTime(until);
      if (change === "reverse") f.setTime("2026-10-04T11:59:59.999Z");
      if (change === "query") f.transaction.query = vi.fn(async () => ({ rows: [] }));
      return actions.map((action) => owningDecision(action));
    });
    await expect(f.bridge.authorizeActionsWithDecisions(["catalog.manage"])).rejects.toHaveProperty(
      "code",
      "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
    expect(() => f.bridge.assertCurrent()).toThrow();
  },
);
it("full evidence retains shortest owning lease without renewal and captures original owning port", async () => {
  const f = evidenceFixture(),
    lease = f.bridge.leaseDeadline;
  if (!lease) throw Error("actual bridge lease observer missing");
  f.setBoundary("2026-10-04T12:00:01.000Z");
  f.authorizeActions.mockImplementation(async (actions) =>
    actions.map((action) => owningDecision(action)),
  );
  f.scope.authorizeActionsWithValidity = vi.fn(async () => {
    throw Error("substituted port must not run");
  });
  await f.bridge.authorizeActionsWithDecisions(["catalog.manage"]);
  expect(lease()).toBe("2026-10-04T12:00:01.000Z");
  expect(f.scope.authorizeActionsWithValidity).not.toHaveBeenCalled();
  f.setBoundary(null);
  await f.bridge.authorizeActionsWithDecisions(["catalog.manage"]);
  expect(lease()).toBe("2026-10-04T12:00:01.000Z");
  f.setTime("2026-10-04T12:00:01.000Z");
  await expect(f.bridge.authorizeActionsWithDecisions(["catalog.manage"])).rejects.toThrow();
});
it("concurrent evidence/void action reentry poisons original awaited permission result", async () => {
  const f = evidenceFixture();
  let release: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.authorizeActions.mockImplementation(async (actions) => {
    await pending;
    return actions.map((action) => owningDecision(action));
  });
  const first = f.bridge.authorizeActionsWithDecisions(["catalog.manage"]);
  await expect(f.bridge.authorizeActions(["catalog.manage"])).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
  release();
  await expect(first).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.authorizeActions).toHaveBeenCalledTimes(1);
});
it("current Store/session revocation poisons already returned evidence before later use", async () => {
  const f = evidenceFixture();
  f.authorizeActions.mockResolvedValue([owningDecision("publishing.release.publish")]);
  const decisions = await f.bridge.authorizeActionsWithDecisions(["publishing.release.publish"]);
  expect(decisions[0]?.effect).toBe("Allow");
  await expect(
    f.bridge.withCurrentStoreScope(f.request, async () => {
      f.allowed.mockResolvedValue(false);
      return decisions;
    }),
  ).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  expect(() => f.bridge.assertCurrent()).toThrow();
});

it("evidence method rejects invalid actions before fresh owner reads rather than admitting a legacy shortcut", async () => {
  const f = evidenceFixture(),
    getter = vi.fn(),
    actions: string[] = [];
  Object.defineProperty(actions, "0", { get: getter, enumerable: true });
  await expect(f.bridge.authorizeActionsWithDecisions(actions)).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
  expect(getter).not.toHaveBeenCalled();
  expect(f.authorizeActions).not.toHaveBeenCalled();
});

it("consumes initial actual navigation once before callback and freshly rechecks allowed after callback", async () => {
  const f = fixture();
  await f.bridge.withCurrentStoreScope(f.request, async () => {
    expect(f.allowed).not.toHaveBeenCalled();
    expect(f.selected.initialAuthorization).toEqual(owningDecision("merchant.access"));
    return "result";
  });
  expect(f.allowed).toHaveBeenCalledOnce();
});
it.each(["missing", "wrongAction", "past", "future", "expiry"])(
  "refuses malformed or stale initial Store observation %s",
  async (change) => {
    const f = fixture();
    const current = {
      ...f.selected,
      initialAuthorization: change === "missing" ? null : f.selected.initialAuthorization,
    };
    if (change === "wrongAction") current.initialAuthorization = owningDecision("catalog.manage");
    if (change === "past") current.initialObservedAt = "2026-10-04T11:59:59.999Z";
    if (change === "future") current.initialObservedAt = "2026-10-04T12:00:00.001Z";
    if (change === "expiry") f.setTime(until);
    ports.resolve.mockResolvedValue(current);
    const work = vi.fn();
    await expect(f.bridge.withCurrentStoreScope(f.request, work)).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
  },
);

it("passes the same transaction Permission owner into every direct Store checkpoint while later allowed stays fresh", async () => {
  const f = fixture(),
    policy = createPostgresTransactionCurrentPermissionPolicySource(f.transaction),
    bridge = createMerchantProductCurrentAuthorization({ ...f.options, permissionPolicy: policy });
  await bridge.withCurrentStoreScope(f.request, async () => undefined);
  expect(ports.factory).toHaveBeenCalledTimes(1);
  expect(ports.factory.mock.calls[0]?.[1]).toBe(policy);
  expect(f.allowed).toHaveBeenCalledTimes(1);
  f.allowed.mockResolvedValue(false);
  await expect(
    bridge.withCurrentStoreScope(f.request, async () => undefined),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(ports.factory.mock.calls[1]?.[1]).toBe(policy);
});
it("poisons a changed transaction Permission owner instead of accepting a replacement", async () => {
  const f = fixture(),
    original = createPostgresTransactionCurrentPermissionPolicySource(f.transaction),
    options = { ...f.options, permissionPolicy: original },
    bridge = createMerchantProductCurrentAuthorization(options);
  options.permissionPolicy = createPostgresTransactionCurrentPermissionPolicySource(f.transaction);
  expect(() => bridge.assertCurrent()).toThrow(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );
  expect(ports.factory).not.toHaveBeenCalled();
});
