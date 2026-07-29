import { createIdentityActor } from "@bop/identity";
import { createMembership, createStoreAssignment, type MembershipPort } from "@bop/membership";
import {
  createPermissionDefinition,
  createPermissionGrant,
  createPermissionRole,
  createPolicyState,
  createRoleAssignment,
  type PermissionPolicyPort,
  type PermissionPolicySnapshot,
} from "@bop/permission";
import { createBrand, createStore, type TenantOrganizationPort } from "@bop/tenant";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createMerchantPermissionMiddleware } from "./merchant-authentication.js";
import {
  createMerchantObjectAuthorizationMiddleware,
  getObjectAuthorizationEvidence,
  type ObjectAuthorizationResolver,
} from "./merchant-object-authorization.js";
import { createTenantContextMiddleware } from "./tenant-context.js";

const uuid = (suffix: string) => `018f8f9a-ad3e-7a11-8d01-${suffix.padStart(12, "0")}`;
const ids = {
  actor: uuid("1"),
  brand: uuid("2"),
  otherBrand: uuid("3"),
  store: uuid("4"),
  siblingStore: uuid("5"),
  membership: uuid("6"),
  workforce: uuid("7"),
  assignment: uuid("8"),
  permission: uuid("9"),
  role: uuid("10"),
  roleAssignment: uuid("11"),
  grant: uuid("12"),
  snapshot: uuid("13"),
  storeObject: uuid("14"),
  brandObject: uuid("15"),
  otherObject: uuid("16"),
};
const FROM = "2026-07-29T12:00:00.000Z";
const AT = "2026-07-29T12:30:00.000Z";
const UNTIL = "2026-07-29T13:00:00.000Z";
const ACTION = "synthetic.object.update";
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

const actor = createIdentityActor({
  actorType: "User",
  actorReference: ids.actor,
  accountKind: "Workforce",
  status: "Active",
  authenticationMethod: "Oidc",
  verificationLevel: "SingleFactor",
  authenticatedAt: FROM,
  recentMfaAt: null,
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
    displayName: code,
    timeZone: "America/Toronto",
    locale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  });
const selectedStore = store(ids.store, "SELECTED");
const siblingStore = store(ids.siblingStore, "SIBLING");
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
  actor,
);
const assignment = createStoreAssignment(
  {
    storeAssignmentReference: ids.assignment,
    membershipReference: ids.membership,
    actorReference: ids.actor,
    brandReference: ids.brand,
    storeReference: ids.store,
    lifecycle: "Active",
    effectiveFrom: FROM,
    effectiveUntil: UNTIL,
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  },
  membership,
  selectedStore,
);

function membershipPort(): MembershipPort {
  return {
    async getMembership() {
      return membership;
    },
    async findMemberships() {
      return Object.freeze([membership]);
    },
    async findStoreAssignments() {
      return Object.freeze([assignment]);
    },
    async saveMembership(value) {
      return value;
    },
    async saveStoreAssignment(value) {
      return value;
    },
    async suspendMembershipAtomically(value) {
      return value;
    },
  };
}

