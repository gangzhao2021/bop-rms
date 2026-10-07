import {
  createIdentityActor,
  parseSelectorHash,
  type OidcAuthorizationTransaction,
} from "@bop/identity";
import { expect, it, vi } from "vitest";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import {
  createMerchantCurrentBrandScope,
  createMerchantCurrentBrandAdministrationScope,
  type MerchantBrandAdministrationPolicyPort,
} from "./merchant-current-brand-scope.js";
const id = (n: number) => "0190ed60-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-10T10:00:00.000Z";
function fixture() {
  const actor = createIdentityActor({
    actorType: "User",
    actorReference: id(1),
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: at,
    recentMfaAt: null,
  });
  const session: Record<string, unknown> = {
    session_id: id(2),
    actor_id: id(1),
    policy_code: "WorkforceStandard",
    status: "Active",
    authenticated_at: new Date(at),
    created_at: new Date(at),
    last_seen_at: new Date(at),
    idle_expires_at: new Date("2026-09-10T10:30:00.000Z"),
    absolute_expires_at: new Date("2026-09-10T22:00:00.000Z"),
    rotated_from_session_id: null,
    revocation_reason: null,
    revoked_at: null,
    version: 1,
  };
  const selected: Record<string, unknown> = {
    session_id: id(2),
    actor_id: id(1),
    brand_id: id(3),
    selected_at: at,
    precise: true,
  };
  const brand: Record<string, unknown> = {
    brand_id: id(3),
    code: "SYNTHETIC",
    display_name: "Synthetic Brand",
    default_locale: "en-CA",
    currency_code: "CAD",
    lifecycle: "Active",
    version: 1,
    created_at: at,
    updated_at: at,
    precise: true,
  };
  const membership: Record<string, unknown> = {
    membership_id: id(4),
    actor_id: id(1),
    brand_id: id(3),
    workforce_relationship_reference: id(5),
    lifecycle: "Active",
    version: 1,
    effective_from: at,
    effective_until: null,
    created_at: at,
    updated_at: at,
    precise: true,
  };
  const state = {
    clock: at,
    missing: false,
    allowed: true,
    actor,
    boundary: null as string | null,
  };
  const calls: string[] = [];
  const tx: OidcAuthorizationTransaction = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith("SELECT current_setting"))
        return { rows: [{ session_scope: "", actor_scope: "" }] };
      if (sql.includes("FROM bop_identity.authentication_session"))
        return {
          rows: [
            sql.includes("WHERE session_id")
              ? {
                  ...Object.fromEntries(
                    Object.entries(session)
                      .filter(
                        ([key]) =>
                          ![
                            "cipher_algorithm",
                            "key_reference",
                            "encrypted_secret",
                            "encryption_context",
                            "csrf_selector_hash",
                          ].includes(key),
                      )
                      .map(([key, value]) => [
                        key,
                        value instanceof Date ? value.toISOString() : value,
                      ]),
                  ),
                  precise: true,
                }
              : session,
          ],
        };
      if (sql.includes("FROM bop_identity.browser_brand_session_selection"))
        return { rows: state.missing ? [] : [selected] };
      if (sql.includes("FROM bop_tenant.brand")) return { rows: [brand] };
      if (sql.includes("FROM bop_membership.membership")) return { rows: [membership] };
      return { rows: [] };
    },
  };
  const options = {
    now: () => state.clock,
    currentActor: async () => state.actor,
    identity: {
      hasher: {
        hash: () => parseSelectorHash("a".repeat(64)),
        equals: (a: string, b: string) => a === b,
      },
    },
  };
  // Controlled Permission port only; the Session/selection/Tenant/Membership readers are real.
  const assess = vi.fn(async (input: { actions: readonly string[] }) => ({
    decisions: input.actions.map((action) => ({
      action,
      effect: state.allowed ? "Allow" : "Deny",
      scopeKind: "Brand",
    })),
    validUntil: state.boundary,
  }));
  const resolve = createMerchantCurrentBrandScope(options, {
    authorizeActionsWithRoles: assess,
  } as never);
  return {
    state,
    calls,
    session,
    selected,
    brand,
    membership,
    options,
    tx,
    assess,
    resolve: () => resolve(tx, "x".repeat(43), id(2)),
  };
}
it("resolves real owner rows with Brand-derived Tenant and no Store dependencies", async () => {
  const f = fixture(),
    scope = await f.resolve();
  expect(scope.tenantReference).toBe(id(3));
  expect(scope.context.store).toBeNull();
  expect(scope.context.scopeKind).toBe("Brand");
  expect("selectedStoreReference" in scope).toBe(false);
  expect((await scope.authorizeAction("catalog.manage")).effect).toBe("Allow");
  expect(f.assess).toHaveBeenLastCalledWith(
    expect.objectContaining({
      storeAssignment: null,
      actions: ["organization.manage", "catalog.manage"],
    }),
  );
  expect(f.calls.filter((sql) => sql.includes("session_selector_hash"))).toHaveLength(2);
  expect(
    f.calls.every(
      (sql) => !sql.includes("store_assignment") && !sql.includes("FROM bop_tenant.store"),
    ),
  ).toBe(true);
});
it.each(["missing", "Draft", "membership", "permission", "actor", "session"])(
  "fails closed for unavailable current %s",
  async (reason) => {
    const f = fixture();
    if (reason === "missing") f.state.missing = true;
    if (reason === "Draft") f.brand.lifecycle = "Draft";
    if (reason === "membership") f.membership.lifecycle = "Suspended";
    if (reason === "permission") f.state.allowed = false;
    if (reason === "actor")
      f.state.actor = createIdentityActor({ ...f.state.actor, actorReference: id(9) });
    if (reason === "session") f.session.session_id = id(9);
    await expect(f.resolve()).rejects.toThrow("BRAND_SERVICE_PERMISSION_DENIED");
  },
);
it.each(["selection", "Brand", "permission", "expiry", "query"])(
  "rejects late %s drift without renewing the scope",
  async (reason) => {
    const f = fixture(),
      scope = await f.resolve();
    if (reason === "selection") f.selected.brand_id = id(9);
    if (reason === "Brand") f.brand.version = 2;
    if (reason === "permission") f.state.allowed = false;
    if (reason === "expiry") f.state.clock = "2026-09-10T10:00:05.000Z";
    if (reason === "query") f.tx.query = async () => ({ rows: [] });
    await expect(scope.authorizeAction("organization.manage")).rejects.toThrow();
    expect(() => scope.assertCurrent()).toThrow();
  },
);
it("retains the shortest natural permission boundary and rejects malformed action lists", async () => {
  const f = fixture();
  f.state.boundary = "2026-09-10T10:00:01.000Z";
  const scope = await f.resolve();
  expect(scope.authorizationValidUntil()).toBe(f.state.boundary);
  f.state.clock = f.state.boundary;
  expect(() => scope.assertCurrent()).toThrow();
  const g = fixture(),
    other = await g.resolve(),
    count = g.calls.length;
  await expect(
    other.authorizeActionsWithValidity(["organization.manage", "organization.manage"]),
  ).rejects.toThrow();
  expect(g.calls).toHaveLength(count);
});

