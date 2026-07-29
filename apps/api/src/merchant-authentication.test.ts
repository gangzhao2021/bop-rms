import {
  createAuthenticationSession,
  type AuthenticationSession,
  type IdentitySessionPort,
  type RevokeAuthenticationSessionCommand,
  type SessionRevocationResult,
} from "@bop/identity";
import {
  createMembership,
  createStoreAssignment,
  type Membership,
  type MembershipInstant,
  type MembershipPort,
  type MembershipSuspension,
  type MembershipVersion,
  type StoreAssignment,
} from "@bop/membership";
import {
  createPermissionDefinition,
  createPermissionGrant,
  createPermissionOverride,
  createPermissionRole,
  createPolicyState,
  createRoleAssignment,
  type PermissionPolicyMutation,
  type PermissionPolicyPort,
  type PermissionPolicySnapshot,
  type PermissionReference,
  type PermissionRole,
  type RoleReference,
} from "@bop/permission";
import {
  createBrand,
  createStore,
  type Brand,
  type OrganizationVersion,
  type Store,
  type StoreReference,
  type TenantOrganizationPort,
} from "@bop/tenant";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMerchantAuthenticatedActorResolver,
  createMerchantPermissionMiddleware,
} from "./merchant-authentication.js";
import { createTenantContextMiddleware } from "./tenant-context.js";

const uuid = (suffix: string) => `018f5f9a-ad3e-7a11-8d01-${suffix.padStart(12, "0")}`;
const ids = {
  actor: uuid("1"),
  session: uuid("2"),
  brand: uuid("3"),
  storeAllowed: uuid("4"),
  storeDenied: uuid("5"),
  membership: uuid("6"),
  workforce: uuid("7"),
  assignmentAllowed: uuid("8"),
  assignmentDenied: uuid("9"),
  permission: uuid("10"),
  role: uuid("11"),
  roleAssignment: uuid("12"),
  grant: uuid("13"),
  deny: uuid("14"),
  reason: uuid("15"),
  correlation: uuid("16"),
  snapshot: uuid("17"),
};
const FROM = "2026-07-28T12:00:00.000Z";
const AT = "2026-07-28T12:30:00.000Z";
const UNTIL = "2026-07-28T13:00:00.000Z";
const ACTION = "synthetic.resource.update";
const servers: import("node:http").Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

const actorInput = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  actorType: "User",
  actorReference: ids.actor,
  accountKind: "Workforce",
  status: "Active",
  authenticationMethod: "Oidc",
  verificationLevel: "SingleFactor",
  authenticatedAt: FROM,
  recentMfaAt: null,
  ...overrides,
});

const sessionInput = (
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  sessionReference: ids.session,
  actor: actorInput(),
  status: "Active",
  policyCode: "WorkforceStandard",
  maxActiveSessions: 5,
  idleTimeoutMinutes: 30,
  absoluteTimeoutMinutes: 720,
  version: 1,
  authenticatedAt: FROM,
  createdAt: FROM,
  lastSeenAt: "2026-07-28T12:10:00.000Z",
  idleExpiresAt: "2026-07-28T12:40:00.000Z",
  absoluteExpiresAt: "2026-07-29T00:00:00.000Z",
  rotatedFromSessionReference: null,
  revocationReason: null,
  revokedAt: null,
  ...overrides,
});

const brand = createBrand({
  brandReference: ids.brand,
  code: "SYNTHETIC",
  displayName: "Synthetic Brand",
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Active",
  version: 1,
  createdAt: FROM,
  updatedAt: FROM,
});

const store = (reference: string, code: string) =>
  createStore({
    storeReference: reference,
    brandReference: ids.brand,
    code,
    displayName: "Synthetic Store",
    timeZone: "America/Toronto",
    locale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  });

const allowedStore = store(ids.storeAllowed, "ALLOWED");
const deniedStore = store(ids.storeDenied, "DENIED");
const membership = createMembership(
  {
    membershipReference: ids.membership,
    actorReference: ids.actor,
    brandReference: ids.brand,
    workforceRelationshipReference: ids.workforce,
    lifecycle: "Active",
    effectiveFrom: FROM,
    effectiveUntil: UNTIL,
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  },
  createAuthenticationSession(sessionInput()).actor,
);

