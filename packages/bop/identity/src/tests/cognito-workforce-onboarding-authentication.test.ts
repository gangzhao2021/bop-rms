import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { AdminGetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import {
  BrowserSessionError,
  parseAuthorizationTransactionReference,
  parseSelectorHash,
  type EncryptedSecretEnvelope,
} from "../contracts/browser-session.js";
import { createWorkforceInvitation } from "../contracts/workforce-identity-security.js";
import {
  buildWorkforceOnboardingOperation,
  parseWorkforceOnboardingOriginal,
  workforceOnboardingIntent,
  workforceOnboardingSubjectContext,
} from "../contracts/workforce-onboarding-operation.js";
import { createCognitoWorkforceInvitation } from "../infrastructure/cognito-workforce-invitation.js";
import { createCognitoWorkforceOnboardingAuthentication } from "../infrastructure/cognito-workforce-onboarding-authentication.js";

const sdk = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-cognito-identity-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-cognito-identity-provider")>();
  return {
    ...actual,
    CognitoIdentityProviderClient: class {
      send = sdk.send;
    },
  };
});
// Real installed OIDC/JWT verifiers consume locally RSA-signed tokens and JWKS.
// Only HTTP and actual AWS SDK send boundaries are synthetic, never verdict ports.
const idKey = generateKeyPairSync("rsa", { modulusLength: 2048 }),
  accessKey = generateKeyPairSync("rsa", { modulusLength: 2048 }),
  stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
const id = (n: number) => `0190ed60-0340-7000-8000-${String(n).padStart(12, "0")}`;
const subject = "11111111-2222-4333-8444-555555555555",
  corporateEmail = "synthetic-owner@example.test";
