import { createIdentityActor } from "@bop/identity";
import { expect, it } from "vitest";
import { createBrand, createTenantContext, TenantContextContractError } from "../index.js";
import {
  createBrandAdministrationContext,
  parseBrandAdministrationContext,
} from "../contracts/brand-administration-context.js";

const at = "2026-10-06T10:00:00.000Z";
const later = "2026-10-06T10:00:00.001Z";
const id = (n: number) => `01902630-0001-7000-8000-${String(n).padStart(12, "0")}`;
const actor = () =>
  createIdentityActor({
    actorType: "User",
    actorReference: id(1),
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: at,
    recentMfaAt: null,
  });
const brand = (lifecycle = "Draft") =>
  createBrand({
    brandReference: id(2),
    code: "SYNTHETIC_ADMINISTRATION",
    displayName: "Synthetic administration Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle,
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
it.each(["Draft", "Active", "Suspended", "Archived"])(
  "retains actual %s identity for administration without operational scope",
  (lifecycle) => {
    const context = createBrandAdministrationContext(actor(), brand(lifecycle), at);
    expect(context.brand.lifecycle).toBe(lifecycle);
    expect(context.actor).toEqual(actor());
    expect(context.store).toBeNull();
    expect(Object.keys(context).sort()).toEqual([
      "actor",
      "brand",
      "profile",
      "purposeCode",
      "resolvedAt",
      "store",
    ]);
    expect(context).not.toHaveProperty("scopeKind");
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.actor)).toBe(true);
    expect(Object.isFrozen(context.brand)).toBe(true);
    expect(parseBrandAdministrationContext(context)).toEqual(context);
    if (lifecycle !== "Active")
      expect(() => createTenantContext(actor(), brand(lifecycle), null, at)).toThrow(
        TenantContextContractError,
      );
  },
);
it.each([
  { accountKind: "Platform" },
  { accountKind: "Customer" },
  { status: "Disabled" },
  { actorType: "Service", accountKind: "Service", authenticationMethod: "ServiceCredential" },
  { actorReference: null },
  { authenticatedAt: later },
  { verificationLevel: "RecentMfa", recentMfaAt: later },
  { grant: "organization.manage" },
])("rejects substituted, inactive or future Actor facts %j", (change) => {
  const context = createBrandAdministrationContext(actor(), brand(), at);
  expect(() =>
    parseBrandAdministrationContext({ ...context, actor: { ...actor(), ...change } }),
  ).toThrow(TenantContextContractError);
});
it.each([
  { profile: "TenantContext" },
  { purposeCode: "MERCHANT_ACCESS" },
  { store: id(3) },
  { scopeKind: "Brand" },
  { permission: "Allow" },
  { resolvedAt: "2026-10-06T10:00:00Z" },
])("rejects another profile, purpose, Store or added authority %j", (change) => {
  const context = createBrandAdministrationContext(actor(), brand(), at);
  expect(() => parseBrandAdministrationContext({ ...context, ...change })).toThrow(
    TenantContextContractError,
  );
});
it("rejects future Brand identity and never invokes accessors", () => {
  const context = createBrandAdministrationContext(actor(), brand(), at);
  expect(() =>
    parseBrandAdministrationContext({ ...context, brand: { ...brand(), updatedAt: later } }),
  ).toThrow(TenantContextContractError);
  let touched = false;
  const accessor = { ...context };
  Object.defineProperty(accessor, "actor", {
    enumerable: true,
    get() {
      touched = true;
      return actor();
    },
  });
  expect(() => parseBrandAdministrationContext(accessor)).toThrow(TenantContextContractError);
  expect(touched).toBe(false);
  const nested = { ...actor() };
  Object.defineProperty(nested, "status", {
    enumerable: true,
    get() {
      touched = true;
      return "Active";
    },
  });
  expect(() => parseBrandAdministrationContext({ ...context, actor: nested })).toThrow(
    TenantContextContractError,
  );
  expect(touched).toBe(false);
});
it("detaches validated identity from mutable caller records", () => {
  const rawActor = { ...actor() },
    rawBrand = { ...brand() };
  const context = createBrandAdministrationContext(rawActor, rawBrand, at);
  rawBrand.displayName = "Changed caller";
  expect(context.brand.displayName).toBe("Synthetic administration Brand");
  expect(() =>
    parseBrandAdministrationContext(createTenantContext(actor(), brand("Active"), null, at)),
  ).toThrow(TenantContextContractError);
});
