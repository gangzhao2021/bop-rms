import { createIdentityActor } from "@bop/identity";
import { createMembership, createStoreAssignment } from "@bop/membership";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
export const uuid = (suffix: string) => `018f4f8a-9c2d-7a11-8d01-${suffix.padStart(12, "0")}`;
export const ACTOR = uuid("1");
export const BRAND = uuid("2");
export const OTHER_BRAND = uuid("3");
export const STORE = uuid("4");
export const MEMBERSHIP = uuid("5");
export const WORKFORCE = uuid("6");
export const STORE_ASSIGNMENT = uuid("7");
export const PERMISSION = uuid("8");
export const BRAND_ROLE = uuid("9");
export const STORE_ROLE = uuid("10");
export const BRAND_ASSIGNMENT = uuid("11");
export const STORE_ROLE_ASSIGNMENT = uuid("12");
export const BRAND_GRANT = uuid("13");
export const STORE_GRANT = uuid("14");
export const DENY = uuid("15");
export const ALLOW = uuid("16");
export const REASON = uuid("17");
export const CORRELATION = uuid("18");
export const SNAPSHOT = uuid("19");
export const NEXT_SNAPSHOT = uuid("20");
export const FROM = "2026-07-28T12:00:00.000Z";
export const AT = "2026-07-28T12:30:00.000Z";
export const UNTIL = "2026-07-28T13:00:00.000Z";
export const LATER = "2026-07-28T14:00:00.000Z";
export const ACTION = "synthetic.resource.update";

export const actor = createIdentityActor({
  actorType: "User",
  actorReference: ACTOR,
  accountKind: "Workforce",
  status: "Active",
  authenticationMethod: "Oidc",
  verificationLevel: "SingleFactor",
  authenticatedAt: FROM,
  recentMfaAt: null,
});
export const brand = createBrand({
  brandReference: BRAND,
  code: "SYNTHETIC",
  displayName: "Synthetic Brand",
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Active",
  version: 1,
  createdAt: FROM,
  updatedAt: FROM,
});
export const otherBrand = createBrand({
  ...brand,
  brandReference: OTHER_BRAND,
  code: "OTHER",
});
export const store = createStore({
  storeReference: STORE,
  brandReference: BRAND,
  code: "SYNTHETIC_1",
  displayName: "Synthetic Store",
  timeZone: "America/Toronto",
  locale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Active",
  version: 1,
  createdAt: FROM,
  updatedAt: FROM,
});
export const membership = createMembership(
  {
    membershipReference: MEMBERSHIP,
    actorReference: ACTOR,
    brandReference: BRAND,
    workforceRelationshipReference: WORKFORCE,
    lifecycle: "Active",
    effectiveFrom: FROM,
    effectiveUntil: UNTIL,
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  },
  actor,
);
export const storeAssignment = createStoreAssignment(
  {
    storeAssignmentReference: STORE_ASSIGNMENT,
    membershipReference: MEMBERSHIP,
    actorReference: ACTOR,
    brandReference: BRAND,
    storeReference: STORE,
    lifecycle: "Active",
    effectiveFrom: FROM,
    effectiveUntil: UNTIL,
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  },
  membership,
  store,
);

export const tenantContext = createTenantContext(actor, brand, store, AT);
