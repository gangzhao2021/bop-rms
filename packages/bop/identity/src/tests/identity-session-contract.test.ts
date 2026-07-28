import { describe, expect, it } from "vitest";
import {
  assertSessionUsable,
  createAuthenticationSession,
  createCredentialCompromisedEvent,
  createIdentityActor,
  createSessionRevokedEvent,
  IdentityContractError,
  parseCanonicalInstant,
  parseCorrelationReference,
  parseIdempotencyReference,
  parsePurposeCode,
  sessionPolicies,
  type IdentitySessionPort,
  type RevokeAuthenticationSessionCommand,
  type SessionRevocationResult,
} from "../index.js";

const actorReference = "01890f3e-8f7a-7cc1-a123-426614174000";
const sessionReference = "01890f3e-8f7a-7cc2-b123-426614174001";
const formerSessionReference = "01890f3e-8f7a-7cc3-8123-426614174002";
const correlationId = "01890f3e-8f7a-7cc4-9123-426614174003";
const idempotencyKey = "01890f3e-8f7a-7cc5-a123-426614174004";
const authenticatedAt = "2026-07-28T12:00:00.000Z";
const createdAt = "2026-07-28T12:00:00.000Z";
const lastSeenAt = "2026-07-28T12:10:00.000Z";

const userActor = (overrides: Record<string, unknown> = {}) => ({
  actorType: "User",
  actorReference,
  accountKind: "Workforce",
  status: "Active",
  authenticationMethod: "Oidc",
  verificationLevel: "SingleFactor",
  authenticatedAt,
  recentMfaAt: null,
  ...overrides,
});

const sessionInput = (overrides: Record<string, unknown> = {}) => ({
  sessionReference,
  actor: userActor(),
  status: "Active",
  policyCode: "WorkforceStandard",
  maxActiveSessions: 5,
  idleTimeoutMinutes: 30,
  absoluteTimeoutMinutes: 720,
  version: 1,
  authenticatedAt,
  createdAt,
  lastSeenAt,
  idleExpiresAt: "2026-07-28T12:40:00.000Z",
  absoluteExpiresAt: "2026-07-29T00:00:00.000Z",
  rotatedFromSessionReference: null,
  revocationReason: null,
  revokedAt: null,
  ...overrides,
});

