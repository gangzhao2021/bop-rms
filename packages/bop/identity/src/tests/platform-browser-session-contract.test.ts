import { expect, it } from "vitest";
import { createAuthenticationSession, createIdentityActor, sessionPolicies } from "../index.js";
import {
  assertPlatformSessionCurrent,
  parsePlatformSessionMfa,
  parsePlatformSessionSecrets,
} from "../contracts/platform-browser-session.js";
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-09-10T10:00:00.000Z";
const mfa = {
  sessionReference: id(1),
  actorReference: id(2),
  method: "Totp",
  evidenceReference: id(3),
  authorizationTransactionReference: id(4),
  authenticatedAt: at,
  verifiedAt: at,
  validUntil: "2026-09-10T10:15:00.000Z",
};
const actor = createIdentityActor({
  actorType: "User",
  actorReference: id(2),
  accountKind: "Platform",
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
  lastSeenAt: "2026-09-10T10:10:00.000Z",
  idleExpiresAt: "2026-09-10T10:25:00.000Z",
  absoluteExpiresAt: "2026-09-10T18:00:00.000Z",
  rotatedFromSessionReference: null,
  revokedAt: null,
  revocationReason: null,
});
const configuration = { issuer: "https://identity.invalid/", clientId: "synthetic-platform" };
const payload = {
  profile: "PlatformBrowserSessionV1",
  ...configuration,
  tokenBundle: "synthetic-token",
  csrf: "x".repeat(43),
  mfa,
};
it("keeps expired MFA readable while refusing action authority at the exact deadline", () => {
  const proof = parsePlatformSessionSecrets(payload, configuration, session).mfa;
  expect(() =>
    assertPlatformSessionCurrent(session, proof, "2026-09-10T10:15:00.000Z", false),
  ).not.toThrow();
  expect(() => assertPlatformSessionCurrent(session, proof, "2026-09-10T10:15:00.000Z")).toThrow();
});
it.each([
  { sessionReference: id(9) },
  { actorReference: id(9) },
  { authenticatedAt: "2026-09-10T10:00:00.001Z" },
  { validUntil: "2026-09-10T10:16:00.000Z" },
  { verifiedAt: "2026-09-10T10:00:00.001Z" },
  { verifiedAt: "2026-09-10T10:00:00.000001Z" },
  { method: "TotpEnrolled" },
  { clientTimestamp: at },
])("rejects foreign, extended or malformed proof %j", (patch) => {
  expect(() =>
    parsePlatformSessionSecrets({ ...payload, mfa: { ...mfa, ...patch } }, configuration, session),
  ).toThrow();
});
it("rejects getters without invoking them and refuses extra plaintext authority", () => {
  let accessed = false;
  const proof = { ...mfa };
  Object.defineProperty(proof, "verifiedAt", {
    get() {
      accessed = true;
      return at;
    },
    enumerable: true,
  });
  expect(() => parsePlatformSessionMfa(proof)).toThrow();
  expect(accessed).toBe(false);
  expect(() =>
    parsePlatformSessionSecrets(
      { ...payload, permission: "platform.operate" },
      configuration,
      session,
    ),
  ).toThrow();
});
