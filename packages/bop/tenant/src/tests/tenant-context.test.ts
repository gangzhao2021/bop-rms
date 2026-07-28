import { createIdentityActor } from "@bop/identity";
import { describe, expect, it } from "vitest";
import {
  TenantContextContractError,
  createBrand,
  createStore,
  createTenantContext,
} from "../index.js";

const ACTOR = "018f3f7a-8b1c-7a11-8d01-000000000021";
const BRAND = "018f3f7a-8b1c-7a11-8d01-000000000022";
const STORE = "018f3f7a-8b1c-7a11-8d01-000000000023";
const OTHER_BRAND = "018f3f7a-8b1c-7a11-8d01-000000000024";
const NOW = "2026-07-28T20:00:00.000Z";

const actor = (accountKind = "Workforce") =>
  createIdentityActor({
    actorType: "User",
    actorReference: ACTOR,
    accountKind,
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: NOW,
    recentMfaAt: null,
  });

const brand = (lifecycle = "Active") =>
  createBrand({
    brandReference: BRAND,
    code: "CONTEXT_BRAND",
    displayName: "Synthetic Context Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });

const store = (brandReference = BRAND, lifecycle = "Active") =>
  createStore({
    storeReference: STORE,
    brandReference,
    code: "CONTEXT_STORE",
    displayName: "Synthetic Context Store",
    timeZone: "America/Toronto",
    locale: "en-CA",
    currencyCode: "CAD",
    lifecycle,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });

describe("Tenant Context contract", () => {
  it("creates frozen Brand and Store scope values with the closed permission-free shape", () => {
    const brandContext = createTenantContext(actor(), brand(), null, NOW);
    const storeContext = createTenantContext(actor(), brand(), store(), NOW);
    expect(brandContext.scopeKind).toBe("Brand");
    expect(storeContext.scopeKind).toBe("Store");
    expect(storeContext.store?.brandReference).toBe(storeContext.brand.brandReference);
    expect(Object.isFrozen(brandContext)).toBe(true);
    expect(Object.keys(storeContext).sort()).toEqual([
      "actor",
      "brand",
      "resolvedAt",
      "scopeKind",
      "store",
    ]);
    expect(JSON.stringify(storeContext)).not.toMatch(
      /permission|grant|role|session|provider|token/iu,
    );
  });

  it("rejects non-Workforce, non-User and malformed Actor authority", () => {
    expect(() => createTenantContext(actor("Customer"), brand(), null, NOW)).toThrowError(
      "tenant context actor is invalid",
    );
    expect(() =>
      createTenantContext({ ...actor(), unexpected: "claim" } as never, brand(), null, NOW),
    ).toThrow(TenantContextContractError);
  });

  it("denies inactive organization facts and a Store from another Brand", () => {
    expect(() => createTenantContext(actor(), brand("Suspended"), null, NOW)).toThrowError(
      "tenant context brand is denied",
    );
    expect(() => createTenantContext(actor(), brand(), store(BRAND, "Draft"), NOW)).toThrowError(
      "tenant context store is denied",
    );
    expect(() => createTenantContext(actor(), brand(), store(OTHER_BRAND), NOW)).toThrowError(
      "tenant context store is denied",
    );
  });

  it("rejects malformed server instants and accessor-bearing aggregate lookalikes", () => {
    expect(() => createTenantContext(actor(), brand(), null, "2026-07-28T20:00:00Z")).toThrowError(
      "tenant context input is invalid",
    );
    let invoked = false;
    const lookalike = Object.create(null);
    Object.defineProperty(lookalike, "brandReference", {
      enumerable: true,
      get() {
        invoked = true;
        return BRAND;
      },
    });
    expect(() => createTenantContext(actor(), lookalike, null, NOW)).toThrowError(
      "tenant context brand is denied",
    );
    expect(invoked).toBe(false);
  });
});
