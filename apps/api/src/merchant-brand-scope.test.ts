import { createIdentityActor } from "@bop/identity";
import { beforeEach, expect, it, vi } from "vitest";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import {
  createPostgresCurrentPermissionPolicySource,
  evaluatePermission,
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
  parseEvidenceReference,
  parseRoleReference,
  parseEvidenceInstant,
} from "@bop/permission";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
const ports = vi.hoisted(() => ({
  resolve: vi.fn(),
  storeFactory: vi.fn(),
  initialFactory: vi.fn(),
  find: vi.fn(),
  membership: vi.fn(),
  authorize: vi.fn(),
  validity: vi.fn(),
  source: vi.fn(),
  batch: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({
  createMerchantStoreScope: (...args: unknown[]) => {
    ports.storeFactory(...args);
    return ports.resolve;
  },
  createInitiallyAuthorizedMerchantStoreScope: (...args: unknown[]) => {
    ports.initialFactory(...args);
    return ports.resolve;
  },
}));
vi.mock("@bop/membership", () => ({
  createPostgresCurrentMembershipSource: (...args: unknown[]) => {
    ports.source(...args);
    return { findMemberships: ports.find };
  },
  resolveActiveMembership: ports.membership,
}));
vi.mock("@bop/permission", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/permission")>()),
  createPostgresCurrentPermissionPolicySource: () => ({
    authorize: ports.authorize,
    async authorizeActionsWithRoles(request: { actions: readonly string[] }) {
      ports.batch(request);
      const { actions, ...facts } = request;
      const decisions = [];
      let validUntil: string | null = null;
      for (const action of actions) {
        const input = { ...facts, action };
        decisions.push(await ports.authorize(input));
        const until = await ports.validity(input);
        if (
          until !== null &&
          (validUntil === null || typeof until !== "string" || until < validUntil)
        )
          validUntil = until;
      }
      return { decisions, activeRoleCodes: [], validUntil };
    },
    async authorizeWithRoles(request: unknown) {
      return {
        decision: await ports.authorize(request),
        activeRoleCodes: [],
        validUntil: await ports.validity(request),
      };
    },
  }),
}));
const id = (n: number) => "0190ab55-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-14T08:00:00.000Z";
const brand = createBrand({
  brandReference: id(1),
  code: "DEMO",
  displayName: "Synthetic Brand",
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Active",
  version: 1,
  createdAt: at,
  updatedAt: at,
});
const actor = createIdentityActor({
  actorType: "User",
  actorReference: id(2),
  accountKind: "Workforce",
  status: "Active",
  authenticationMethod: "Oidc",
  verificationLevel: "SingleFactor",
  authenticatedAt: at,
  recentMfaAt: null,
});
const store = createStore({
  storeReference: id(4),
  brandReference: id(1),
  code: "SYNTH_STORE",
  displayName: "Synthetic Store",
  timeZone: "America/Toronto",
  locale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Active",
  version: 1,
  createdAt: at,
  updatedAt: at,
});
const selected = () => ({
  selected: { tenantReference: id(3) },
  context: createTenantContext(actor, brand, store, at),
  store: { storeReference: id(4) },
  actorReference: id(2),
  sessionReference: id(6),
  initialObservedAt: at,
  initialAuthorization: navigationDecision(),
  allowed: async () => true,
  authorizationValidUntil: (): string | null => null,
});
beforeEach(() => {
  vi.clearAllMocks();
  ports.resolve.mockResolvedValue(selected());
  ports.find.mockResolvedValue([]);
  ports.membership.mockReturnValue({ membershipReference: id(5) });
  ports.validity.mockResolvedValue(null);
  ports.authorize.mockImplementation(async (request) => ({
    effect: "Allow",
    scopeKind: "Brand",
    action: request.action,
  }));
});
const resolve = () =>
  createMerchantBrandScope({ now: () => at } as never)({} as never, "synthetic-cookie", id(6));