const assignment = (reference: string, storeFact: Store) =>
  createStoreAssignment(
    {
      storeAssignmentReference: reference,
      membershipReference: ids.membership,
      actorReference: ids.actor,
      brandReference: ids.brand,
      storeReference: storeFact.storeReference,
      lifecycle: "Active",
      effectiveFrom: FROM,
      effectiveUntil: UNTIL,
      version: 1,
      createdAt: FROM,
      updatedAt: FROM,
    },
    membership,
    storeFact,
  );

const allowedAssignment = assignment(ids.assignmentAllowed, allowedStore);
const deniedAssignment = assignment(ids.assignmentDenied, deniedStore);
const permission = createPermissionDefinition({
  permissionReference: ids.permission,
  action: ACTION,
  lifecycle: "Active",
  version: 1,
  createdAt: FROM,
  updatedAt: FROM,
});
const role = createPermissionRole(
  {
    roleReference: ids.role,
    brandReference: ids.brand,
    storeReference: ids.storeAllowed,
    code: "synthetic_operator",
    lifecycle: "Active",
    effectiveFrom: FROM,
    effectiveUntil: UNTIL,
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  },
  brand,
  allowedStore,
);
const roleAssignment = createRoleAssignment(
  {
    assignmentReference: ids.roleAssignment,
    roleReference: ids.role,
    membershipReference: ids.membership,
    storeAssignmentReference: ids.assignmentAllowed,
    actorReference: ids.actor,
    brandReference: ids.brand,
    storeReference: ids.storeAllowed,
    lifecycle: "Active",
    effectiveFrom: FROM,
    effectiveUntil: UNTIL,
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  },
  role,
  membership,
  allowedAssignment,
);
const grant = createPermissionGrant(
  {
    grantReference: ids.grant,
    roleReference: ids.role,
    permissionReference: ids.permission,
    action: ACTION,
    brandReference: ids.brand,
    storeReference: ids.storeAllowed,
    lifecycle: "Active",
    effectiveFrom: FROM,
    effectiveUntil: UNTIL,
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  },
  role,
  permission,
);
const state = createPolicyState(
  {
    brandReference: ids.brand,
    snapshotReference: ids.snapshot,
    version: 1,
    updatedAt: FROM,
  },
  brand,
);
const explicitDeny = createPermissionOverride(
  {
    overrideReference: ids.deny,
    permissionReference: ids.permission,
    action: ACTION,
    actorReference: ids.actor,
    brandReference: ids.brand,
    storeReference: ids.storeAllowed,
    effect: "Deny",
    lifecycle: "Active",
    reasonReference: ids.reason,
    correlationReference: ids.correlation,
    effectiveFrom: FROM,
    effectiveUntil: UNTIL,
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  },
  permission,
);

function policySnapshot(deny = false): PermissionPolicySnapshot {
  return Object.freeze({
    state,
    permissionDefinitions: Object.freeze([permission]),
    roles: Object.freeze([role]),
    roleAssignments: Object.freeze([roleAssignment]),
    permissionGrants: Object.freeze([grant]),
    permissionOverrides: Object.freeze(deny ? [explicitDeny] : []),
  });
}

class FakeIdentitySessionPort implements IdentitySessionPort {
  resolved = 0;
  constructor(public current: unknown = createAuthenticationSession(sessionInput())) {}
  async issueSession() {
    return createAuthenticationSession(sessionInput());
  }
  async resolveSession(): Promise<AuthenticationSession> {
    this.resolved += 1;
    return this.current as AuthenticationSession;
  }
  async revokeSession(
    command: RevokeAuthenticationSessionCommand,
  ): Promise<SessionRevocationResult> {
    void command;
    throw new Error("not used");
  }
  async rotateSession(): Promise<AuthenticationSession> {
    throw new Error("not used");
  }
}

class FakeTenantOrganizationPort implements TenantOrganizationPort {
  async getBrand(reference: Brand["brandReference"]) {
    return reference === brand.brandReference ? brand : null;
  }
  async getStore(reference: Store["storeReference"]) {
    return [allowedStore, deniedStore].find((value) => value.storeReference === reference) ?? null;
  }
  async saveBrand(value: Brand, expectedVersion: OrganizationVersion) {
    void expectedVersion;
    return value;
  }
  async saveStore(value: Store, expectedVersion: OrganizationVersion) {
    void expectedVersion;
    return value;
  }
  async listStoreReferences(): Promise<readonly StoreReference[]> {
    return Object.freeze([allowedStore.storeReference, deniedStore.storeReference]);
  }
}

