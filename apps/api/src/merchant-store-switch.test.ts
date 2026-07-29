import {
  createAuthenticationSession,
  merchantSessionCookie,
  type AuthenticationSession,
  type BrowserCookieMutation,
} from "@bop/identity";
import {
  createMembership,
  createStoreAssignment,
  type Membership,
  type MembershipPort,
  type StoreAssignment,
} from "@bop/membership";
import {
  createBrand,
  createStore,
  type Brand,
  type Store,
  type TenantOrganizationPort,
} from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  MerchantStoreSwitchService,
  type StoreContextSessionPort,
} from "./merchant-store-switch.js";

const uuid = (suffix: string) => `018f8f9a-ad3e-7a11-8d01-${suffix.padStart(12, "0")}`;
const ids = {
  actor: uuid("1"),
  formerSession: uuid("2"),
  nextSession: uuid("3"),
  brand: uuid("4"),
  otherBrand: uuid("5"),
  store: uuid("6"),
  otherStore: uuid("7"),
  membership: uuid("8"),
  otherMembership: uuid("9"),
  workforce: uuid("10"),
  assignment: uuid("11"),
  otherAssignment: uuid("12"),
};
const FROM = "2026-07-29T12:00:00.000Z";
const AT = "2026-07-29T12:30:00.000Z";
const UNTIL = "2026-07-29T13:00:00.000Z";
const COOKIE = "A".repeat(43);
const NEXT_COOKIE = "B".repeat(43);
const CSRF = "C".repeat(43);