const expectCode = (action: () => unknown, code: string) => {
  try {
    action();
    throw new Error("expected contract rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(IdentityContractError);
    expect(error).toMatchObject({ code });
    expect(String((error as Error).message)).not.toContain(actorReference);
    expect(String((error as Error).message)).not.toContain(sessionReference);
  }
};

describe("Identity Actor contract", () => {
  it("constructs a frozen named User Actor without Tenant or permission facts", () => {
    const actor = createIdentityActor(userActor());
    expect(actor).toMatchObject({
      actorType: "User",
      actorReference,
      accountKind: "Workforce",
      status: "Active",
    });
    expect(Object.isFrozen(actor)).toBe(true);
    expect(actor).not.toHaveProperty("brandId");
    expect(actor).not.toHaveProperty("storeId");
    expect(actor).not.toHaveProperty("roles");
    expect(actor).not.toHaveProperty("permissions");
  });

  it("accepts Customer and Platform as identity separation, not roles", () => {
    expect(createIdentityActor(userActor({ accountKind: "Customer" })).accountKind).toBe(
      "Customer",
    );
    expect(createIdentityActor(userActor({ accountKind: "Platform" })).accountKind).toBe(
      "Platform",
    );
  });

  it("constructs a Service Actor only with ServiceCredential", () => {
    expect(
      createIdentityActor(
        userActor({
          actorType: "Service",
          accountKind: "Service",
          authenticationMethod: "ServiceCredential",
        }),
      ),
    ).toMatchObject({ actorType: "Service", accountKind: "Service" });
  });

  it("constructs a System Actor only without a reference", () => {
    expect(
      createIdentityActor(
        userActor({
          actorType: "System",
          actorReference: null,
          accountKind: "System",
          authenticationMethod: "System",
        }),
      ),
    ).toMatchObject({ actorType: "System", actorReference: null });
  });

  it.each(["Suspended", "Disabled", "Merged"])("rejects inactive status %s", (status) => {
    expectCode(() => createIdentityActor(userActor({ status })), "ACTOR_INACTIVE");
  });

  it("rejects uppercase and non-v7 Actor references", () => {
    expectCode(
      () => createIdentityActor(userActor({ actorReference: actorReference.toUpperCase() })),
      "ACTOR_REFERENCE_INVALID",
    );
    expectCode(
      () =>
        createIdentityActor(userActor({ actorReference: "01890f3e-8f7a-4cc1-a123-426614174000" })),
      "ACTOR_REFERENCE_INVALID",
    );
  });

  it.each([
    { actorType: "User", actorReference: null },
    { actorType: "Service", accountKind: "Workforce" },
    { actorType: "System", actorReference },
    { actorType: "User", accountKind: "Service" },
  ])("rejects invalid Actor/account shape %#", (override) => {
    expectCode(() => createIdentityActor(userActor(override)), "ACTOR_SHAPE_INVALID");
  });

  it("rejects authentication methods that do not match the Actor type", () => {
    expectCode(
      () => createIdentityActor(userActor({ authenticationMethod: "ServiceCredential" })),
      "AUTHENTICATION_METHOD_INVALID",
    );
  });

  it("accepts a server-produced RecentMfa fact at or before authentication", () => {
    const actor = createIdentityActor(
      userActor({ verificationLevel: "RecentMfa", recentMfaAt: authenticatedAt }),
    );
    expect(actor.recentMfaAt).toBe(authenticatedAt);
  });

  it("rejects absent or future RecentMfa evidence", () => {
    expectCode(
      () => createIdentityActor(userActor({ verificationLevel: "RecentMfa" })),
      "VERIFICATION_LEVEL_INVALID",
    );
    expectCode(
      () =>
        createIdentityActor(
          userActor({
            verificationLevel: "RecentMfa",
            recentMfaAt: "2026-07-28T12:00:00.001Z",
          }),
        ),
      "VERIFICATION_LEVEL_INVALID",
    );
  });

  it("rejects MFA claims for Service and System Actors", () => {
    expectCode(
      () =>
        createIdentityActor(
          userActor({
            actorType: "Service",
            accountKind: "Service",
            authenticationMethod: "ServiceCredential",
            verificationLevel: "Mfa",
          }),
        ),
      "VERIFICATION_LEVEL_INVALID",
    );
  });

  it("rejects noncanonical instants", () => {
    for (const value of ["2026-07-28T12:00:00Z", "2026-07-28T12:00:00.000+00:00", "not-a-time"]) {
      expectCode(
        () => createIdentityActor(userActor({ authenticatedAt: value })),
        "TIMESTAMP_INVALID",
      );
    }
  });

  it("rejects unknown, symbol, prototype and accessor input without reading secrets", () => {
    expectCode(
      () => createIdentityActor({ ...userActor(), email: "synthetic@example.invalid" }),
      "ACTOR_SHAPE_INVALID",
    );
    const symbolInput = userActor() as Record<PropertyKey, unknown>;
    symbolInput[Symbol("secret")] = "synthetic-token";
    expectCode(() => createIdentityActor(symbolInput), "ACTOR_SHAPE_INVALID");

    expectCode(
      () => createIdentityActor(Object.assign(Object.create({ role: "Owner" }), userActor())),
      "ACTOR_SHAPE_INVALID",
    );
    const accessorInput = userActor();
    Object.defineProperty(accessorInput, "actorReference", {
      enumerable: true,
      get: () => {
        throw new Error("synthetic-secret");
      },
    });
    expectCode(() => createIdentityActor(accessorInput), "ACTOR_SHAPE_INVALID");
  });
});

describe("Authentication Session contract", () => {
  it("constructs a frozen active Session with the exact standard policy", () => {
    const session = createAuthenticationSession(sessionInput());
    expect(session.policy).toEqual(sessionPolicies.WorkforceStandard);
    expect(session.version).toBe(1);
    expect(Object.isFrozen(session)).toBe(true);
    expect(session).not.toHaveProperty("cookie");
    expect(session).not.toHaveProperty("token");
    expect(session).not.toHaveProperty("providerSubject");
  });

  it.each([
    ["WorkforceStandard", 5, 30, 720, "2026-07-28T12:40:00.000Z", "2026-07-29T00:00:00.000Z"],
    ["Privileged", 2, 15, 480, "2026-07-28T12:25:00.000Z", "2026-07-28T20:00:00.000Z"],
    ["NamedKdsOperator", 5, 60, 720, "2026-07-28T13:10:00.000Z", "2026-07-29T00:00:00.000Z"],
  ])(
    "accepts exact %s policy without a role grant",
    (policyCode, max, idle, absolute, idleExpiresAt, absoluteExpiresAt) => {
      const session = createAuthenticationSession(
        sessionInput({
          policyCode,
          maxActiveSessions: max,
          idleTimeoutMinutes: idle,
          absoluteTimeoutMinutes: absolute,
          idleExpiresAt,
          absoluteExpiresAt,
        }),
      );
      expect(session.policy.code).toBe(policyCode);
      expect(session).not.toHaveProperty("role");
    },
  );

  it("rejects invented and altered policies", () => {
    expectCode(
      () => createAuthenticationSession(sessionInput({ policyCode: "Unlimited" })),
      "SESSION_POLICY_INVALID",
    );
    expectCode(
      () => createAuthenticationSession(sessionInput({ maxActiveSessions: 6 })),
      "SESSION_POLICY_INVALID",
    );
    expectCode(
      () => createAuthenticationSession(sessionInput({ absoluteTimeoutMinutes: 721 })),
      "SESSION_POLICY_INVALID",
    );
  });

  it("rejects nonpositive, fractional and unsafe versions", () => {
    for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectCode(
        () => createAuthenticationSession(sessionInput({ version })),
        "SESSION_SHAPE_INVALID",
      );
    }
  });

  it("requires Actor and Session authentication instants to match", () => {
    expectCode(
      () =>
        createAuthenticationSession(sessionInput({ authenticatedAt: "2026-07-28T11:59:59.999Z" })),
      "SESSION_SHAPE_INVALID",
    );
  });

  it("rejects invalid time order and non-exact expiry derivation", () => {
    expectCode(
      () => createAuthenticationSession(sessionInput({ lastSeenAt: "2026-07-28T11:59:59.999Z" })),
      "SESSION_SHAPE_INVALID",
    );
    expectCode(
      () =>
        createAuthenticationSession(sessionInput({ idleExpiresAt: "2026-07-28T12:40:00.001Z" })),
      "SESSION_SHAPE_INVALID",
    );
    expectCode(
      () =>
        createAuthenticationSession(
          sessionInput({ absoluteExpiresAt: "2026-07-29T00:00:00.001Z" }),
        ),
      "SESSION_SHAPE_INVALID",
    );
  });

  it("accepts rotation from a distinct former Session reference", () => {
    expect(
      createAuthenticationSession(
        sessionInput({ rotatedFromSessionReference: formerSessionReference }),
      ).rotatedFromSessionReference,
    ).toBe(formerSessionReference);
  });

  it("rejects self-rotation and invalid former references", () => {
    expectCode(
      () =>
        createAuthenticationSession(
          sessionInput({ rotatedFromSessionReference: sessionReference }),
        ),
      "SESSION_ROTATED",
    );
    expectCode(
      () => createAuthenticationSession(sessionInput({ rotatedFromSessionReference: "raw" })),
      "SESSION_REFERENCE_INVALID",
    );
  });

  it("constructs Revoked only with a closed reason and instant", () => {
    const session = createAuthenticationSession(
      sessionInput({
        status: "Revoked",
        revocationReason: "Logout",
        revokedAt: "2026-07-28T12:20:00.000Z",
      }),
    );
    expect(session).toMatchObject({ status: "Revoked", revocationReason: "Logout" });
  });

  it("rejects inconsistent revocation shapes and pre-creation revocation", () => {
    expectCode(
      () => createAuthenticationSession(sessionInput({ status: "Revoked" })),
      "REVOCATION_INVALID",
    );
    expectCode(
      () =>
        createAuthenticationSession(
          sessionInput({
            revocationReason: "Logout",
            revokedAt: "2026-07-28T12:20:00.000Z",
          }),
        ),
      "REVOCATION_INVALID",
    );
    expectCode(
      () =>
        createAuthenticationSession(
          sessionInput({
            status: "Revoked",
            revocationReason: "Logout",
            revokedAt: "2026-07-28T11:59:59.999Z",
          }),
        ),
      "REVOCATION_INVALID",
    );
  });

  it("resolves an active Session immediately before expiry", () => {
    const session = createAuthenticationSession(sessionInput());
    expect(assertSessionUsable(session, "2026-07-28T12:39:59.999Z")).toBe(session);
  });

  it("fails closed at idle expiry and after absolute expiry", () => {
    const session = createAuthenticationSession(sessionInput());
    expectCode(() => assertSessionUsable(session, "2026-07-28T12:40:00.000Z"), "SESSION_EXPIRED");
    expectCode(() => assertSessionUsable(session, "2026-07-29T00:00:00.000Z"), "SESSION_EXPIRED");
  });

  it("fails closed before the Session exists", () => {
    const session = createAuthenticationSession(sessionInput());
    expectCode(() => assertSessionUsable(session, "2026-07-28T11:59:59.999Z"), "SESSION_EXPIRED");
  });

  it("fails closed for explicit Revoked and Expired states", () => {
    const revoked = createAuthenticationSession(
      sessionInput({
        status: "Revoked",
        revocationReason: "CredentialCompromised",
        revokedAt: "2026-07-28T12:20:00.000Z",
      }),
    );
    expectCode(() => assertSessionUsable(revoked, "2026-07-28T12:20:00.001Z"), "SESSION_REVOKED");
    const expired = createAuthenticationSession(sessionInput({ status: "Expired" }));
    expectCode(() => assertSessionUsable(expired, "2026-07-28T12:20:00.001Z"), "SESSION_EXPIRED");
  });

  it("rejects unknown and prototype-polluted Session fields", () => {
    expectCode(
      () => createAuthenticationSession({ ...sessionInput(), role: "Owner" }),
      "SESSION_SHAPE_INVALID",
    );
    expectCode(
      () =>
        createAuthenticationSession(
          Object.assign(Object.create({ permissions: ["all"] }), sessionInput()),
        ),
      "SESSION_SHAPE_INVALID",
    );
  });
});