class FakeMembershipPort implements MembershipPort {
  memberships: readonly Membership[] = Object.freeze([membership]);
  assignments: readonly StoreAssignment[] = Object.freeze([allowedAssignment, deniedAssignment]);
  async getMembership() {
    return null;
  }
  async findMemberships() {
    return this.memberships;
  }
  async findStoreAssignments(
    membershipReference: Membership["membershipReference"],
    storeReference: Store["storeReference"],
  ) {
    return this.assignments.filter(
      (value) =>
        value.membershipReference === membershipReference &&
        value.storeReference === storeReference,
    );
  }
  async saveMembership(value: Membership, expectedVersion: MembershipVersion) {
    void expectedVersion;
    return value;
  }
  async saveStoreAssignment(value: StoreAssignment, expectedVersion: MembershipVersion) {
    void expectedVersion;
    return value;
  }
  async suspendMembershipAtomically(value: MembershipSuspension, occurredAt: MembershipInstant) {
    void occurredAt;
    return value;
  }
}

class FakePermissionPolicyPort implements PermissionPolicyPort {
  constructor(public snapshot: PermissionPolicySnapshot | null = policySnapshot()) {}
  async loadPolicySnapshot() {
    return this.snapshot;
  }
  async getPermissionDefinition(reference: PermissionReference) {
    return (
      this.snapshot?.permissionDefinitions.find(
        (value) => value.permissionReference === reference,
      ) ?? null
    );
  }
  async getRole(reference: RoleReference): Promise<PermissionRole | null> {
    return this.snapshot?.roles.find((value) => value.roleReference === reference) ?? null;
  }
  async mutatePolicyAtomically(mutation: PermissionPolicyMutation) {
    void mutation;
    if (this.snapshot === null) throw new Error("not used");
    return this.snapshot;
  }
}

interface FixtureOptions {
  readonly identityPort?: FakeIdentitySessionPort;
  readonly membershipPort?: FakeMembershipPort;
  readonly permissionPort?: FakePermissionPolicyPort;
  readonly scopeKind?: "Brand" | "Store";
  readonly selector?: (header: string | null) => unknown;
}

async function serve(options: FixtureOptions = {}) {
  const identityPort = options.identityPort ?? new FakeIdentitySessionPort();
  const membershipPort = options.membershipPort ?? new FakeMembershipPort();
  const permissionPort = options.permissionPort ?? new FakePermissionPolicyPort();
  const tenantPort = new FakeTenantOrganizationPort();
  const resolveAuthenticatedActor = createMerchantAuthenticatedActorResolver({
    identitySessionPort: identityPort,
    now: () => AT,
    resolveSessionReference: (request) =>
      (options.selector ?? ((value) => value))(request.get("x-synthetic-session") ?? null),
  });
  const tenantMiddleware =
    options.scopeKind === "Brand"
      ? createTenantContextMiddleware({
          scopeKind: "Brand",
          brandParameter: "brandId",
          membershipPort,
          now: () => AT,
          resolveAuthenticatedActor,
          tenantOrganizationPort: tenantPort,
        })
      : createTenantContextMiddleware({
          scopeKind: "Store",
          brandParameter: "brandId",
          storeParameter: "storeId",
          membershipPort,
          now: () => AT,
          resolveAuthenticatedActor,
          tenantOrganizationPort: tenantPort,
        });
  const app = express();
  app.use(express.json());
  let handled = 0;
  const path =
    options.scopeKind === "Brand" ? "/brands/:brandId" : "/brands/:brandId/stores/:storeId";
  app.post(
    path,
    tenantMiddleware,
    createMerchantPermissionMiddleware({
      action: ACTION,
      membershipPort,
      permissionPolicyPort: permissionPort,
      requireStoreScope: true,
    }),
    (_request, response) => {
      handled += 1;
      response.status(200).json({ result: "accepted" });
    },
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server address missing");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    handled: () => handled,
    identityPort,
  };
}