const brand = (reference: string, code: string): Brand =>
  createBrand({
    brandReference: reference,
    code,
    displayName: code,
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  });
const primaryBrand = brand(ids.brand, "PRIMARY");
const otherBrand = brand(ids.otherBrand, "OTHER");
const store = (reference: string, owner: Brand, code: string): Store =>
  createStore({
    storeReference: reference,
    brandReference: owner.brandReference,
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
const primaryStore = store(ids.store, primaryBrand, "PRIMARY");
const crossBrandStore = store(ids.otherStore, otherBrand, "OTHER");

const currentSession = createAuthenticationSession({
  sessionReference: ids.formerSession,
  actor: {
    actorType: "User",
    actorReference: ids.actor,
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: FROM,
    recentMfaAt: null,
  },
  status: "Active",
  policyCode: "WorkforceStandard",
  maxActiveSessions: 5,
  idleTimeoutMinutes: 30,
  absoluteTimeoutMinutes: 720,
  version: 1,
  authenticatedAt: FROM,
  createdAt: FROM,
  lastSeenAt: "2026-07-29T12:15:00.000Z",
  idleExpiresAt: "2026-07-29T12:45:00.000Z",
  absoluteExpiresAt: "2026-07-30T00:00:00.000Z",
  rotatedFromSessionReference: null,
  revocationReason: null,
  revokedAt: null,
});

function nextSession(overrides: Readonly<Record<string, unknown>> = {}): AuthenticationSession {
  return createAuthenticationSession({
    sessionReference: ids.nextSession,
    actor: currentSession.actor,
    status: "Active",
    policyCode: "WorkforceStandard",
    maxActiveSessions: 5,
    idleTimeoutMinutes: 30,
    absoluteTimeoutMinutes: 720,
    version: 2,
    authenticatedAt: FROM,
    createdAt: AT,
    lastSeenAt: AT,
    idleExpiresAt: "2026-07-29T13:00:00.000Z",
    absoluteExpiresAt: "2026-07-30T00:30:00.000Z",
    rotatedFromSessionReference: ids.formerSession,
    revocationReason: null,
    revokedAt: null,
    ...overrides,
  });
}

function membershipFor(
  owner: Brand,
  targetStore: Store,
  references: { readonly membership: string; readonly assignment: string },
): readonly [Membership, StoreAssignment] {
  const membership = createMembership(
    {
      membershipReference: references.membership,
      actorReference: ids.actor,
      brandReference: owner.brandReference,
      workforceRelationshipReference: ids.workforce,
      lifecycle: "Active",
      effectiveFrom: FROM,
      effectiveUntil: UNTIL,
      version: 1,
      createdAt: FROM,
      updatedAt: FROM,
    },
    currentSession.actor,
  );
  const assignment = createStoreAssignment(
    {
      storeAssignmentReference: references.assignment,
      membershipReference: membership.membershipReference,
      actorReference: ids.actor,
      brandReference: owner.brandReference,
      storeReference: targetStore.storeReference,
      lifecycle: "Active",
      effectiveFrom: FROM,
      effectiveUntil: UNTIL,
      version: 1,
      createdAt: FROM,
      updatedAt: FROM,
    },
    membership,
    targetStore,
  );
  return Object.freeze([membership, assignment]);
}
const [primaryMembership, primaryAssignment] = membershipFor(primaryBrand, primaryStore, {
  membership: ids.membership,
  assignment: ids.assignment,
});
const [otherMembership, otherAssignment] = membershipFor(otherBrand, crossBrandStore, {
  membership: ids.otherMembership,
  assignment: ids.otherAssignment,
});

class SyntheticSessionPort implements StoreContextSessionPort {
  active = true;
  authorizations = 0;
  rotations = 0;
  next: AuthenticationSession = nextSession();
  badCookie = false;

  async authorize(input: { readonly sessionCookie: unknown; readonly csrf: unknown }) {
    this.authorizations += 1;
    if (!this.active || input.sessionCookie !== COOKIE || input.csrf !== CSRF)
      throw new Error("denied");
    return currentSession;
  }

  async rotate(sessionCookie: unknown, reason: "StoreContextElevation") {
    if (!this.active || sessionCookie !== COOKIE || reason !== "StoreContextElevation")
      throw new Error("denied");
    this.active = false;
    this.rotations += 1;
    await Promise.resolve();
    const cookie: BrowserCookieMutation = Object.freeze({
      descriptor: merchantSessionCookie,
      value: this.badCookie ? "raw" : NEXT_COOKIE,
      clear: false,
    }) as BrowserCookieMutation;
    return Object.freeze({ session: this.next, cookie });
  }
}

function tenantPort(): TenantOrganizationPort {
  return {
    async getBrand(reference) {
      return [primaryBrand, otherBrand].find((value) => value.brandReference === reference) ?? null;
    },
    async getStore(reference) {
      return (
        [primaryStore, crossBrandStore].find((value) => value.storeReference === reference) ?? null
      );
    },
    async saveBrand(value) {
      return value;
    },
    async saveStore(value) {
      return value;
    },
    async listStoreReferences(reference) {
      return Object.freeze(
        [primaryStore, crossBrandStore]
          .filter((value) => value.brandReference === reference)
          .map((value) => value.storeReference),
      );
    },
  };
}

function membershipPort(
  options: {
    readonly memberships?: readonly Membership[];
    readonly assignments?: readonly StoreAssignment[];
  } = {},
): MembershipPort {
  const memberships = options.memberships ?? [primaryMembership, otherMembership];
  const assignments = options.assignments ?? [primaryAssignment, otherAssignment];
  return {
    async getMembership(reference) {
      return memberships.find((value) => value.membershipReference === reference) ?? null;
    },
    async findMemberships(actorReference, brandReference) {
      return Object.freeze(
        memberships.filter(
          (value) =>
            value.actorReference === actorReference && value.brandReference === brandReference,
        ),
      );
    },
    async findStoreAssignments(membershipReference, storeReference) {
      return Object.freeze(
        assignments.filter(
          (value) =>
            value.membershipReference === membershipReference &&
            value.storeReference === storeReference,
        ),
      );
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

function service(sessions: SyntheticSessionPort, memberships: MembershipPort = membershipPort()) {
  return new MerchantStoreSwitchService({
    sessionPort: sessions,
    tenantOrganizationPort: tenantPort(),
    membershipPort: memberships,
    now: () => AT,
  });
}

const input = (targetStoreReference: string = ids.store) => ({
  sessionCookie: COOKIE,
  csrf: CSRF,
  targetStoreReference,
});

describe("WP-0109 merchant Store switch", () => {
  it("revalidates the target facts then rotates Session and returns minimum canonical context", async () => {
    const sessions = new SyntheticSessionPort();
    const result = await service(sessions).switchStore(input());
    expect(result.cookie.value).toBe(NEXT_COOKIE);
    expect(result.tenantContext.actor.actorReference).toBe(ids.actor);
    expect(result.tenantContext.brand.brandReference).toBe(ids.brand);
    expect(result.tenantContext.store?.storeReference).toBe(ids.store);
    expect(Object.keys(result)).toEqual(["cookie", "tenantContext"]);
    expect(sessions.authorizations).toBe(1);
    expect(sessions.rotations).toBe(1);
    await expect(service(sessions).switchStore(input())).rejects.toThrow("STORE_SWITCH_DENIED");
  });

  it("derives another Brand from Store and permits it only with independent active authority", async () => {
    const sessions = new SyntheticSessionPort();
    const result = await service(sessions).switchStore(input(ids.otherStore));
    expect(result.tenantContext.brand.brandReference).toBe(ids.otherBrand);
    expect(result.tenantContext.store?.storeReference).toBe(ids.otherStore);
  });

  it.each([
    ["missing target Store", input(uuid("99")), membershipPort()],
    [
      "missing target Membership",
      input(ids.otherStore),
      membershipPort({ memberships: [primaryMembership], assignments: [primaryAssignment] }),
    ],
    [
      "missing exact Store Assignment",
      input(ids.otherStore),
      membershipPort({ memberships: [primaryMembership, otherMembership], assignments: [] }),
    ],
    [
      "ambiguous target Membership",
      input(),
      membershipPort({
        memberships: [primaryMembership, primaryMembership],
        assignments: [primaryAssignment],
      }),
    ],
  ])("denies %s before Session rotation", async (_name, request, memberships) => {
    const sessions = new SyntheticSessionPort();
    await expect(service(sessions, memberships).switchStore(request)).rejects.toThrow(
      "STORE_SWITCH_DENIED",
    );
    expect(sessions.rotations).toBe(0);
  });

  it("denies invalid Session/CSRF before resolving or rotating target authority", async () => {
    const sessions = new SyntheticSessionPort();
    await expect(service(sessions).switchStore({ ...input(), csrf: "wrong" })).rejects.toThrow(
      "STORE_SWITCH_DENIED",
    );
    expect(sessions.rotations).toBe(0);
  });

  it("fails closed on invalid rotated adapter output", async () => {
    const sessions = new SyntheticSessionPort();
    sessions.badCookie = true;
    await expect(service(sessions).switchStore(input())).rejects.toThrow("STORE_SWITCH_DENIED");
    expect(sessions.rotations).toBe(1);
  });

  it("allows only one concurrent expected-version rotation winner", async () => {
    const sessions = new SyntheticSessionPort();
    const results = await Promise.allSettled([
      service(sessions).switchStore(input()),
      service(sessions).switchStore(input()),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(sessions.rotations).toBe(1);
  });
});