it("requires a separate Brand decision with no Store assignment", async () => {
  const scope = await resolve();
  expect(scope.context.scopeKind).toBe("Brand");
  expect(scope.context.store).toBeNull();
  expect(scope.selectedStoreReference).toBe(id(4));
  expect(await scope.authorizeAction("pricing.price-book.manage")).toMatchObject({
    effect: "Allow",
    scopeKind: "Brand",
  });
  expect(ports.source).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      scopeKind: "Store",
      store: expect.objectContaining({ storeReference: id(4) }),
    }),
  );
  expect(ports.authorize).toHaveBeenCalledWith(
    expect.objectContaining({
      storeAssignment: null,
      tenantContext: expect.objectContaining({ scopeKind: "Brand", store: null }),
      action: "pricing.price-book.manage",
    }),
  );
  expect(ports.resolve).toHaveBeenLastCalledWith(
    expect.anything(),
    "synthetic-cookie",
    "merchant.access",
    id(6),
  );
});
it("does not elevate a Store-only approval", async () => {
  ports.authorize.mockResolvedValue({
    effect: "Allow",
    scopeKind: "Store",
    action: "pricing.price-book.approve",
  });
  expect(await (await resolve()).authorizeAction("pricing.price-book.approve")).toBeNull();
});
it("preserves a current Brand denial", async () => {
  ports.authorize.mockResolvedValue({
    effect: "Deny",
    scopeKind: "Brand",
    action: "pricing.price-book.manage",
  });
  expect(await (await resolve()).authorizeAction("pricing.price-book.manage")).toMatchObject({
    effect: "Deny",
  });
});
it.each(["tenant", "store", "actor", "revoked"])(
  "rejects changed %s before Brand policy",
  async (changed) => {
    const scope = await resolve(),
      next = selected();
    if (changed === "tenant") next.selected.tenantReference = id(90);
    if (changed === "store") next.store.storeReference = id(90);
    if (changed === "actor") next.actorReference = id(90);
    if (changed === "revoked") next.allowed = async () => false;
    ports.resolve.mockResolvedValue(next);
    expect(await scope.authorizeAction("pricing.price-book.manage")).toBeNull();
    expect(ports.authorize).not.toHaveBeenCalled();
  },
);
it("rejects inaccessible initial selection", async () => {
  ports.resolve.mockResolvedValue({ ...selected(), allowed: async () => false });
  await expect(resolve()).rejects.toThrow("BRAND_SERVICE_PERMISSION_DENIED");
});
it("requires the authenticated session identity anchor", async () => {
  await expect(
    createMerchantBrandScope({} as never)({} as never, "synthetic-cookie", undefined as never),
  ).rejects.toThrow("BRAND_SERVICE_PERMISSION_DENIED");
  expect(ports.resolve).not.toHaveBeenCalled();
});

it("reads one fresh Brand batch and checks navigation plus final permission before returning", async () => {
  const scope = await resolve();
  const prior = ports.resolve.mock.calls.length;
  const actions = ["catalog.product.validate", "catalog.option_set.read"];
  expect(await scope.authorizeActions(actions)).toMatchObject(
    actions.map((action) => ({ action, effect: "Allow", scopeKind: "Brand" })),
  );
  expect(ports.resolve).toHaveBeenCalledTimes(prior + 2);
  expect(ports.find).toHaveBeenCalledTimes(2);
  expect(
    ports.source.mock.calls.every(
      ([, context]) => context.scopeKind === "Store" && context.store.storeReference === id(4),
    ),
  ).toBe(true);
  expect(ports.authorize.mock.calls.map(([r]) => r.action)).toEqual([
    ...actions,
    actions[actions.length - 1],
  ]);
  expect(
    ports.authorize.mock.calls.every(
      ([r]) => r.storeAssignment === null && r.tenantContext.store === null,
    ),
  ).toBe(true);
  ports.authorize.mockImplementation(async (r) => ({
    action: r.action,
    effect: r.action === "catalog.option_set.read" ? "Deny" : "Allow",
    scopeKind: "Brand",
  }));
  expect(await scope.authorizeActions(actions)).toMatchObject([
    { effect: "Allow" },
    { effect: "Deny" },
  ]);
  expect(ports.find).toHaveBeenCalledTimes(4);
});
it.each(["tenant", "store", "actor", "revoked"])(
  "refuses late %s during an admission batch",
  async (changed) => {
    const scope = await resolve();
    const next = selected();
    if (changed === "tenant") next.selected.tenantReference = id(90);
    if (changed === "store") next.store.storeReference = id(90);
    if (changed === "actor") next.actorReference = id(90);
    if (changed === "revoked") next.initialAuthorization = navigationDecision(false);
    ports.authorize.mockImplementation(async (r) => {
      ports.resolve.mockResolvedValue(next);
      return { action: r.action, effect: "Allow", scopeKind: "Brand" };
    });
    expect(await scope.authorizeActions(["catalog.option_set.read"])).toBeNull();
  },
);
it("rejects malformed/getter action groups without invoking getters or reading sources", async () => {
  const scope = await resolve();
  ports.resolve.mockClear();
  const getter = vi.fn(() => "catalog.manage");
  const values = [] as string[];
  Object.defineProperty(values, "0", { get: getter, enumerable: true });
  for (const actions of [[], ["catalog.manage", "catalog.manage"], [""], values])
    expect(await scope.authorizeActions(actions)).toBeNull();
  expect(getter).not.toHaveBeenCalled();
  expect(ports.resolve).not.toHaveBeenCalled();
});
it("refuses a Store decision in a Brand batch", async () => {
  const scope = await resolve();
  ports.authorize.mockImplementation(async (r) => ({
    action: r.action,
    effect: "Allow",
    scopeKind: "Store",
  }));
  expect(await scope.authorizeActions(["catalog.option_set.read"])).toBeNull();
});