const configuration = {
  environment: "controlled",
  issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Synthetic",
  clientId: "syntheticonboardingclient",
  clientSecret: "synthetic-confidential-secret",
  managedLoginOrigin: "https://synthetic.auth.ca-central-1.amazoncognito.com",
  redirectUri: "https://app.example.test/merchant/organization/brands/callback",
  logoutReturnUri: "https://app.example.test/app/organization/brands",
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = (claims: Record<string, unknown>, use: "id" | "access", bad = false) => {
  const body = `${encode({ alg: "RS256", kid: use + "-key" })}.${encode(claims)}`;
  return (
    body +
    "." +
    sign(
      "RSA-SHA256",
      Buffer.from(body),
      bad ? stranger.privateKey : use === "id" ? idKey.privateKey : accessKey.privateKey,
    ).toString("base64url")
  );
};
const status = (enabled = true) => ({
  Enabled: enabled,
  UserStatus: "CONFIRMED",
  UserAttributes: [
    { Name: "sub", Value: subject },
    { Name: "email", Value: "discard@example.test" },
  ],
});
function fixture() {
  const start = new Date().toISOString(),
    second = Math.floor(Date.parse(start) / 1000),
    key = randomBytes(32);
  let now = start;
  const clock = { now: () => now },
    config = { ...configuration },
    scope = { environment: config.environment, issuer: config.issuer, clientId: config.clientId };
  const hasher = {
    hash: (value: string) =>
      parseSelectorHash(createHmac("sha256", key).update(value).digest("hex")),
    equals: (left: string, right: string) => left === right,
  };
  const encrypt = (text: string, encryptionContext: string) => {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(encryptionContext));
    return {
      algorithm: "SYNTHETIC_AES_256_GCM" as const,
      keyReference: "controlled-key",
      ciphertext: Buffer.concat([
        iv,
        cipher.update(text),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString("base64url"),
      encryptionContext,
    };
  };
  const envelopes = {
    async encrypt(text: string, context: string) {
      return encrypt(text, context);
    },
    async decrypt(envelope: EncryptedSecretEnvelope, context: string) {
      const raw = Buffer.from(envelope.ciphertext, "base64url"),
        decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(raw.subarray(-16));
      return Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()]).toString();
    },
  };
  const email = createCognitoWorkforceInvitation({ configuration: scope, clock, hasher });
  const original = parseWorkforceOnboardingOriginal({
    profile: "WorkforceOnboardingOriginalV1",
    configuration: scope,
    operationReference: id(1),
    operatorReference: id(2),
    actorReference: id(3),
    brandReference: id(4),
    membershipReference: id(5),
    storeAssignmentReferences: [],
    emailDigest: email.digestCorporateEmail(corporateEmail),
    approvedByReference: id(6),
    approvalEvidenceReference: id(7),
    relationshipEvidenceReference: id(8),
    approvedPlanDigest: `sha256:${"b".repeat(64)}`,
    reasonCode: "APPROVED_ONBOARDING",
  });
  const createdAt = new Date(Date.parse(start) - 2000).toISOString(),
    expiresAt = new Date(Date.parse(createdAt) + 86400000).toISOString(),
    codec = { canonicalize: canonicalizeRfc8785, hash: sha256Hex };
  const subjectHash = hasher.hash(
    Buffer.from(
      sha256Hex(
        canonicalizeRfc8785({
          domain: "WORKFORCE_ONBOARDING_SUBJECT_V1",
          configuration: scope,
          subject,
        }),
      ),
      "hex",
    ).toString("base64url"),
  );
  const record = buildWorkforceOnboardingOperation(
    {
      profile: "WorkforceOnboardingOperationV1",
      original,
      intentDigest: workforceOnboardingIntent(original, codec),
      version: 3,
      state: "ProviderObserved",
      invitationReference: id(9),
      selectorHash: parseSelectorHash("c".repeat(64)),
      createdAt,
      expiresAt,
      dispatchStartedAt: createdAt,
      provider: {
        subjectHash,
        encryptedSubject: encrypt(subject, workforceOnboardingSubjectContext(original)),
        username: `bop_${original.actorReference}`,
        createdAt,
        status: "FORCE_CHANGE_PASSWORD",
        enabled: true,
      },
      phaseOperationReference: id(10),
      phaseRequestDigest: `sha256:${"d".repeat(64)}`,
      previousSourceDigest: `sha256:${"e".repeat(64)}`,
      auditReference: id(11),
      occurredAt: createdAt,
    },
    codec,
  );
  const invitation = {
    profile: "WorkforceOnboardingInvitationEvidenceV1" as const,
    binding: {
      configuration: scope,
      invitationReference: record.invitationReference,
      originalIntentDigest: record.intentDigest,
      selectorHash: record.selectorHash,
    },
    record,
    invitation: createWorkforceInvitation({
      invitationReference: record.invitationReference,
      actorReference: original.actorReference,
      inviterActorReference: original.operatorReference,
      membershipReference: original.membershipReference,
      storeAssignmentReferences: [],
      emailDigest: original.emailDigest,
      selectorHash: record.selectorHash,
      status: "Pending",
      createdAt,
      expiresAt,
      consumedAt: null,
      providerEvidenceReference: null,
      version: 1,
    }),
    observedAt: start,
    validUntil: new Date(Date.parse(start) + 5000).toISOString(),
  };
  const request = {
    issuer: config.issuer,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    code: "synthetic-code",
    nonce: "n".repeat(43),
    codeVerifier: "v".repeat(43),
    prompt: "login" as const,
    requireTotp: true as const,
    transactionReference: parseAuthorizationTransactionReference(id(12)),
  };
  const changes: {
    id: Record<string, unknown>;
    access: Record<string, unknown>;
    badSignature: boolean;
  } = { id: {}, access: {}, badSignature: false };
  const common = {
    iss: config.issuer,
    sub: subject,
    auth_time: second,
    iat: second,
    exp: second + 3600,
    acr: "urn:cognito:loa:4",
    amr: ["pwd", "otp", "mfa"],
  };
  const http = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    if (url === config.issuer + "/.well-known/jwks.json")
      return Response.json({
        keys: [
          { ...idKey.publicKey.export({ format: "jwk" }), kid: "id-key", use: "sig", alg: "RS256" },
          {
            ...accessKey.publicKey.export({ format: "jwk" }),
            kid: "access-key",
            use: "sig",
            alg: "RS256",
          },
        ],
      });
    if (url === config.managedLoginOrigin + "/oauth2/token")
      return Response.json({
        id_token: token(
          {
            ...common,
            token_use: "id",
            aud: config.clientId,
            nonce: request.nonce,
            email_verified: true,
            email: corporateEmail,
            ...changes.id,
          },
          "id",
          changes.badSignature,
        ),
        access_token: token(
          {
            ...common,
            token_use: "access",
            client_id: config.clientId,
            scope: "openid",
            ...changes.access,
          },
          "access",
        ),
        refresh_token: "synthetic-transient-refresh",
        token_type: "Bearer",
        scope: "openid",
        expires_in: 3600,
      });
    throw new Error("UNEXPECTED_SYNTHETIC_ENDPOINT");
  });
  const nextEvidenceReference = vi.fn(() => id(13)),
    options = { configuration: config, envelopes, hasher, clock, nextEvidenceReference, http },
    source = createCognitoWorkforceOnboardingAuthentication(options);
  return {
    source,
    options,
    request,
    invitation,
    changes,
    nextEvidenceReference,
    http,
    move(value: string) {
      now = value;
    },
    exchange: () => source.exchangeCode({ request, invitation }),
  };
}
beforeEach(() => {
  sdk.send.mockReset();
  sdk.send.mockResolvedValue(status());
});
describe("actual invitation-specific Cognito authentication", () => {
  it("constructs without observing time, allocating evidence or calling Provider transport", () => {
    const f = fixture(),
      now = vi.fn(() => {
        throw new Error("CLOCK_MUST_BE_LAZY");
      });
    expect(() =>
      createCognitoWorkforceOnboardingAuthentication({
        ...f.options,
        clock: { now },
      }),
    ).not.toThrow();
    expect(now).not.toHaveBeenCalled();
    expect(f.nextEvidenceReference).not.toHaveBeenCalled();
    expect(f.http).not.toHaveBeenCalled();
    expect(sdk.send).not.toHaveBeenCalled();
  });
  it("verifies actual dual RSA tokens, original email/subject, SDK status and exact transaction TOTP without a binding resolver", async () => {
    const f = fixture(),
      proof = await f.exchange();
    expect(proof.actor.actorReference).toBe(f.invitation.record.original.actorReference);
    expect(proof.actor.accountKind).toBe("Workforce");
    expect(proof.actor.verificationLevel).toBe("RecentMfa");
    expect(proof.totp.authorizationTransactionReference).toBe(f.request.transactionReference);
    expect(proof.totp.nonce).toBe(f.request.nonce);
    expect(proof.totp.timestampPrecision).toBe("Second");
    expect(proof.subject).toBe(subject);
    expect(proof.validUntil).toBe(f.invitation.validUntil);
    expect(JSON.stringify(proof)).not.toContain(corporateEmail);
    expect(sdk.send.mock.calls[0]?.[0]).toBeInstanceOf(AdminGetUserCommand);
    await proof.assertCurrent();
    proof.assertFinalized();
    expect(sdk.send).toHaveBeenCalledTimes(2);
  });
  it.each(["signature", "nonce", "totp", "email", "emailVerified", "subject", "accessSubject"])(
    "rejects real signed-protocol %s failures before allocation",
    async (mode) => {
      const f = fixture();
      if (mode === "signature") f.changes.badSignature = true;
      else if (mode === "nonce") f.changes.id.nonce = "x".repeat(43);
      else if (mode === "totp") f.changes.access.amr = ["pwd"];
      else if (mode === "email") f.changes.id.email = "other@example.test";
      else if (mode === "emailVerified") f.changes.id.email_verified = false;
      else if (mode === "accessSubject") f.changes.access.sub = "another-subject";
      else {
        f.changes.id.sub = "another-subject";
        f.changes.access.sub = "another-subject";
      }
      await expect(f.exchange()).rejects.toBeInstanceOf(BrowserSessionError);
      expect(f.nextEvidenceReference).not.toHaveBeenCalled();
      expect(sdk.send).not.toHaveBeenCalled();
    },
  );
  it.each(["disabled", "unknown", "mismatch"])("refuses actual current-status %s", async (mode) => {
    const f = fixture();
    if (mode === "disabled") sdk.send.mockResolvedValue(status(false));
    else if (mode === "unknown")
      sdk.send.mockRejectedValue(new Error("SYNTHETIC_NETWORK_UNAVAILABLE"));
    else
      sdk.send.mockResolvedValue({
        ...status(),
        UserAttributes: [{ Name: "sub", Value: "wrong-subject" }],
      });
    await expect(f.exchange()).rejects.toBeInstanceOf(BrowserSessionError);
    expect(f.nextEvidenceReference).not.toHaveBeenCalled();
  });
  it("refuses config/intent scope substitutions and already-Accepted invitation input", async () => {
    const f = fixture();
    await expect(
      f.source.exchangeCode({
        request: { ...f.request, clientId: "otherclient" },
        invitation: f.invitation,
      }),
    ).rejects.toThrow();
    await expect(
      f.source.exchangeCode({
        request: f.request,
        invitation: {
          ...f.invitation,
          binding: { ...f.invitation.binding, originalIntentDigest: `sha256:${"0".repeat(64)}` },
        },
      }),
    ).rejects.toThrow();
    await expect(
      f.source.exchangeCode({
        request: f.request,
        invitation: {
          ...f.invitation,
          invitation: createWorkforceInvitation({
            ...f.invitation.invitation,
            status: "Accepted",
            version: 2,
            consumedAt: f.invitation.observedAt,
            providerEvidenceReference: id(90),
          }),
        },
      }),
    ).rejects.toThrow();
    expect(f.nextEvidenceReference).not.toHaveBeenCalled();
  });
  it("rejects tampered encrypted subject or keyed subject digest", async () => {
    const f = fixture(),
      { sourceDigest, ...body } = f.invitation.record;
    expect(sourceDigest).toMatch(/^sha256:/u);
    const provider = f.invitation.record.provider;
    if (provider === null) throw new Error("CONTROLLED_PROVIDER_REQUIRED");
    const bad = buildWorkforceOnboardingOperation(
      { ...body, provider: { ...provider, subjectHash: parseSelectorHash("0".repeat(64)) } },
      { canonicalize: canonicalizeRfc8785, hash: sha256Hex },
    );
    await expect(
      f.source.exchangeCode({ request: f.request, invitation: { ...f.invitation, record: bad } }),
    ).rejects.toThrow();
    const corrupted = buildWorkforceOnboardingOperation(
      {
        ...body,
        provider: {
          ...provider,
          encryptedSubject: {
            ...provider.encryptedSubject,
            ciphertext: Buffer.alloc(40).toString("base64url"),
          },
        },
      },
      { canonicalize: canonicalizeRfc8785, hash: sha256Hex },
    );
    await expect(
      f.source.exchangeCode({
        request: f.request,
        invitation: { ...f.invitation, record: corrupted },
      }),
    ).rejects.toThrow();
    expect(f.nextEvidenceReference).not.toHaveBeenCalled();
  });
  it("preserves the original deadline through late SDK response, rereads and synchronous final", async () => {
    const f = fixture();
    sdk.send.mockImplementationOnce(async () => {
      f.move(f.invitation.validUntil);
      return status();
    });
    await expect(f.exchange()).rejects.toThrow();
    expect(f.nextEvidenceReference).not.toHaveBeenCalled();
    const g = fixture(),
      proof = await g.exchange();
    await proof.assertCurrent();
    g.move(g.invitation.validUntil);
    expect(() => proof.assertFinalized()).toThrow();
    g.move(g.invitation.observedAt);
    expect(() => proof.assertFinalized()).toThrow();
  });
  it("requires an explicit async guard and refuses late withdrawal or captured-port drift", async () => {
    const f = fixture(),
      proof = await f.exchange();
    expect(() => proof.assertFinalized()).toThrow();
    const g = fixture(),
      live = await g.exchange();
    sdk.send.mockResolvedValue(status(false));
    await expect(live.assertCurrent()).rejects.toThrow();
    expect(() => live.assertFinalized()).toThrow();
    sdk.send.mockResolvedValue(status());
    const h = fixture(),
      held = await h.exchange();
    Object.defineProperty(h.options.envelopes, "decrypt", { value: async () => subject });
    await expect(held.assertCurrent()).rejects.toThrow();
  });
});