function administrationFixture() {
  const f = fixture();
  f.brand.lifecycle = "Draft";
  f.state.boundary = "2026-09-10T10:00:05.000Z";
  // Controlled Permission result only. Actual Session, immutable selection,
  // administrative Tenant context and Membership owner rows are exercised;
  // this component fixture is not native PostgreSQL or real IAM evidence.
  const assess = vi.fn<MerchantBrandAdministrationPolicyPort["authorizeActionsWithRoles"]>(
    async (input) => ({
      decisions: input.actions.map((action) => {
        const effect = f.state.allowed ? ("Allow" as const) : ("Deny" as const);
        const reason = f.state.allowed ? ("ROLE_PERMISSION" as const) : ("DEFAULT_DENY" as const);
        const source = f.state.allowed ? ("RolePermission" as const) : ("DefaultDeny" as const);
        return Object.freeze({
          action: parseBusinessAction(action),
          effect,
          reason,
          source,
          scopeKind: "Brand" as const,
          policySnapshotReference: parsePolicyReference(id(10)),
          policyVersion: parsePolicyVersion(1),
          audit: Object.freeze({ effect, reason, source }),
        });
      }),
      activeRoleCodes: Object.freeze(["synthetic_admin"]),
      validUntil: f.state.boundary,
    }),
  );
  const policy = { authorizeActionsWithRoles: assess };
  const configuration = {
    environment: "synthetic",
    issuer: "https://identity.invalid/",
    clientId: "workforce",
    redirectUri: "https://merchant.invalid/merchant/organization/brands/callback",
    allowedPostLoginPaths: ["/app/organization/brands"],
  };
  const proof = {
    profile: "WorkforceBrowserSessionV1",
    issuer: configuration.issuer,
    clientId: configuration.clientId,
    tokenBundle: "synthetic-only",
    csrf: "x".repeat(43),
    mfa: {
      sessionReference: id(2),
      actorReference: id(1),
      method: "Totp",
      evidenceReference: id(20),
      authorizationTransactionReference: id(21),
      authenticatedAt: at,
      verifiedAt: at,
      validUntil: "2026-09-10T10:15:00.000Z",
    },
  };
  Object.assign(f.session, {
    policy_code: "Privileged",
    idle_expires_at: new Date("2026-09-10T10:15:00.000Z"),
    absolute_expires_at: new Date("2026-09-10T18:00:00.000Z"),
    cipher_algorithm: "SYNTHETIC_AES_256_GCM",
    key_reference: "synthetic",
    encrypted_secret: new Uint8Array(32),
    encryption_context: `synthetic:session:${id(2)}:${id(1)}`,
    csrf_selector_hash: new Uint8Array(32).fill(170),
  });
  const options = {
    ...f.options,
    identity: {
      ...f.options.identity,
      configuration,
      envelopes: {
        async encrypt() {
          throw new Error("unused controlled unit port");
        },
        async decrypt() {
          return JSON.stringify(proof);
        },
      },
    },
  };
  const resolve = createMerchantCurrentBrandAdministrationScope(options, policy);
  return {
    ...f,
    options,
    proof,
    assess,
    policy,
    resolve: (until?: string) => resolve(f.tx, "x".repeat(43), id(2), until),
  };
}