it("captures the original clock rather than accepting a replaced permission instant", async () => {
  const original = vi.fn(() => at),
    replacement = vi.fn(() => "2020-01-01T00:00:00.000Z"),
    configuration = { now: original };
  const scope = await createMerchantBrandScope(configuration as never)(
    {} as never,
    "synthetic-cookie",
    id(6),
  );
  configuration.now = replacement;
  expect(await scope.authorizeActions(["catalog.option_set.read"])).toMatchObject([
    { effect: "Allow" },
  ]);
  expect(replacement).not.toHaveBeenCalled();
  expect(original).toHaveBeenCalled();
  expect(ports.authorize).toHaveBeenCalledWith(
    expect.objectContaining({ tenantContext: expect.objectContaining({ resolvedAt: at }) }),
  );
});

it("passes canonical hyphenated actions to current Brand IAM without admitting malformed action lists", async () => {
  const scope = await resolve();
  const actions = ["pricing.price-book.manage", "catalog.product.acknowledge-warnings"];
  expect(await scope.authorizeActions(actions)).toMatchObject(
    actions.map((action) => ({ action, effect: "Allow", scopeKind: "Brand" })),
  );
  expect(ports.authorize.mock.calls.map(([r]) => r.action)).toEqual([...actions, actions[1]]);
});

it("returns actual immutable decisions plus the earliest policy boundary", async () => {
  const scope = await resolve();
  ports.validity.mockImplementation(async (request: { action: string }) =>
    request.action === "catalog.product.validate"
      ? "2026-09-14T08:00:01.000Z"
      : "2026-09-14T08:00:04.000Z",
  );
  const result = await scope.authorizeActionsWithValidity([
    "catalog.product.validate",
    "catalog.option_set.read",
  ]);
  expect(result).toMatchObject({
    validUntil: "2026-09-14T08:00:01.000Z",
    decisions: [
      { action: "catalog.product.validate", effect: "Allow" },
      { action: "catalog.option_set.read", effect: "Allow" },
    ],
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result?.decisions)).toBe(true);
  expect(ports.authorize.mock.calls.map(([input]) => input.action)).toEqual([
    "catalog.product.validate",
    "catalog.option_set.read",
    "catalog.option_set.read",
  ]);
});
it("keeps the original earliest boundary when a final checkpoint returns a longer validity", async () => {
  const scope = await resolve();
  ports.validity.mockResolvedValueOnce("2026-09-14T08:00:01.000Z").mockResolvedValueOnce(null);
  expect(await scope.authorizeActionsWithValidity(["catalog.product.read"])).toMatchObject({
    validUntil: "2026-09-14T08:00:01.000Z",
  });
});
it("merges verified initial and before/after Store session/policy bounds", async () => {
  const first = selected();
  first.authorizationValidUntil = () => "2026-09-14T08:00:04.000Z";
  ports.resolve.mockResolvedValue(first);
  const scope = await resolve();
  const before = selected(),
    after = selected();
  before.authorizationValidUntil = () => "2026-09-14T08:00:03.000Z";
  after.authorizationValidUntil = () => "2026-09-14T08:00:01.000Z";
  ports.resolve.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
  expect(await scope.authorizeActionsWithValidity(["catalog.product.read"])).toMatchObject({
    validUntil: "2026-09-14T08:00:01.000Z",
  });
});
it("preserves null only when every owning observation has no future boundary", async () => {
  expect(
    await (await resolve()).authorizeActionsWithValidity(["catalog.product.read"]),
  ).toMatchObject({ validUntil: null });
});
it.each([undefined, "bad", at, "2026-09-14T07:59:59.000Z"])(
  "refuses malformed or nonfuture Brand metadata %s",
  async (value) => {
    const scope = await resolve();
    ports.validity.mockResolvedValue(value);
    await expect(scope.authorizeActionsWithValidity(["catalog.product.read"])).rejects.toThrow();
  },
);
it("refuses missing Store boundary metadata instead of extending authority", async () => {
  const scope = await resolve(),
    next = selected();
  Object.defineProperty(next, "authorizationValidUntil", { value: undefined, enumerable: true });
  ports.resolve.mockResolvedValue(next);
  await expect(scope.authorizeActionsWithValidity(["catalog.product.read"])).rejects.toThrow(
    "BRAND_SERVICE_PERMISSION_DENIED",
  );
});
it("rejects a permission boundary crossed inside a later policy await", async () => {
  let now = at;
  const scope = await createMerchantBrandScope({ now: () => now } as never)(
    {} as never,
    "synthetic-cookie",
    id(6),
  );
  ports.validity
    .mockResolvedValueOnce("2026-09-14T08:00:01.000Z")
    .mockImplementationOnce(async () => {
      now = "2026-09-14T08:00:01.000Z";
      return null;
    });
  await expect(
    scope.authorizeActionsWithValidity(["catalog.product.read", "catalog.sku.read"]),
  ).rejects.toThrow("BRAND_SERVICE_PERMISSION_DENIED");
});
it("refuses a clock rollback during the same batch", async () => {
  let now = at;
  const scope = await createMerchantBrandScope({ now: () => now } as never)(
    {} as never,
    "synthetic-cookie",
    id(6),
  );
  ports.validity.mockImplementation(async () => {
    now = "2026-09-14T07:59:59.999Z";
    return null;
  });
  await expect(scope.authorizeActionsWithValidity(["catalog.product.read"])).rejects.toThrow(
    "BRAND_SERVICE_PERMISSION_DENIED",
  );
});

