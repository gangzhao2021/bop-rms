import { createIdentityActor } from "@bop/identity";
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
  createBrand,
  createStore,
  type Brand,
  type OrganizationVersion,
  type Store,
  type StoreReference,
  type TenantOrganizationPort,
} from "@bop/tenant";
import express, { type Request } from "express";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTenantContextMiddleware,
  getTenantContext,
  type TenantContextMiddlewareOptions,
} from "./tenant-context.js";

const ids = {
  actor: "018f3f7a-8b1c-7a11-8d01-000000000031",
  brand: "018f3f7a-8b1c-7a11-8d01-000000000032",
  otherBrand: "018f3f7a-8b1c-7a11-8d01-000000000033",
  store: "018f3f7a-8b1c-7a11-8d01-000000000034",
  membership: "018f3f7a-8b1c-7a11-8d01-000000000035",
  relationship: "018f3f7a-8b1c-7a11-8d01-000000000036",
  assignment: "018f3f7a-8b1c-7a11-8d01-000000000037",
};
const NOW = "2026-07-28T20:00:00.000Z";
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

const actor = (accountKind = "Workforce") =>
  createIdentityActor({
    actorType: "User",
    actorReference: ids.actor,
    accountKind,
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: NOW,
    recentMfaAt: null,
  });