describe("Identity events and revocation port", () => {
  it("constructs the minimal SessionRevoked event", () => {
    const event = createSessionRevokedEvent({
      eventType: "identity.session-revoked.v1",
      sessionReference,
      actorReference,
      reason: "Logout",
      occurredAt: "2026-07-28T12:20:00.000Z",
      correlationId,
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(event).not.toHaveProperty("email");
    expect(event).not.toHaveProperty("token");
  });

  it("rejects unknown event fields, raw credentials and open reasons", () => {
    expectCode(
      () =>
        createSessionRevokedEvent({
          eventType: "identity.session-revoked.v1",
          sessionReference,
          actorReference,
          reason: "Logout",
          occurredAt: "2026-07-28T12:20:00.000Z",
          correlationId,
          token: "synthetic-token",
        }),
      "EVENT_INVALID",
    );
    expectCode(
      () =>
        createSessionRevokedEvent({
          eventType: "identity.session-revoked.v1",
          sessionReference,
          actorReference,
          reason: "free text",
          occurredAt: "2026-07-28T12:20:00.000Z",
          correlationId,
        }),
      "REVOCATION_INVALID",
    );
  });

  it("constructs only a keyed-hash credential reference event", () => {
    const event = createCredentialCompromisedEvent({
      eventType: "identity.credential-compromised.v1",
      actorReference,
      credentialReferenceHmacSha256: "a".repeat(64),
      occurredAt: "2026-07-28T12:20:00.000Z",
      correlationId,
    });
    expect(event.credentialReferenceHmacSha256).toHaveLength(64);
    expect(event).not.toHaveProperty("credential");
    expect(event).not.toHaveProperty("providerPayload");
  });

  it("rejects malformed, uppercase and raw credential references", () => {
    for (const credentialReferenceHmacSha256 of [
      "short",
      "A".repeat(64),
      "synthetic-password-value",
    ]) {
      expectCode(
        () =>
          createCredentialCompromisedEvent({
            eventType: "identity.credential-compromised.v1",
            actorReference,
            credentialReferenceHmacSha256,
            occurredAt: "2026-07-28T12:20:00.000Z",
            correlationId,
          }),
        "EVENT_INVALID",
      );
    }
  });

  it("models idempotent revocation without restoring an old Session", async () => {
    const active = createAuthenticationSession(sessionInput());
    const revoked = createAuthenticationSession(
      sessionInput({
        status: "Revoked",
        version: 2,
        revocationReason: "Logout",
        revokedAt: "2026-07-28T12:20:00.000Z",
      }),
    );
    const event = createSessionRevokedEvent({
      eventType: "identity.session-revoked.v1",
      sessionReference,
      actorReference,
      reason: "Logout",
      occurredAt: "2026-07-28T12:20:00.000Z",
      correlationId,
    });
    const seen = new Map<string, SessionRevocationResult>();
    const port = {
      async issueSession() {
        return active;
      },
      async resolveSession() {
        return active;
      },
      async revokeSession(command: RevokeAuthenticationSessionCommand) {
        const prior = seen.get(command.idempotencyKey);
        if (prior) return { ...prior, idempotentReplay: true };
        const result = { session: revoked, event, idempotentReplay: false };
        seen.set(command.idempotencyKey, result);
        return result;
      },
      async rotateSession() {
        return active;
      },
    } satisfies IdentitySessionPort;
    if (active.actor.actorReference === null) {
      throw new Error("synthetic User Actor reference is required");
    }
    const command = {
      sessionReference: active.sessionReference,
      expectedVersion: active.version,
      reason: "Logout",
      actorReference: active.actor.actorReference,
      purposeCode: parsePurposeCode("SESSION_ADMINISTRATION"),
      correlationId: parseCorrelationReference(correlationId),
      idempotencyKey: parseIdempotencyReference(idempotencyKey),
      occurredAt: parseCanonicalInstant("2026-07-28T12:20:00.000Z"),
    } as const;

    expect(await port.revokeSession(command)).toMatchObject({ idempotentReplay: false });
    expect(await port.revokeSession(command)).toMatchObject({
      idempotentReplay: true,
      session: { status: "Revoked", version: 2 },
    });
  });

  it("keeps the port free of Tenant, Store, role and permission arguments", () => {
    const keys = Object.keys({
      sessionReference,
      expectedVersion: 1,
      reason: "Administrative",
      actorReference,
      purposeCode: "SESSION_ADMINISTRATION",
      correlationId,
      idempotencyKey,
      occurredAt: "2026-07-28T12:20:00.000Z",
    }).sort();
    expect(keys).not.toContain("brandId");
    expect(keys).not.toContain("storeId");
    expect(keys).not.toContain("role");
    expect(keys).not.toContain("permission");
  });
});