it("each checkpoint calls the actual owner batch once and still rechecks its last permission", async () => {
  const scope = await resolve();
  const actions = ["catalog.manage", "catalog.product.read", "catalog.sku.read"];
  await scope.authorizeActionsWithValidity(actions);
  expect(ports.batch).toHaveBeenCalledOnce();
  expect(ports.batch).toHaveBeenCalledWith(
    expect.objectContaining({
      actions,
      storeAssignment: null,
      tenantContext: expect.objectContaining({ scopeKind: "Brand" }),
    }),
  );
  expect(ports.find).toHaveBeenCalledTimes(2);
  expect(ports.authorize.mock.calls.map(([input]) => input.action)).toEqual([
    ...actions,
    "catalog.sku.read",
  ]);
  ports.authorize.mockImplementation(async (input) => ({
    action: input.action,
    scopeKind: "Brand",
    effect: "Deny",
  }));
  expect(await scope.authorizeActions(actions)).toMatchObject(
    actions.map((action) => ({ action, effect: "Deny" })),
  );
  expect(ports.batch).toHaveBeenCalledTimes(2);
  expect(ports.find).toHaveBeenCalledTimes(4);
});
it("a late final action denial is retained after a passing batch", async () => {
  const scope = await resolve();
  const actions = ["catalog.manage", "catalog.product.read"];
  ports.authorize
    .mockResolvedValueOnce({ action: actions[0], scopeKind: "Brand", effect: "Allow" })
    .mockResolvedValueOnce({ action: actions[1], scopeKind: "Brand", effect: "Allow" })
    .mockResolvedValueOnce({ action: actions[1], scopeKind: "Brand", effect: "Deny" });
  expect(await scope.authorizeActions(actions)).toMatchObject([
    { effect: "Allow" },
    { effect: "Deny" },
  ]);
  expect(ports.find).toHaveBeenCalledTimes(2);
});