const tenantPort: TenantOrganizationPort = {
  async getBrand(reference) {
    return reference === brand.brandReference ? brand : null;
  },
  async getStore(reference) {
    return (
      [selectedStore, siblingStore].find((value) => value.storeReference === reference) ?? null
    );
  },
  async saveBrand(value) {
    return value;
  },
  async saveStore(value) {
    return value;
  },
  async listStoreReferences() {
    return Object.freeze([selectedStore.storeReference, siblingStore.storeReference]);
  },
};

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
    storeReference: ids.store,
    code: "synthetic_operator",
    lifecycle: "Active",
    effectiveFrom: FROM,
    effectiveUntil: UNTIL,
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  },
  brand,
  selectedStore,
);
const roleAssignment = createRoleAssignment(
  {
    assignmentReference: ids.roleAssignment,
    roleReference: ids.role,
    membershipReference: ids.membership,
    storeAssignmentReference: ids.assignment,
    actorReference: ids.actor,
    brandReference: ids.brand,
    storeReference: ids.store,
    lifecycle: "Active",
    effectiveFrom: FROM,
    effectiveUntil: UNTIL,
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  },
  role,
  membership,
  assignment,
);
const grant = createPermissionGrant(
  {
    grantReference: ids.grant,
    roleReference: ids.role,
    permissionReference: ids.permission,
    action: ACTION,
    brandReference: ids.brand,
    storeReference: ids.store,
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

function policyPort(includeGrant = true): PermissionPolicyPort {
  const snapshot: PermissionPolicySnapshot = Object.freeze({
    state,
    permissionDefinitions: Object.freeze([permission]),
    roles: Object.freeze([role]),
    roleAssignments: Object.freeze([roleAssignment]),
    permissionGrants: Object.freeze(includeGrant ? [grant] : []),
    permissionOverrides: Object.freeze([]),
  });
  return {
    async loadPolicySnapshot() {
      return snapshot;
    },
    async getPermissionDefinition(reference) {
      return reference === permission.permissionReference ? permission : null;
    },
    async getRole(reference) {
      return reference === role.roleReference ? role : null;
    },
    async mutatePolicyAtomically() {
      throw new Error("unused");
    },
  };
}

const evidence = (
  objectReference: string,
  scopeKind: "Brand" | "Store",
  brandReference = ids.brand,
  storeReference: string | null = scopeKind === "Store" ? ids.store : null,
) =>
  Object.freeze({
    objectReference,
    scopeKind,
    brandReference,
    storeReference,
    version: 1,
  });

async function start(
  resolver: ObjectAuthorizationResolver,
  options: {
    readonly includePermission?: boolean;
    readonly onRequest?: (request: express.Request) => void;
  } = {},
) {
  const app = express();
  let requestSeen: express.Request | undefined;
  app.get(
    "/brands/:brandId/stores/:storeId/objects/:objectId",
    createTenantContextMiddleware({
      scopeKind: "Store",
      brandParameter: "brandId",
      storeParameter: "storeId",
      resolveAuthenticatedActor: async () => actor,
      membershipPort: membershipPort(),
      tenantOrganizationPort: tenantPort,
      now: () => AT,
    }),
    createMerchantPermissionMiddleware({
      action: ACTION,
      membershipPort: membershipPort(),
      permissionPolicyPort: policyPort(options.includePermission ?? true),
      requireStoreScope: true,
    }),
    createMerchantObjectAuthorizationMiddleware({
      action: ACTION,
      objectParameter: "objectId",
      resolveObjectAuthorization: resolver,
    }),
    (request, response) => {
      requestSeen = request;
      options.onRequest?.(request);
      response.json({ version: getObjectAuthorizationEvidence(request).version });
    },
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("listen failed");
  return {
    request: () => requestSeen,
    url: `http://127.0.0.1:${address.port}/brands/${ids.brand}/stores/${ids.store}/objects`,
  };
}

describe("WP-0109 merchant object authorization", () => {
  it("allows exact Store evidence only when the existing action permission also allows", async () => {
    const app = await start(async ({ tenantContext, action, objectReference }) => {
      expect(tenantContext.store?.storeReference).toBe(ids.store);
      expect(action).toBe(ACTION);
      return evidence(objectReference, "Store");
    });
    const response = await fetch(`${app.url}/${ids.storeObject}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 1 });
  });

  it("allows same-Brand evidence inside an exact Store context", async () => {
    const app = await start(async () => evidence(ids.brandObject, "Brand"));
    expect((await fetch(`${app.url}/${ids.brandObject}`)).status).toBe(200);
  });

  it.each([
    ["not found", async () => null],
    ["mismatched reference", async () => evidence(ids.otherObject, "Store")],
    ["sibling Store", async () => evidence(ids.storeObject, "Store", ids.brand, ids.siblingStore)],
    ["other Brand", async () => evidence(ids.storeObject, "Store", ids.otherBrand, ids.store)],
    [
      "mutable evidence",
      async () => ({
        ...evidence(ids.storeObject, "Store"),
      }),
    ],
    [
      "unknown evidence field",
      async () => Object.freeze({ ...evidence(ids.storeObject, "Store"), leaked: true }),
    ],
  ])(
    "uses one denial for %s without reaching the permission/action handler",
    async (_name, resolver) => {
      const app = await start(resolver);
      const response = await fetch(`${app.url}/${ids.storeObject}`);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "object_access_denied" });
    },
  );

  it("does not let valid object scope substitute for a missing action permission", async () => {
    const app = await start(async () => evidence(ids.storeObject, "Store"), {
      includePermission: false,
    });
    const response = await fetch(`${app.url}/${ids.storeObject}`);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "permission_denied" });
  });

  it("rejects malformed references before calling the owning-Domain resolver", async () => {
    let calls = 0;
    const app = await start(async () => {
      calls += 1;
      return evidence(ids.storeObject, "Store");
    });
    const response = await fetch(`${app.url}/raw-object-id`);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "object_access_denied" });
    expect(calls).toBe(0);
  });

  it("keeps scope non-enumerable and removes it when the response completes", async () => {
    let objectScopeNonEnumerable = false;
    const app = await start(async () => evidence(ids.storeObject, "Store"), {
      onRequest(request) {
        const objectScope = getObjectAuthorizationEvidence(request);
        const objectScopeSymbol = Object.getOwnPropertySymbols(request).find(
          (symbol) => Reflect.get(request, symbol) === objectScope,
        );
        objectScopeNonEnumerable =
          objectScopeSymbol !== undefined &&
          Object.getOwnPropertyDescriptor(request, objectScopeSymbol)?.enumerable === false;
      },
    });
    expect((await fetch(`${app.url}/${ids.storeObject}`)).status).toBe(200);
    expect(objectScopeNonEnumerable).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const completedRequest = app.request();
    expect(completedRequest).toBeDefined();
    if (completedRequest === undefined) throw new Error("request was not observed");
    expect(() => getObjectAuthorizationEvidence(completedRequest)).toThrow();
  });
});