function request(
  fixture: Awaited<ReturnType<typeof serve>>,
  storeReference = ids.storeAllowed,
  sessionReference: string | null = ids.session,
) {
  return fetch(
    `${fixture.baseUrl}/brands/${ids.brand}/stores/${storeReference}?storeId=${ids.storeDenied}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-brand-id": uuid("999"),
        ...(sessionReference === null ? {} : { "x-synthetic-session": sessionReference }),
      },
      body: JSON.stringify({ brandId: uuid("998"), storeId: ids.storeDenied }),
    },
  );
}

describe("Merchant authentication integration scenario", () => {
  it("resolves the current Session then allows only the route-derived Store permission", async () => {
    const fixture = await serve();
    const allowed = await request(fixture);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ result: "accepted" });
    expect(fixture.identityPort.resolved).toBe(1);

    const denied = await request(fixture, ids.storeDenied);
    expect(denied.status).toBe(403);
    expect(await denied.text()).toBe('{"error":"permission_denied"}');
    expect(fixture.handled()).toBe(1);
  });

  it("returns one bounded authentication denial for missing, malformed and unusable Sessions", async () => {
    const cases = [
      { port: new FakeIdentitySessionPort(), reference: null },
      { port: new FakeIdentitySessionPort(), reference: "not-a-session" },
      {
        port: new FakeIdentitySessionPort(
          createAuthenticationSession(
            sessionInput({
              status: "Revoked",
              revocationReason: "Logout",
              revokedAt: "2026-07-28T12:20:00.000Z",
            }),
          ),
        ),
        reference: ids.session,
      },
      {
        port: new FakeIdentitySessionPort(
          createAuthenticationSession(sessionInput({ sessionReference: uuid("20") })),
        ),
        reference: ids.session,
      },
    ];
    for (const value of cases) {
      const fixture = await serve({ identityPort: value.port });
      const response = await request(fixture, ids.storeAllowed, value.reference);
      expect(response.status).toBe(401);
      const body = await response.text();
      expect(body).toBe('{"error":"authentication_required"}');
      expect(body).not.toContain(ids.actor);
      expect(body).not.toContain(ids.session);
      expect(fixture.handled()).toBe(0);
    }
  });

  it("rejects Provider-like Actor authority and never treats Identity as a permission source", async () => {
    const forged = sessionInput({
      actor: { ...actorInput(), permissions: [ACTION], storeId: ids.storeAllowed },
    });
    const fixture = await serve({ identityPort: new FakeIdentitySessionPort(forged) });
    const response = await request(fixture);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('{"error":"authentication_required"}');

    const noPolicy = await serve({
      permissionPort: new FakePermissionPolicyPort(null),
    });
    const noPolicyResponse = await request(noPolicy);
    expect(noPolicyResponse.status).toBe(403);
    expect(await noPolicyResponse.text()).toBe('{"error":"permission_denied"}');
    expect(noPolicy.handled()).toBe(0);
  });

  it("preserves explicit deny precedence over the Store Role grant", async () => {
    const fixture = await serve({
      permissionPort: new FakePermissionPolicyPort(policySnapshot(true)),
    });
    const response = await request(fixture);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('{"error":"permission_denied"}');
    expect(fixture.handled()).toBe(0);
  });

  it("rejects a Merchant write when only Brand scope was resolved", async () => {
    const fixture = await serve({ scopeKind: "Brand" });
    const response = await fetch(`${fixture.baseUrl}/brands/${ids.brand}`, {
      method: "POST",
      headers: { "x-synthetic-session": ids.session },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('{"error":"permission_denied"}');
    expect(fixture.handled()).toBe(0);
  });

  it("fails closed on ambiguous Membership and invalid policy evidence", async () => {
    const membershipPort = new FakeMembershipPort();
    membershipPort.memberships = Object.freeze([membership, membership]);
    const ambiguous = await serve({ membershipPort });
    expect((await request(ambiguous)).status).toBe(403);

    const validPolicy = policySnapshot();
    const invalidPolicy = Object.freeze({
      ...validPolicy,
      permissionOverrides: Object.freeze([Object.freeze({ providerSubject: "synthetic-secret" })]),
    }) as unknown as PermissionPolicySnapshot;
    const invalid = await serve({
      permissionPort: new FakePermissionPolicyPort(invalidPolicy),
    });
    const response = await request(invalid);
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toBe('{"error":"permission_denied"}');
    expect(body).not.toContain("synthetic-secret");
  });

  it("keeps concurrent request authentication and authorization isolated", async () => {
    const fixture = await serve();
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        request(fixture, index % 2 === 0 ? ids.storeAllowed : ids.storeDenied),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([
      200, 403, 200, 403, 200, 403, 200, 403,
    ]);
    expect(fixture.handled()).toBe(4);
    expect(fixture.identityPort.resolved).toBe(8);
  });
});