function navigationDecision(allow = true) {
  const context = createTenantContext(actor, brand, null, at),
    action = parseBusinessAction("merchant.access"),
    actorReference = actor.actorReference;
  if (!actorReference) throw new Error("Fixture requires actual User");
  return evaluatePermission({
    tenantContext: context,
    action,
    resourceScope: { kind: "Brand", brandReference: brand.brandReference, storeReference: null },
    policySnapshotReference: parsePolicyReference(id(70)),
    policyVersion: parsePolicyVersion(1),
    evidence: allow
      ? [
          {
            source: "RolePermission",
            evidenceReference: parseEvidenceReference(id(71)),
            action,
            actorReference,
            roleReference: parseRoleReference(id(72)),
            brandReference: brand.brandReference,
            storeReference: null,
            effectiveFrom: parseEvidenceInstant(at),
            effectiveUntil: null,
          },
        ]
      : [],
  });
}
it("Brand batch consumes actual initial navigation at both checkpoints without duplicate allowed reads", async () => {
  const initial = selected(),
    allowed = vi.fn(async () => true);
  initial.allowed = allowed;
  ports.resolve.mockResolvedValue(initial);
  const scope = await resolve();
  expect(allowed).toHaveBeenCalledOnce(); // legacy initial Brand scope admission
  const before = allowed.mock.calls.length;
  await scope.authorizeActionsWithValidity(["catalog.product.read"]);
  expect(allowed).toHaveBeenCalledTimes(before);
  expect(ports.resolve.mock.calls.at(-1)).toHaveLength(3);
});
it("withdrawn initial navigation denies Brand batch before owner policy acquisition", async () => {
  const scope = await resolve(),
    next = selected();
  next.initialAuthorization = navigationDecision(false);
  ports.resolve.mockResolvedValue(next);
  expect(await scope.authorizeActionsWithValidity(["catalog.product.read"])).toBeNull();
  expect(ports.batch).not.toHaveBeenCalled();
});
it("initial navigation is reacquired after batch and late withdrawal rejects the admission", async () => {
  const scope = await resolve(),
    before = selected(),
    after = selected();
  after.initialAuthorization = navigationDecision(false);
  ports.resolve.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
  expect(await scope.authorizeActionsWithValidity(["catalog.product.read"])).toBeNull();
  expect(ports.batch).toHaveBeenCalledOnce();
});

it("uses the identical transaction Permission owner in Store admission, Brand actions and final batch recheck", async () => {
  const tx = { query: vi.fn(async () => ({ rows: [] })) },
    policy = createPostgresCurrentPermissionPolicySource(tx),
    single = vi.spyOn(policy, "authorize"),
    batch = vi.spyOn(policy, "authorizeActionsWithRoles"),
    final = vi.spyOn(policy, "authorizeWithRoles"),
    source = { now: () => at } as never;
  const scope = await createMerchantBrandScope(source, policy)(tx, "synthetic-cookie", id(6));
  expect(ports.storeFactory).toHaveBeenCalledWith(source, policy);
  expect(await scope.authorizeAction("catalog.option_set.read")).toMatchObject({ effect: "Allow" });
  expect(single).toHaveBeenCalledTimes(1);
  expect(await scope.authorizeActions(["catalog.manage", "catalog.option_set.read"])).toMatchObject(
    [{ effect: "Allow" }, { effect: "Allow" }],
  );
  expect(ports.initialFactory).toHaveBeenCalledTimes(2);
  for (const args of ports.initialFactory.mock.calls) expect(args).toEqual([source, policy]);
  expect(batch).toHaveBeenCalledTimes(1);
  expect(final).toHaveBeenCalledTimes(1);
  expect(final.mock.calls[0]?.[0].action).toBe("catalog.option_set.read");
  expect(batch.mock.calls[0]?.[0].tenantContext.store).toBeNull();
  ports.authorize.mockImplementation(async (request) => ({
    effect: "Deny",
    scopeKind: "Brand",
    action: request.action,
  }));
  expect(await scope.authorizeAction("catalog.option_set.read")).toMatchObject({ effect: "Deny" });
  // The controlled batch/final methods delegate to the same single evaluator:
  // initial read, two batch actions, final read, then the later denied read.
  expect(single).toHaveBeenCalledTimes(5);
  expect(single.mock.calls.map(([request]) => request.action)).toEqual([
    "catalog.option_set.read",
    "catalog.manage",
    "catalog.option_set.read",
    "catalog.option_set.read",
    "catalog.option_set.read",
  ]);
  for (const [request] of single.mock.calls) {
    expect(request.tenantContext.store).toBeNull();
    expect(request.storeAssignment).toBeNull();
  }
  expect(ports.storeFactory.mock.calls.every((args) => args[1] === policy)).toBe(true);
  expect(ports.initialFactory.mock.calls.every((args) => args[1] === policy)).toBe(true);
});
