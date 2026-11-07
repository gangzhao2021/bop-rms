import { describe, expect, it } from "vitest";
import { createIdentityActor } from "../contracts/identity-actor.js";
import {
  createAuthenticationSession,
  sessionPolicies,
} from "../contracts/authentication-session.js";
import {
  parseWorkforceActor,
  parseWorkforceSessionMfa,
  parseWorkforceSessionSecrets,
  assertWorkforceSessionCurrent,
  workforceAuthorizationCookie,
  workforceSessionCookie,
  workforceAuthorizationContext,
  workforceSessionContext,
} from "../contracts/workforce-browser-session.js";
import {
  parsePlatformSessionSecrets,
  platformAuthorizationContext,
  platformSessionContext,
} from "../contracts/platform-browser-session.js";
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`,
  at = "2026-10-06T12:00:00.000Z";
function fixture() {
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
  const session = createAuthenticationSession({
    sessionReference: id(1),
    actor,
    status: "Active",
    policyCode: "Privileged",
    maxActiveSessions: sessionPolicies.Privileged.maxActiveSessions,
    idleTimeoutMinutes: 15,
    absoluteTimeoutMinutes: 480,
    version: 1,
    authenticatedAt: at,
    createdAt: at,
    lastSeenAt: "2026-10-06T12:10:00.000Z",
    idleExpiresAt: "2026-10-06T12:25:00.000Z",
    absoluteExpiresAt: "2026-10-06T20:00:00.000Z",
    rotatedFromSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  });
  const configuration = { issuer: "https://identity.invalid/", clientId: "controlled-workforce" },
    mfa = {
      sessionReference: id(1),
      actorReference: id(2),
      method: "Totp",
      evidenceReference: id(3),
      authorizationTransactionReference: id(4),
      authenticatedAt: at,
      verifiedAt: at,
      validUntil: "2026-10-06T12:15:00.000Z",
    },
    payload = {
      profile: "WorkforceBrowserSessionV1",
      ...configuration,
      tokenBundle: "controlled-encrypted-owner-payload",
      csrf: "x".repeat(43),
      mfa,
    };
  return { actor, session, configuration, mfa, payload };
}
describe("Workforce strong Session contract", () => {
  it("has independent fixed host cookies, profiles and encryption contexts", () => {
    const f = fixture(),
      parsed = parseWorkforceSessionSecrets(f.payload, f.configuration, f.session);
    expect(parsed.profile).toBe("WorkforceBrowserSessionV1");
    expect(workforceAuthorizationCookie).toMatchObject({
      name: "__Host-bop-auth",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAgeSeconds: 600,
    });
    expect(workforceSessionCookie).toMatchObject({
      name: "__Host-bop-merchant",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAgeSeconds: null,
    });
    expect(workforceSessionContext("controlled", id(1), id(2))).toBe(
      `controlled:session:${id(1)}:${id(2)}`,
    );
    expect(workforceAuthorizationContext("controlled", id(4))).toBe(`controlled:oidc:${id(4)}`);
    expect(workforceSessionContext("controlled", id(1), id(2))).not.toBe(
      platformSessionContext("controlled", id(1), id(2)),
    );
    expect(workforceAuthorizationContext("controlled", id(4))).not.toBe(
      platformAuthorizationContext("controlled", id(4)),
    );
    expect(() => parsePlatformSessionSecrets(f.payload, f.configuration, f.session)).toThrow();
  });
  it("returns detached frozen same-Session proof, not a claim of business permission", () => {
    const f = fixture(),
      parsed = parseWorkforceSessionSecrets(f.payload, f.configuration, f.session);
    f.mfa.evidenceReference = id(90);
    expect(parsed.mfa.evidenceReference).toBe(id(3));
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.mfa)).toBe(true);
    expect(parsed).not.toHaveProperty("permissions");
  });
  it("keeps expired MFA readable while refusing actions at the exact deadline", () => {
    const f = fixture(),
      proof = parseWorkforceSessionSecrets(f.payload, f.configuration, f.session).mfa;
    expect(() =>
      assertWorkforceSessionCurrent(f.session, proof, "2026-10-06T12:15:00.000Z", false),
    ).not.toThrow();
    expect(() =>
      assertWorkforceSessionCurrent(f.session, proof, "2026-10-06T12:15:00.000Z"),
    ).toThrow();
    expect(() =>
      assertWorkforceSessionCurrent(f.session, proof, "2026-10-06T12:09:59.999Z", false),
    ).toThrow();
  });
  it.each([
    { sessionReference: id(9) },
    { actorReference: id(9) },
    { authenticatedAt: "2026-10-06T12:00:00.001Z" },
    { validUntil: "2026-10-06T12:16:00.000Z" },
    { verifiedAt: "2026-10-06T12:00:00.001Z" },
    { verifiedAt: "2026-10-06T12:00:00.000001Z" },
    { method: "TotpEnrolled" },
    { clientTimestamp: at },
  ])("rejects cross-binding, extended or malformed proof %j", (patch) => {
    const f = fixture();
    expect(() =>
      parseWorkforceSessionSecrets(
        { ...f.payload, mfa: { ...f.mfa, ...patch } },
        f.configuration,
        f.session,
      ),
    ).toThrow();
  });
  it.each([
    { profile: "PlatformBrowserSessionV1" },
    { issuer: "https://other.invalid/" },
    { clientId: "other" },
    { tokenBundle: "" },
    { tokenBundle: "x".repeat(8193) },
    { csrf: "short" },
    { permissions: ["organization.manage"] },
  ])("rejects another profile/scope or arbitrary plaintext authority %j", (patch) => {
    const f = fixture();
    expect(() =>
      parseWorkforceSessionSecrets({ ...f.payload, ...patch }, f.configuration, f.session),
    ).toThrow();
  });
  it.each(["Platform", "Customer"] as const)(
    "cannot relabel a real %s Actor or Session",
    (accountKind) => {
      const f = fixture(),
        actor = createIdentityActor({ ...f.actor, accountKind });
      expect(() => parseWorkforceActor(actor)).toThrow();
      const session = createAuthenticationSession({
        sessionReference: f.session.sessionReference,
        actor,
        status: "Active",
        policyCode: "Privileged",
        maxActiveSessions: 2,
        idleTimeoutMinutes: 15,
        absoluteTimeoutMinutes: 480,
        version: 1,
        authenticatedAt: at,
        createdAt: at,
        lastSeenAt: f.session.lastSeenAt,
        idleExpiresAt: f.session.idleExpiresAt,
        absoluteExpiresAt: f.session.absoluteExpiresAt,
        rotatedFromSessionReference: null,
        revocationReason: null,
        revokedAt: null,
      });
      expect(() => parseWorkforceSessionSecrets(f.payload, f.configuration, session)).toThrow();
    },
  );
  it("rejects accessors without executing them and denies missing/extra fields", () => {
    const f = fixture();
    let calls = 0;
    const proof = { ...f.mfa };
    Object.defineProperty(proof, "verifiedAt", {
      enumerable: true,
      get() {
        calls++;
        return at;
      },
    });
    expect(() => parseWorkforceSessionMfa(proof)).toThrow();
    const payload = { ...f.payload };
    Object.defineProperty(payload, "csrf", {
      enumerable: true,
      get() {
        calls++;
        return "x".repeat(43);
      },
    });
    expect(() => parseWorkforceSessionSecrets(payload, f.configuration, f.session)).toThrow();
    expect(calls).toBe(0);
    const { evidenceReference, ...missing } = f.mfa;
    void evidenceReference;
    expect(() => parseWorkforceSessionMfa(missing)).toThrow();
  });
});