const brand = (lifecycle = "Active", brandReference = ids.brand) =>
  createBrand({
    brandReference,
    code: brandReference === ids.brand ? "BRAND_ONE" : "BRAND_TWO",
    displayName: "Synthetic Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });

const store = (lifecycle = "Active", brandReference = ids.brand) =>
  createStore({
    storeReference: ids.store,
    brandReference,
    code: "STORE_ONE",
    displayName: "Synthetic Store",
    timeZone: "America/Toronto",
    locale: "en-CA",
    currencyCode: "CAD",
    lifecycle,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });

const membership = () =>
  createMembership(
    {
      membershipReference: ids.membership,
      actorReference: ids.actor,
      brandReference: ids.brand,
      workforceRelationshipReference: ids.relationship,
      lifecycle: "Active",
      effectiveFrom: "2026-07-28T19:00:00.000Z",
      effectiveUntil: null,
      version: 1,
      createdAt: "2026-07-28T19:00:00.000Z",
      updatedAt: "2026-07-28T19:00:00.000Z",
    },
    actor(),
  );

const assignment = (membershipFact = membership(), storeFact = store()) =>
  createStoreAssignment(
    {
      storeAssignmentReference: ids.assignment,
      membershipReference: ids.membership,
      actorReference: ids.actor,
      brandReference: ids.brand,
      storeReference: ids.store,
      lifecycle: "Active",
      effectiveFrom: "2026-07-28T19:00:00.000Z",
      effectiveUntil: null,
      version: 1,
      createdAt: "2026-07-28T19:00:00.000Z",
      updatedAt: "2026-07-28T19:00:00.000Z",
    },
    membershipFact,
    storeFact,
  );

class FakeTenantPort implements TenantOrganizationPort {
  brands: Brand[] = [brand()];
  stores: Store[] = [store()];
  async getBrand(reference: Brand["brandReference"]) {
    return this.brands.find((item) => item.brandReference === reference) ?? null;
  }
  async getStore(reference: Store["storeReference"]) {
    return this.stores.find((item) => item.storeReference === reference) ?? null;
  }
  async saveBrand(brandFact: Brand, expectedVersion: OrganizationVersion) {
    void expectedVersion;
    return brandFact;
  }
  async saveStore(storeFact: Store, expectedVersion: OrganizationVersion) {
    void expectedVersion;
    return storeFact;
  }
  async listStoreReferences(): Promise<readonly StoreReference[]> {
    return [] as const;
  }
}

class FakeMembershipPort implements MembershipPort {
  memberships: Membership[] = [membership()];
  assignments: StoreAssignment[] = [assignment()];
  async getMembership() {
    return null;
  }
  async findMemberships() {
    return this.memberships;
  }
  async findStoreAssignments() {
    return this.assignments;
  }
  async saveMembership(membershipFact: Membership, expectedVersion: MembershipVersion) {
    void expectedVersion;
    return membershipFact;
  }
  async saveStoreAssignment(assignmentFact: StoreAssignment, expectedVersion: MembershipVersion) {
    void expectedVersion;
    return assignmentFact;
  }
  async suspendMembershipAtomically(
    suspension: MembershipSuspension,
    occurredAt: MembershipInstant,
  ) {
    void occurredAt;
    return suspension;
  }
}

async function serve(
  options: TenantContextMiddlewareOptions,
  route = "/brands/:brandId/stores/:storeId",
) {
  const app = express();
  app.use(express.json());
  let capturedRequest: Request | undefined;
  let enumerableKeys: string[] = [];
  app.post(route, createTenantContextMiddleware(options), (request, response) => {
    capturedRequest = request;
    enumerableKeys = Object.keys(request);
    const context = getTenantContext(request);
    response.json({
      scopeKind: context.scopeKind,
      brandReference: context.brand.brandReference,
      storeReference: context.store?.storeReference ?? null,
    });
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server address missing");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    captured: () => capturedRequest,
    enumerable: () => enumerableKeys,
  };
}

function storeOptions(
  tenantPort = new FakeTenantPort(),
  membershipPort = new FakeMembershipPort(),
): TenantContextMiddlewareOptions {
  return {
    scopeKind: "Store",
    brandParameter: "brandId",
    storeParameter: "storeId",
    resolveAuthenticatedActor: () => actor(),
    membershipPort,
    now: () => NOW,
    tenantOrganizationPort: tenantPort,
  };
}

describe("Tenant Context middleware", () => {
  it("resolves exact Store scope from route facts and cleans private request state on finish", async () => {
    const fixture = await serve(storeOptions());
    const response = await fetch(
      `${fixture.baseUrl}/brands/${ids.brand}/stores/${ids.store}?brandId=${ids.otherBrand}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-brand-id": ids.otherBrand,
          "x-store-id": ids.otherBrand,
        },
        body: JSON.stringify({ brandId: ids.otherBrand, storeId: ids.otherBrand }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      scopeKind: "Store",
      brandReference: ids.brand,
      storeReference: ids.store,
    });
    const completed = fixture.captured();
    if (completed === undefined) throw new Error("request was not captured");
    expect(fixture.enumerable()).not.toContain("tenantContext");
    expect(() => getTenantContext(completed)).toThrowError("TENANT_CONTEXT_UNAVAILABLE");
  });

  it("supports exact Brand scope without inventing a Store or action permission", async () => {
    const tenantPort = new FakeTenantPort();
    const membershipPort = new FakeMembershipPort();
    const fixture = await serve(
      {
        scopeKind: "Brand",
        brandParameter: "brandId",
        resolveAuthenticatedActor: () => actor(),
        membershipPort,
        now: () => NOW,
        tenantOrganizationPort: tenantPort,
      },
      "/brands/:brandId",
    );
    const response = await fetch(`${fixture.baseUrl}/brands/${ids.brand}`, { method: "POST" });
    expect(await response.json()).toEqual({
      scopeKind: "Brand",
      brandReference: ids.brand,
      storeReference: null,
    });
  });

  it("returns the closed authentication error for missing or failed authentication", async () => {
    for (const resolver of [() => null, () => Promise.reject(new Error("raw-provider-error"))]) {
      const fixture = await serve({
        ...storeOptions(),
        resolveAuthenticatedActor: resolver,
      });
      const response = await fetch(`${fixture.baseUrl}/brands/${ids.brand}/stores/${ids.store}`, {
        method: "POST",
      });
      expect(response.status).toBe(401);
      const body = await response.text();
      expect(body).toBe('{"error":"authentication_required"}');
      expect(body).not.toContain(ids.actor);
      expect(body).not.toContain("raw-provider-error");
    }
  });

  it("denies invalid Actor, route mismatch, inactive facts and missing or ambiguous access", async () => {
    const cases: TenantContextMiddlewareOptions[] = [];
    cases.push({ ...storeOptions(), resolveAuthenticatedActor: () => actor("Customer") });

    const inactiveTenant = new FakeTenantPort();
    inactiveTenant.stores = [store("Suspended")];
    cases.push(storeOptions(inactiveTenant));

    const noMembership = new FakeMembershipPort();
    noMembership.memberships = [];
    cases.push(storeOptions(new FakeTenantPort(), noMembership));

    const ambiguousMembership = new FakeMembershipPort();
    ambiguousMembership.memberships = [membership(), membership()];
    cases.push(storeOptions(new FakeTenantPort(), ambiguousMembership));

    const noAssignment = new FakeMembershipPort();
    noAssignment.assignments = [];
    cases.push(storeOptions(new FakeTenantPort(), noAssignment));

    for (const options of cases) {
      const fixture = await serve(options);
      const response = await fetch(`${fixture.baseUrl}/brands/${ids.brand}/stores/${ids.store}`, {
        method: "POST",
      });
      expect(response.status).toBe(403);
      expect(await response.text()).toBe('{"error":"tenant_context_denied"}');
    }

    const mismatch = await serve(storeOptions());
    const response = await fetch(
      `${mismatch.baseUrl}/brands/${ids.otherBrand}/stores/${ids.store}`,
      { method: "POST" },
    );
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toBe('{"error":"tenant_context_denied"}');
    expect(body).not.toContain(ids.otherBrand);
  });

  it("keeps simultaneous request contexts isolated", async () => {
    const fixture = await serve(storeOptions());
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetch(`${fixture.baseUrl}/brands/${ids.brand}/stores/${ids.store}`, {
          method: "POST",
        }),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(
      await Promise.all(
        responses.map(
          async (response) =>
            ((await response.json()) as { readonly scopeKind: unknown }).scopeKind,
        ),
      ),
    ).toEqual(Array.from({ length: 8 }, () => "Store"));
  });

  it("deletes private request state when the response closes before finish", async () => {
    const response = new EventEmitter();
    Object.assign(response, {
      headersSent: false,
      json: () => response,
      status: () => response,
    });
    const request = {
      params: { brandId: ids.brand, storeId: ids.store },
      res: response,
    } as unknown as Request;
    const nextCalled = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("tenant middleware did not call next")),
        1_000,
      );
      createTenantContextMiddleware(storeOptions())(
        request,
        response as never,
        (() => {
          clearTimeout(timeout);
          resolve();
        }) as never,
      );
    });
    await nextCalled;
    expect(getTenantContext(request).scopeKind).toBe("Store");
    response.emit("close");
    expect(() => getTenantContext(request)).toThrowError("TENANT_CONTEXT_UNAVAILABLE");
  });
});