it.each(["Draft", "Active", "Suspended", "Archived"] as const)(
  "retains actual %s Brand identity in the separate administrative profile",
  async (lifecycle) => {
    const f = administrationFixture();
    f.brand.lifecycle = lifecycle;
    const scope = await f.resolve();
    expect(scope.context.profile).toBe("BrandAdministrationContextV1");
    expect(scope.context.purposeCode).toBe("BRAND_ADMINISTRATION");
    expect(scope.context.brand.lifecycle).toBe(lifecycle);
    expect(scope.context.store).toBeNull();
    expect("scopeKind" in scope.context).toBe(false);
    expect(scope.tenantReference).toBe(id(3));
    expect(Object.isFrozen(scope.context)).toBe(true);
    expect(f.calls.some((sql) => sql.includes("set_config('bop.tenant_id',$1,true)"))).toBe(true);
    expect(
      f.calls.every((sql) => !sql.includes("INSERT") && !sql.includes("store_assignment")),
    ).toBe(true);
    expect(f.assess).toHaveBeenLastCalledWith(
      expect.objectContaining({
        administrationContext: scope.context,
        storeAssignment: null,
        actions: ["organization.manage"],
      }),
    );
  },
);

it("admits only the six fixed administrative actions with mandatory organization.manage", async () => {
  const f = administrationFixture(),
    scope = await f.resolve();
  const actions = [
    "organization.manage",
    "publishing.draft.create",
    "publishing.review.submit",
    "publishing.review.approve",
    "publishing.release.publish",
    "publishing.release.archive",
  ];
  expect((await scope.authorizeActions(actions)).map((decision) => decision.action)).toEqual(
    actions,
  );
  expect((await scope.authorizeAction("publishing.release.publish")).effect).toBe("Allow");
  expect(f.assess).toHaveBeenLastCalledWith(
    expect.objectContaining({
      actions: ["organization.manage", "publishing.release.publish"],
    }),
  );
});

it.each([
  "catalog.manage",
  "organization.create",
  "feature.control.change",
  "publishing.rollback",
  "bad",
])("refuses administrative action %s before any further owner read", async (action) => {
  const f = administrationFixture(),
    scope = await f.resolve(),
    count = f.calls.length;
  await expect(scope.authorizeAction(action)).rejects.toThrow("BRAND_SERVICE_PERMISSION_DENIED");
  expect(f.calls).toHaveLength(count);
  expect(() => scope.assertCurrent()).toThrow();
});

it.each([
  "missing",
  "membership",
  "foreignMember",
  "noRelationship",
  "expiredMember",
  "permission",
  "actor",
  "session",
])("refuses unavailable administrative %s using actual owner rows", async (reason) => {
  const f = administrationFixture();
  if (reason === "missing") f.state.missing = true;
  if (reason === "membership") f.membership.lifecycle = "Suspended";
  if (reason === "foreignMember") f.membership.actor_id = id(99);
  if (reason === "noRelationship") f.membership.workforce_relationship_reference = null;
  if (reason === "expiredMember") f.membership.effective_until = at;
  if (reason === "permission") f.state.allowed = false;
  if (reason === "actor")
    f.state.actor = createIdentityActor({ ...f.state.actor, actorReference: id(9) });
  if (reason === "session") f.session.session_id = id(9);
  await expect(f.resolve()).rejects.toThrow("BRAND_SERVICE_PERMISSION_DENIED");
});

