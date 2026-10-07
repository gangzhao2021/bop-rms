import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import { AdminGetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserCredentialHasherPort,
  SessionEnvelopeCryptoPort,
} from "../application/ports/session-credential-ports.js";
import { parseSelectorHash } from "../contracts/browser-session.js";
import {
  buildWorkforceAccountBinding,
  parseWorkforceAccountBindingCommand,
  parseWorkforceAccountBindingConfiguration,
  workforceAccountBindingIntent,
  workforceAccountBindingOriginal,
  workforceAccountSubjectContext,
  type WorkforceAccountBinding,
} from "../contracts/workforce-account-binding.js";
import {
  workforceAccountBindingCodec as codec,
  workforceAccountBindingSubjectHash,
} from "../infrastructure/persistence/workforce-account-binding-provisioner.js";
import {
  createPostgresWorkforceAuthenticationSource,
  type WorkforceAuthenticationSourceOptions,
} from "../infrastructure/persistence/workforce-authentication-source.js";

const sdk = vi.hoisted(() => ({ send: vi.fn(), construct: vi.fn() }));
vi.mock("@aws-sdk/client-cognito-identity-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-cognito-identity-provider")>();
  return {
    ...actual,
    CognitoIdentityProviderClient: class {
      constructor(value: unknown) {
        sdk.construct(value);
      }
      send = sdk.send;
    },
  };
});
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`,
  at = "2026-10-06T12:00:00.000Z",
  deadline = "2026-10-06T12:00:05.000Z",
  authenticatedAt = "2026-10-06T11:55:00.000Z",
  subject = "synthetic-workforce-opaque-subject",
  denied = { code: "WORKFORCE_ACCOUNT_BINDING_DENIED" };
const configuration = parseWorkforceAccountBindingConfiguration({
  environment: "controlled",
  issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Controlled",
  clientIds: ["controlledclient"],
});
const claims = () => ({
  issuer: configuration.issuer,
  clientId: "controlledclient",
  subject,
  authenticatedAt,
  observedAt: at,
});
const remote = () => ({
  Enabled: true,
  UserStatus: "CONFIRMED",
  UserAttributes: [{ Name: "sub", Value: subject }],
  UserCreateDate: new Date("2025-01-01T00:00:00Z"),
  UserMFASettingList: ["SOFTWARE_TOKEN_MFA"],
});
beforeEach(() => {
  sdk.send.mockReset();
  sdk.construct.mockReset();
  sdk.send.mockResolvedValue(remote());
});
async function fixture() {
  const key = Buffer.alloc(32, 7),
    hasher: BrowserCredentialHasherPort = {
      hash: (value) => parseSelectorHash(createHmac("sha256", key).update(value).digest("hex")),
      equals: (a, b) => a === b,
    },
    envelopes: SessionEnvelopeCryptoPort = {
      async encrypt(text, context) {
        const iv = Buffer.alloc(12, 3),
          cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(Buffer.from(context));
        const bytes = Buffer.concat([cipher.update(text), cipher.final()]);
        return {
          algorithm: "SYNTHETIC_AES_256_GCM",
          keyReference: "controlled-key",
          ciphertext: Buffer.concat([iv, bytes, cipher.getAuthTag()]).toString("base64url"),
          encryptionContext: context,
        };
      },
      async decrypt(envelope, context) {
        const bytes = Buffer.from(envelope.ciphertext, "base64url"),
          decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
        decipher.setAAD(Buffer.from(context));
        decipher.setAuthTag(bytes.subarray(-16));
        return Buffer.concat([
          decipher.update(bytes.subarray(12, -16)),
          decipher.final(),
        ]).toString();
      },
    },
    command = parseWorkforceAccountBindingCommand({
      profile: "WorkforceAccountBindingImportV1",
      operationReference: id(1),
      actorReference: id(2),
      subject,
      invitationReference: id(3),
      originalMembershipReference: id(4),
      providerEvidenceReference: id(5),
      recordedByReference: id(6),
      approvedByReference: id(7),
      approvalEvidenceReference: id(8),
      reasonCode: "APPROVED_MAPPING",
    }),
    subjectHash = workforceAccountBindingSubjectHash(hasher, configuration, subject),
    originalCommand = workforceAccountBindingOriginal(command, subjectHash);
  let binding = buildWorkforceAccountBinding(
      {
        profile: "WorkforceAccountBindingV1",
        actorReference: id(2),
        configuration,
        subjectHash,
        encryptedSubject: await envelopes.encrypt(
          codec.canonicalize({ subject }),
          workforceAccountSubjectContext(configuration, id(2)),
        ),
        invitationReference: id(3),
        originalMembershipReference: id(4),
        providerEvidenceReference: id(5),
        operationReference: id(1),
        intentDigest: workforceAccountBindingIntent(configuration, originalCommand, codec),
        originalCommand,
        recordedByReference: id(6),
        approvedByReference: id(7),
        approvalEvidenceReference: id(8),
        reasonCode: "APPROVED_MAPPING",
        auditReference: id(9),
        recordedAt: "2026-01-02T12:00:00.000Z",
        classification: "RestrictedSecurity",
      },
      codec,
    ),
    time = at,
    physicalTx = "901",
    isolation = "read committed",
    missing = false;
  let invitation: Record<string, unknown> = {
    invitation_id: id(3),
    actor_id: id(2),
    membership_id: id(4),
    status: "Accepted",
    provider_evidence_id: id(5),
    version: 2,
    created_at: "2026-01-01T12:00:00.000Z",
    expires_at: "2026-01-02T12:00:00.000Z",
    consumed_at: "2026-01-01T13:00:00.000Z",
    precise: true,
  };
  let hook: (sql: string) => Promise<void> = async () => undefined;
  const calls: { sql: string; values: readonly unknown[] }[] = [],
    tx = {
      async query(sql: string, values: readonly unknown[]) {
        calls.push({ sql, values });
        await hook(sql);
        if (sql.includes("AS isolation"))
          return { rows: [{ isolation, transaction_id: physicalTx }] };
        if (sql.includes("FROM bop_identity.workforce_account_binding_read"))
          return {
            rows: missing
              ? []
              : [
                  {
                    snapshot_text: codec.canonicalize(binding),
                    source_digest: binding.sourceDigest,
                    coherent: true,
                  },
                ],
          };
        if (sql.includes("FROM bop_identity.workforce_account_invitation_read"))
          return { rows: [invitation] };
        return { rows: [] };
      },
    };
  let guard: (() => Promise<void>) | undefined,
    final: (() => void) | undefined,
    registrations = 0;
  const options: WorkforceAuthenticationSourceOptions = {
      transaction: tx,
      configuration: structuredClone(configuration),
      hasher,
      envelopes,
      clock: { now: () => time },
      originalObservedAt: at,
      originalValidUntil: deadline,
      registerBeforeCommit: async (actual, current, seal) => {
        expect(actual).toBe(tx);
        registrations++;
        guard = current;
        final = seal;
      },
    },
    source = createPostgresWorkforceAuthenticationSource(options);
  return {
    source,
    options,
    tx,
    calls,
    subjectHash,
    read: () => source.resolveVerifiedSubject(claims()),
    guard: async () => {
      if (!guard) throw new Error("missing host guard");
      await guard();
    },
    final: () => {
      if (!final) throw new Error("missing final seal");
      final();
    },
    registrations: () => registrations,
    time: (value: string) => {
      time = value;
    },
    physical: (value: string) => {
      physicalTx = value;
    },
    isolation: (value: string) => {
      isolation = value;
    },
    missing: () => {
      missing = true;
    },
    invitation: (patch: Record<string, unknown>) => {
      invitation = { ...invitation, ...patch };
    },
    onQuery: (value: typeof hook) => {
      hook = value;
    },
    rebuild: (patch: Partial<Omit<WorkforceAccountBinding, "sourceDigest">>) => {
      const { sourceDigest, ...body } = binding;
      void sourceDigest;
      binding = buildWorkforceAccountBinding({ ...body, ...patch }, codec);
    },
  };
}

describe("Workforce authentication on the immutable account binding", () => {
  it("maps synthetic already-verified claims through exact HMAC, encrypted subject, original invitation and actual SDK command", async () => {
    const f = await fixture(),
      actor = await f.read();
    expect(actor).toEqual({
      actorType: "User",
      actorReference: id(2),
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt,
      recentMfaAt: null,
    });
    expect(Object.isFrozen(actor)).toBe(true);
    expect(JSON.stringify(actor)).not.toMatch(/subject|email|token|provider|membership/i);
    expect(
      f.calls.find((call) => call.sql.includes("FROM bop_identity.workforce_account_binding_read"))
        ?.values,
    ).toEqual([null, f.subjectHash, configuration.issuer, configuration.environment]);
    const scopes = f.calls.filter((call) =>
      call.sql.includes("set_config('bop.workforce_account_environment'"),
    );
    expect(scopes[0]?.values).toEqual([
      configuration.environment,
      configuration.issuer,
      "",
      f.subjectHash,
      "WORKFORCE_AUTHENTICATION",
    ]);
    expect(scopes.at(-1)?.values).toEqual([
      configuration.environment,
      configuration.issuer,
      id(2),
      "",
      "WORKFORCE_AUTHENTICATION",
    ]);
    expect(
      f.calls.find((call) =>
        call.sql.includes("FROM bop_identity.workforce_account_invitation_read"),
      )?.values,
    ).toEqual([id(2), id(3)]);
    const command = sdk.send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(AdminGetUserCommand);
    expect(command.input).toEqual({ UserPoolId: "ca-central-1_Controlled", Username: subject });
    await f.guard();
    f.final();
    f.options.clock.now = () => {
      throw new Error("post-COMMIT clock must not run");
    };
    const count = f.calls.length;
    f.source.assertFinalized();
    expect(f.calls).toHaveLength(count);
  });
  it("retains genuine stored authentication time without deriving MFA from Provider enrollment", async () => {
    const f = await fixture(),
      old = "2026-10-06T04:00:00.000Z";
    expect(await f.source.currentActor(f.tx, id(2), old, at)).toMatchObject({
      authenticatedAt: old,
      verificationLevel: "SingleFactor",
      recentMfaAt: null,
    });
    expect(
      f.calls.find((call) => call.sql.includes("FROM bop_identity.workforce_account_binding_read"))
        ?.values,
    ).toEqual([id(2), null, configuration.issuer, configuration.environment]);
    await f.guard();
    f.final();
    f.source.assertFinalized();
  });
  it("pins account facts rather than authentication time and keeps one host registration during step-up", async () => {
    const f = await fixture();
    await f.read();
    await f.guard();
    f.time("2026-10-06T12:00:02.000Z");
    const fresh = await f.source.currentActor(
      f.tx,
      id(2),
      "2026-10-06T12:00:01.000Z",
      "2026-10-06T12:00:02.000Z",
    );
    expect(fresh.authenticatedAt).toBe("2026-10-06T12:00:01.000Z");
    expect(fresh.recentMfaAt).toBeNull();
    expect(f.registrations()).toBe(1);
    f.final();
    f.source.assertFinalized();
  });
  it.each([
    { issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Foreign" },
    { clientId: "foreignclient" },
    { subject: "other-opaque-subject" },
    { subject: "email@example.invalid" },
    { authenticatedAt: "2026-10-06T12:00:00.001Z" },
    { authenticatedAt: "0000-01-01T00:00:00.000Z" },
    { authenticatedAt: "2026-10-06T11:55:00Z" },
    { observedAt: "2026-10-06T11:59:59.999Z" },
    { observedAt: "2026-10-06T12:00:00.001Z" },
    { actorReference: id(2) },
    { accountKind: "Platform" },
    { purposeCode: "BRAND_INITIAL_PROVISIONING" },
    { recentMfaAt: authenticatedAt },
  ])(
    "rejects malformed or mismatched verifier input %j and poisons caught failures",
    async (patch) => {
      const f = await fixture();
      await expect(
        f.source.resolveVerifiedSubject({ ...claims(), ...patch }),
      ).rejects.toMatchObject(denied);
      expect(f.registrations()).toBe(1);
      await expect(f.guard()).rejects.toMatchObject(denied);
      expect(() => f.final()).toThrow();
    },
  );
  it("does not invoke getters or bypass registration for malformed caller input", async () => {
    const f = await fixture(),
      get = vi.fn(() => configuration.issuer),
      value = Object.defineProperty(claims(), "issuer", { enumerable: true, get });
    await expect(f.source.resolveVerifiedSubject(value)).rejects.toMatchObject(denied);
    expect(get).not.toHaveBeenCalled();
    expect(f.registrations()).toBe(1);
    expect(f.calls).toHaveLength(0);
    await expect(f.guard()).rejects.toMatchObject(denied);
  });
  it.each(["foreign-transaction", "wrong-actor", "future-authentication", "future-observation"])(
    "rejects invalid stored Session admission: %s",
    async (invalid) => {
      const f = await fixture();
      await expect(
        f.source.currentActor(
          invalid === "foreign-transaction" ? { query: f.tx.query } : f.tx,
          invalid === "wrong-actor" ? id(30) : id(2),
          invalid === "future-authentication" ? "2026-10-06T12:00:00.001Z" : authenticatedAt,
          invalid === "future-observation" ? "2026-10-06T12:00:00.001Z" : at,
        ),
      ).rejects.toMatchObject(denied);
      await expect(f.guard()).rejects.toMatchObject(denied);
    },
  );
  it("rejects missing linkage without allocating an Actor or invoking the Provider", async () => {
    const f = await fixture();
    f.missing();
    await expect(f.read()).rejects.toMatchObject(denied);
    expect(sdk.send).not.toHaveBeenCalled();
    expect(f.calls.some((call) => /INSERT|UPDATE|DELETE/u.test(call.sql))).toBe(false);
  });
  it.each([
    { membership_id: id(30) },
    { provider_evidence_id: id(30) },
    { status: "Revoked" },
    { version: 0 },
    { precise: false },
  ])("rejects mismatched or withdrawn original invitation %j", async (patch) => {
    const f = await fixture();
    f.invitation(patch);
    await expect(f.read()).rejects.toMatchObject(denied);
    expect(sdk.send).not.toHaveBeenCalled();
  });
  it("never advances account fact observation to accept a later-created mapping", async () => {
    const f = await fixture();
    f.time("2026-10-06T12:00:02.000Z");
    f.rebuild({ recordedAt: "2026-10-06T12:00:01.000Z" });
    await expect(
      f.source.resolveVerifiedSubject({ ...claims(), observedAt: "2026-10-06T12:00:02.000Z" }),
    ).rejects.toMatchObject(denied);
  });
  it("checks decrypted subject and AAD against the immutable HMAC binding", async () => {
    const f = await fixture(),
      other = await f.options.envelopes.encrypt(
        codec.canonicalize({ subject: "other-subject" }),
        workforceAccountSubjectContext(configuration, id(2)),
      );
    f.rebuild({ encryptedSubject: other });
    await expect(f.read()).rejects.toMatchObject(denied);
    const aad = await fixture(),
      encrypted = await aad.options.envelopes.encrypt(
        codec.canonicalize({ subject }),
        "foreign-aad",
      );
    aad.rebuild({
      encryptedSubject: {
        ...encrypted,
        encryptionContext: workforceAccountSubjectContext(configuration, id(2)),
      },
    });
    await expect(aad.read()).rejects.toMatchObject(denied);
    expect(sdk.send).not.toHaveBeenCalled();
  });
  it.each(["binding", "invitation", "provider", "physical-transaction"])(
    "refuses late %s drift",
    async (change) => {
      const f = await fixture();
      await f.read();
      if (change === "binding") f.rebuild({ auditReference: id(31) });
      if (change === "invitation") f.invitation({ version: 3 });
      if (change === "provider") sdk.send.mockResolvedValue({ ...remote(), Enabled: false });
      if (change === "physical-transaction") f.physical("902");
      await expect(f.guard()).rejects.toMatchObject(denied);
      expect(() => f.final()).toThrow();
    },
  );
  it.each(["query", "sdk", "final"])(
    "keeps the original five-second deadline during %s",
    async (stage) => {
      const f = await fixture();
      if (stage === "query")
        f.onQuery(async () => {
          f.time(deadline);
        });
      if (stage === "sdk")
        sdk.send.mockImplementationOnce(async () => {
          f.time(deadline);
          return remote();
        });
      if (stage === "final") {
        await f.read();
        await f.guard();
        f.time(deadline);
        expect(() => f.final()).toThrow();
      } else await expect(f.read()).rejects.toMatchObject(denied);
      expect(() => f.source.assertFinalized()).toThrow();
    },
  );
  it("rejects an unregistered final assertion, repeated guard, backward final time and captured query replacement", async () => {
    const early = await fixture();
    expect(() => early.source.assertFinalized()).toThrow();
    await expect(early.read()).rejects.toMatchObject(denied);
    const repeated = await fixture();
    await repeated.read();
    await repeated.guard();
    await expect(repeated.guard()).rejects.toMatchObject(denied);
    const backwards = await fixture();
    await backwards.read();
    await backwards.guard();
    backwards.time("2026-10-06T11:59:59.999Z");
    expect(() => backwards.final()).toThrow();
    const changed = await fixture();
    await changed.read();
    Reflect.set(changed.tx, "query", async () => ({ rows: [] }));
    await expect(changed.guard()).rejects.toMatchObject(denied);
  });
  it("poisons reentry caught inside the remote boundary", async () => {
    const f = await fixture();
    sdk.send.mockImplementationOnce(async () => {
      await expect(f.source.currentActor(f.tx, id(2), authenticatedAt, at)).rejects.toMatchObject(
        denied,
      );
      return remote();
    });
    await expect(f.read()).rejects.toMatchObject(denied);
    await expect(f.guard()).rejects.toMatchObject(denied);
  });
  it("rejects transaction isolation and caller purpose, account-kind or Provider overrides", async () => {
    const isolation = await fixture();
    isolation.isolation("repeatable read");
    await expect(isolation.read()).rejects.toMatchObject(denied);
    const f = await fixture();
    for (const extra of [
      { purposeCode: "WORKFORCE_ACCOUNT_BINDING" },
      { accountKind: "Platform" },
      { actorReference: id(2) },
      { authority: { hold: async () => true } },
      { readCurrentProviderSubject: async () => ({ status: "Enabled" }) },
    ])
      expect(() =>
        createPostgresWorkforceAuthenticationSource({ ...f.options, ...extra }),
      ).toThrow();
    expect(Object.keys(f.source)).toEqual([
      "resolveVerifiedSubject",
      "currentActor",
      "assertFinalized",
    ]);
  });
});