it.each([
  "selection",
  "selectionTime",
  "BrandVersion",
  "lifecycle",
  "sessionVersion",
  "actorIdentity",
  "permission",
  "expiry",
  "query",
  "policyPort",
])("poisons late administrative %s drift without refreshing the original lease", async (reason) => {
  const f = administrationFixture(),
    scope = await f.resolve();
  if (reason === "selection") f.selected.brand_id = id(9);
  if (reason === "selectionTime") f.selected.selected_at = "2026-09-10T10:00:00.001Z";
  if (reason === "BrandVersion") f.brand.version = 2;
  if (reason === "lifecycle") f.brand.lifecycle = "Active";
  if (reason === "sessionVersion") f.session.version = 2;
  if (reason === "actorIdentity")
    f.state.actor = createIdentityActor({
      ...f.state.actor,
      verificationLevel: "RecentMfa",
      recentMfaAt: at,
    });
  if (reason === "permission") f.state.allowed = false;
  if (reason === "expiry") f.state.clock = "2026-09-10T10:00:05.000Z";
  if (reason === "query") f.tx.query = async () => ({ rows: [] });
  if (reason === "policyPort")
    f.policy.authorizeActionsWithRoles = vi.fn((input) => f.assess(input));
  await expect(scope.authorizeAction("organization.manage")).rejects.toThrow();
  expect(() => scope.assertCurrent()).toThrow();
});

it("keeps explicit original and natural administrative deadlines, refusing exact expiry", async () => {
  const f = administrationFixture();
  f.state.boundary = "2026-09-10T10:00:02.000Z";
  const scope = await f.resolve("2026-09-10T10:00:03.000Z");
  expect(scope.authorizationValidUntil()).toBe(f.state.boundary);
  f.state.clock = "2026-09-10T10:00:01.000Z";
  await scope.authorizeAction("organization.manage");
  expect(scope.authorizationValidUntil()).toBe(f.state.boundary);
  f.state.clock = f.state.boundary;
  expect(() => scope.assertCurrent()).toThrow();
  const g = administrationFixture();
  await expect(g.resolve("2026-09-10T10:00:05.001Z")).rejects.toThrow();
  expect(g.calls).toHaveLength(0);
});

it("uses the actual administrative Permission owner by default and refuses absent policy", async () => {
  const f = administrationFixture();
  const resolve = createMerchantCurrentBrandAdministrationScope(f.options);
  await expect(resolve(f.tx, "x".repeat(43), id(2))).rejects.toThrow(
    "BRAND_SERVICE_PERMISSION_DENIED",
  );
  expect(f.calls.some((sql) => sql.includes("bop_permission.policy_state"))).toBe(true);
  expect(f.assess).not.toHaveBeenCalled();
});

it.each([null, at, "2026-09-10T10:00:05.001Z"])(
  "refuses missing, expired or extended administrative Permission lease %s",
  async (boundary) => {
    const f = administrationFixture();
    f.state.boundary = boundary;
    await expect(f.resolve()).rejects.toThrow("BRAND_SERVICE_PERMISSION_DENIED");
  },
);

it("administrative scope requires exact strong Session proof and bounds its original MFA deadline", async () => {
  const f = administrationFixture();
  f.proof.mfa.sessionReference = id(99);
  await expect(f.resolve()).rejects.toThrow();
  const g = administrationFixture();
  g.state.clock = "2026-09-10T10:14:59.999Z";
  g.state.boundary = "2026-09-10T10:15:04.999Z";
  g.session.last_seen_at = new Date(g.state.clock);
  g.session.idle_expires_at = new Date("2026-09-10T10:29:59.999Z");
  const scope = await g.resolve();
  expect(scope.context.actor.verificationLevel).toBe("RecentMfa");
  expect(scope.authorizationValidUntil()).toBe("2026-09-10T10:15:00.000Z");
  g.state.clock = "2026-09-10T10:15:00.000Z";
  expect(() => scope.assertCurrent()).toThrow();
});
it("administrative scope rejects missing proof-required fields without legacy fallback", async () => {
  const f = administrationFixture();
  f.session.cipher_algorithm = "legacy";
  await expect(f.resolve()).rejects.toThrow();
  expect(f.assess).not.toHaveBeenCalled();
});
