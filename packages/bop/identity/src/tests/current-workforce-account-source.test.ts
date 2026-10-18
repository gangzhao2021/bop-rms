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
  createPostgresCurrentWorkforceAccountSource,
  type CurrentWorkforceAccountSourceOptions,
  type CurrentWorkforceAccountTransaction,
} from "../infrastructure/persistence/current-workforce-account-source.js";

const sdk = vi.hoisted(() => ({ send: vi.fn(), construct: vi.fn() }));
vi.mock("@aws-sdk/client-cognito-identity-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-cognito-identity-provider")>();
  return {
    ...actual,
    CognitoIdentityProviderClient: class {
      constructor(options: unknown) {
        sdk.construct(options);
      }
      send = sdk.send;
    },
  };
});
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`,
  at = "2026-10-06T12:00:00.000Z",
  deadline = "2026-10-06T12:00:05.000Z",
  subject = "synthetic-opaque-workforce-subject",
  denied = { code: "WORKFORCE_ACCOUNT_BINDING_DENIED" };
const configuration = parseWorkforceAccountBindingConfiguration({
  environment: "controlled",
  issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Controlled",
  clientIds: ["controlledclient"],
});
const providerResponse = () => ({
  Enabled: true,
  UserStatus: "CONFIRMED",
  UserAttributes: [
    { Name: "sub", Value: subject },
    { Name: "email", Value: "discard@example.invalid" },
  ],
  UserCreateDate: new Date("2025-01-01T00:00:00Z"),
  PreferredMfaSetting: "SOFTWARE_TOKEN_MFA",
});
beforeEach(() => {
  sdk.send.mockReset();
  sdk.construct.mockReset();
  sdk.send.mockResolvedValue(providerResponse());
});
function cryptoPorts() {
  const key = Buffer.alloc(32, 7),
    hasher: BrowserCredentialHasherPort = {
      hash: (value) => parseSelectorHash(createHmac("sha256", key).update(value).digest("hex")),
      equals: (left, right) => left === right,
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
    };
  return { hasher, envelopes };
}
async function fixture() {
  const ports = cryptoPorts(),
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
    subjectHash = workforceAccountBindingSubjectHash(ports.hasher, configuration, subject),
    originalCommand = workforceAccountBindingOriginal(command, subjectHash);
  let binding = buildWorkforceAccountBinding(
    {
      profile: "WorkforceAccountBindingV1",
      actorReference: id(2),
      configuration,
      subjectHash,
      encryptedSubject: await ports.envelopes.encrypt(
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
  );
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
    },
    time = at,
    until = deadline,
    isolation = "read committed",
    transactionId = "901",
    withdrawn = false,
    authorityPatch: Record<string, unknown> = {},
    bindingRowPatch: Record<string, unknown> = {},
    bindingResult: unknown,
    invitationResult: unknown;
  let queryHook: (sql: string) => Promise<void> = async () => undefined,
    authorityHook: () => Promise<void> = async () => undefined;
  const calls: { sql: string; values: readonly unknown[] }[] = [],
    tx: CurrentWorkforceAccountTransaction = {
      async query(sql, values) {
        calls.push({ sql, values });
        await queryHook(sql);
        if (sql.includes("AS isolation"))
          return { rows: [{ isolation, transaction_id: transactionId }] };
        if (sql.includes("FROM bop_identity.workforce_account_binding_read"))
          return (
            bindingResult ?? {
              rows: [
                {
                  snapshot_text: codec.canonicalize(binding),
                  source_digest: binding.sourceDigest,
                  coherent: true,
                  ...bindingRowPatch,
                },
              ],
            }
          );
        if (sql.includes("FROM bop_identity.workforce_account_invitation_read"))
          return invitationResult ?? { rows: [invitation] };
        return { rows: [] };
      },
    };
  let guard: (() => Promise<void>) | undefined,
    final: (() => void) | undefined,
    registrations = 0;
  const options: CurrentWorkforceAccountSourceOptions = {
      transaction: tx,
      configuration: structuredClone(configuration),
      actorReference: id(2),
      ...ports,
      clock: { now: () => time },
      originalObservedAt: at,
      originalValidUntil: deadline,
      authority: {
        hold: vi.fn(async (actualTx, input) => {
          expect(actualTx).toBe(tx);
          await authorityHook();
          if (withdrawn) throw new Error("private authority denial");
          return {
            ...input,
            validUntil: until < input.validUntil ? until : input.validUntil,
            ...authorityPatch,
          };
        }),
      },
      registerBeforeCommit: async (actualTx, current, seal) => {
        expect(actualTx).toBe(tx);
        registrations++;
        guard = current;
        final = seal;
      },
    },
    source = createPostgresCurrentWorkforceAccountSource(options);
  return {
    options,
    source,
    tx,
    calls,
    ports,
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
    until: (value: string) => {
      until = value;
    },
    isolation: (value: string) => {
      isolation = value;
    },
    transactionId: (value: string) => {
      transactionId = value;
    },
    withdraw: () => {
      withdrawn = true;
    },
    authorityPatch: (value: Record<string, unknown>) => {
      authorityPatch = value;
    },
    onQuery: (hook: typeof queryHook) => {
      queryHook = hook;
    },
    onAuthority: (hook: typeof authorityHook) => {
      authorityHook = hook;
    },
    invitation: (patch: Record<string, unknown>) => {
      invitation = { ...invitation, ...patch };
    },
    bindingRow: (patch: Record<string, unknown>) => {
      bindingRowPatch = patch;
    },
    results: (bindingRows: unknown, invitationRows?: unknown) => {
      bindingResult = bindingRows;
      invitationResult = invitationRows;
    },
    binding: () => binding,
    rebuild: (patch: Partial<Omit<WorkforceAccountBinding, "sourceDigest">>) => {
      const { sourceDigest, ...body } = binding;
      void sourceDigest;
      binding = buildWorkforceAccountBinding({ ...body, ...patch }, codec);
    },
  };
}

describe("actual current Workforce account source", () => {
  it("combines immutable encrypted mapping, original accepted invitation and real SDK status without inventing login facts", async () => {
    const f = await fixture(),
      account = await f.source.hold();
    expect(account).toEqual({
      profile: "CurrentWorkforceAccountV1",
      actorType: "User",
      actorReference: id(2),
      accountKind: "Workforce",
      status: "Active",
      observedAt: at,
      validUntil: deadline,
    });
    expect(Object.isFrozen(account)).toBe(true);
    expect(JSON.stringify(account)).not.toMatch(
      /subject|email|Mfa|authenticatedAt|provider|membership|token/i,
    );
    expect(sdk.send.mock.calls[0]?.[0]).toBeInstanceOf(AdminGetUserCommand);
    expect(sdk.send.mock.calls[0]?.[0].input).toEqual({
      UserPoolId: "ca-central-1_Controlled",
      Username: subject,
    });
    expect(
      f.calls.find((call) => call.sql.includes("FROM bop_identity.workforce_account_binding_read"))
        ?.values,
    ).toEqual([id(2), null, configuration.issuer, configuration.environment]);
    expect(
      f.calls.find((call) =>
        call.sql.includes("FROM bop_identity.workforce_account_invitation_read"),
      )?.values,
    ).toEqual([id(2), id(3)]);
    expect(
      f.calls.every(
        (call) =>
          !/FROM bop_identity\.(workforce_invitation|workforce_account_binding)(\s|$)/u.test(
            call.sql,
          ),
      ),
    ).toBe(true);
    await f.guard();
    f.final();
    f.options.clock.now = () => {
      throw new Error("post-COMMIT clock must not be read");
    };
    const count = f.calls.length;
    f.source.assertFinalized();
    expect(f.calls).toHaveLength(count);
  });
  it("holds cached readers through host checks with one registration and the original shortest deadline", async () => {
    const f = await fixture();
    await f.source.hold();
    f.until("2026-10-06T12:00:04.000Z");
    expect((await f.source.hold()).validUntil).toBe("2026-10-06T12:00:04.000Z");
    await f.guard();
    f.until(deadline);
    expect((await f.source.hold()).validUntil).toBe("2026-10-06T12:00:04.000Z");
    expect(f.registrations()).toBe(1);
    f.final();
    f.source.assertFinalized();
  });
  it.each([
    ["wrong original Membership", { membership_id: id(30) }],
    ["wrong Provider evidence", { provider_evidence_id: id(30) }],
    ["wrong invitation", { invitation_id: id(30) }],
    ["wrong Actor", { actor_id: id(30) }],
    ["revoked", { status: "Revoked" }],
    ["pending", { status: "Pending" }],
    ["missing evidence", { provider_evidence_id: null }],
    ["string version", { version: "2" }],
    ["zero version", { version: 0 }],
    ["imprecise", { precise: false }],
    ["NULL precision", { precise: null }],
    ["wrong delivery window", { expires_at: "2026-01-02T12:00:00.001Z" }],
    ["consumed at expiry", { consumed_at: "2026-01-02T12:00:00.000Z" }],
    ["future consumption", { consumed_at: "2026-10-06T12:00:00.001Z" }],
    ["invalid timestamp", { created_at: "2026-01-01T12:00:00Z" }],
    ["year zero", { created_at: "0000-01-01T12:00:00.000Z" }],
  ] satisfies [string, Record<string, unknown>][])(
    "rejects %s invitation facts before Provider access",
    async (_name, patch) => {
      const f = await fixture();
      f.invitation(patch);
      await expect(f.source.hold()).rejects.toMatchObject(denied);
      expect(sdk.send).not.toHaveBeenCalled();
      await expect(f.guard()).rejects.toMatchObject(denied);
    },
  );
  it.each([
    { Enabled: false },
    { UserStatus: "UNCONFIRMED" },
    { UserStatus: "EXTERNAL_PROVIDER" },
    { UserAttributes: [{ Name: "sub", Value: "foreign" }] },
    {
      UserAttributes: [
        { Name: "sub", Value: subject },
        { Name: "identities", Value: "[]" },
      ],
    },
  ])("rejects actual SDK account refusal %j", async (patch) => {
    const f = await fixture();
    sdk.send.mockResolvedValue({ ...providerResponse(), ...patch });
    await expect(f.source.hold()).rejects.toMatchObject(denied);
    await expect(f.guard()).rejects.toMatchObject(denied);
  });
  it.each(["binding", "invitation", "provider", "authority"])(
    "rechecks late %s withdrawal before COMMIT",
    async (stage) => {
      const f = await fixture();
      await f.source.hold();
      if (stage === "binding") f.rebuild({ auditReference: id(31) });
      if (stage === "invitation") f.invitation({ version: 3 });
      if (stage === "provider")
        sdk.send.mockResolvedValue({ ...providerResponse(), Enabled: false });
      if (stage === "authority") f.withdraw();
      await expect(f.guard()).rejects.toMatchObject(denied);
      expect(() => f.final()).toThrow();
    },
  );
  it.each([
    { coherent: false },
    { coherent: null },
    { source_digest: `sha256:${"0".repeat(64)}` },
    { snapshot_text: "{}" },
    { snapshot_text: " ".repeat(16_385) },
  ])("rejects malformed binding receipt %j", async (patch) => {
    const f = await fixture();
    f.bindingRow(patch);
    await expect(f.source.hold()).rejects.toMatchObject(denied);
  });
  it("rejects noncanonical bytes, future binding and a correctly rehashed foreign configuration", async () => {
    const spaces = await fixture();
    spaces.bindingRow({ snapshot_text: JSON.stringify(spaces.binding(), null, 2) });
    await expect(spaces.source.hold()).rejects.toMatchObject(denied);
    const future = await fixture();
    future.rebuild({ recordedAt: "2026-10-06T12:00:00.001Z" });
    await expect(future.source.hold()).rejects.toMatchObject(denied);
    const foreign = await fixture(),
      nextConfig = { ...configuration, clientIds: ["foreignclient"] };
    foreign.rebuild({
      configuration: nextConfig,
      intentDigest: workforceAccountBindingIntent(
        nextConfig,
        foreign.binding().originalCommand,
        codec,
      ),
    });
    await expect(foreign.source.hold()).rejects.toMatchObject(denied);
  });
  it("verifies actual AAD and HMAC, even for well-formed rehashed snapshots", async () => {
    const altered = await fixture(),
      encrypted = await altered.ports.envelopes.encrypt(
        codec.canonicalize({ subject: "other-opaque-subject" }),
        workforceAccountSubjectContext(configuration, id(2)),
      );
    altered.rebuild({ encryptedSubject: encrypted });
    await expect(altered.source.hold()).rejects.toMatchObject(denied);
    const wrongAad = await fixture(),
      wrong = await wrongAad.ports.envelopes.encrypt(codec.canonicalize({ subject }), "wrong-aad");
    wrongAad.rebuild({
      encryptedSubject: {
        ...wrong,
        encryptionContext: workforceAccountSubjectContext(configuration, id(2)),
      },
    });
    await expect(wrongAad.source.hold()).rejects.toMatchObject(denied);
    expect(sdk.send).not.toHaveBeenCalled();
  });
  it.each([
    { actorReference: id(30) },
    { purposeCode: "LOGIN" },
    { observedAt: "2026-10-06T11:59:59.999Z" },
    { validUntil: "2026-10-06T12:00:05.001Z" },
    { validUntil: at },
    { passed: true },
  ])("requires exact current caller authority %j", async (patch) => {
    const f = await fixture();
    f.authorityPatch(patch);
    await expect(f.source.hold()).rejects.toMatchObject(denied);
    expect(f.calls).toHaveLength(0);
    await expect(f.guard()).rejects.toMatchObject(denied);
  });
  it("checks authority after Provider completion and restores the exact owning scope", async () => {
    const f = await fixture();
    sdk.send.mockImplementationOnce(async () => {
      f.withdraw();
      return providerResponse();
    });
    await expect(f.source.hold()).rejects.toMatchObject(denied);
    const ok = await fixture();
    await ok.source.hold();
    expect(ok.calls.at(-1)?.sql).toContain("set_config('bop.workforce_account_purpose',$5,true)");
    expect(ok.calls.at(-1)?.values).toEqual([
      configuration.environment,
      configuration.issuer,
      id(2),
      "",
      "BRAND_INITIAL_PROVISIONING",
    ]);
  });
  it("rejects whole malformed pages and descriptor accessors without invoking them", async () => {
    const getter = vi.fn(() => ({})),
      sparse = new Array(1),
      accessor = Object.defineProperty([], "0", { enumerable: true, get: getter });
    for (const result of [
      { rows: [] },
      { rows: [{}, {}] },
      { rows: sparse },
      { rows: accessor },
      Object.defineProperty({}, "rows", { get: getter }),
    ]) {
      const f = await fixture();
      f.results(result);
      await expect(f.source.hold()).rejects.toMatchObject(denied);
      const invitation = await fixture();
      invitation.results(undefined, result);
      await expect(invitation.source.hold()).rejects.toMatchObject(denied);
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it("requires the same physical READ COMMITTED transaction", async () => {
    const f = await fixture();
    f.isolation("repeatable read");
    await expect(f.source.hold()).rejects.toMatchObject(denied);
    const drift = await fixture();
    await drift.source.hold();
    drift.transactionId("902");
    await expect(drift.guard()).rejects.toMatchObject(denied);
    const during = await fixture();
    during.onQuery(async (sql) => {
      if (sql.includes("workforce_account_invitation_read")) during.transactionId("903");
    });
    await expect(during.source.hold()).rejects.toMatchObject(denied);
  });
  it.each(["query", "provider", "authority", "final"])(
    "enforces the original deadline during %s",
    async (stage) => {
      const f = await fixture();
      if (stage === "query")
        f.onQuery(async () => {
          f.time(deadline);
        });
      if (stage === "provider")
        sdk.send.mockImplementationOnce(async () => {
          f.time(deadline);
          return providerResponse();
        });
      if (stage === "authority")
        f.onAuthority(async () => {
          f.time(deadline);
        });
      if (stage === "final") {
        await f.source.hold();
        await f.guard();
        f.time(deadline);
        expect(() => f.final()).toThrow();
      } else await expect(f.source.hold()).rejects.toMatchObject(denied);
      expect(() => f.source.assertFinalized()).toThrow();
    },
  );
  it("registers refusal before an expired first read and rejects backward final time", async () => {
    const f = await fixture();
    f.time(deadline);
    await expect(f.source.hold()).rejects.toMatchObject(denied);
    expect(f.registrations()).toBe(1);
    expect(f.calls).toHaveLength(0);
    await expect(f.guard()).rejects.toMatchObject(denied);
    const backward = await fixture();
    await backward.source.hold();
    await backward.guard();
    backward.time("2026-10-06T11:59:59.999Z");
    expect(() => backward.final()).toThrow();
  });
  it.each([
    "query",
    "clock",
    "authority",
    "hasher",
    "decrypt",
    "configuration",
    "actor",
    "registration",
  ])("refuses captured %s replacement", async (port) => {
    const f = await fixture();
    await f.source.hold();
    if (port === "query") f.tx.query = async () => ({ rows: [] });
    if (port === "clock") f.options.clock.now = () => at;
    if (port === "authority") f.options.authority.hold = async (_tx, input) => input;
    if (port === "hasher") f.options.hasher.hash = () => parseSelectorHash("0".repeat(64));
    if (port === "decrypt") f.options.envelopes.decrypt = async () => JSON.stringify({ subject });
    if (port === "configuration") Reflect.set(f.options.configuration, "clientIds", ["foreign"]);
    if (port === "actor") Reflect.set(f.options, "actorReference", id(30));
    if (port === "registration")
      Reflect.set(f.options, "registerBeforeCommit", async () => undefined);
    await expect(f.guard()).rejects.toMatchObject(denied);
  });
  it("poisons a caught early assertion and caught reentry through the actual Provider boundary", async () => {
    const early = await fixture();
    expect(() => early.source.assertFinalized()).toThrow();
    await expect(early.source.hold()).rejects.toMatchObject(denied);
    await expect(early.guard()).rejects.toMatchObject(denied);
    const entered = await fixture();
    sdk.send.mockImplementationOnce(async () => {
      await expect(entered.source.hold()).rejects.toMatchObject(denied);
      return providerResponse();
    });
    await expect(entered.source.hold()).rejects.toMatchObject(denied);
    await expect(entered.guard()).rejects.toMatchObject(denied);
  });
  it("requires exactly one ordered host guard and final seal", async () => {
    const early = await fixture();
    await early.source.hold();
    expect(() => early.final()).toThrow();
    await expect(early.guard()).rejects.toMatchObject(denied);
    const twice = await fixture();
    await twice.source.hold();
    await twice.guard();
    await expect(twice.guard()).rejects.toMatchObject(denied);
    const after = await fixture();
    await after.source.hold();
    await after.guard();
    after.final();
    await expect(after.source.hold()).rejects.toMatchObject(denied);
    expect(() => after.source.assertFinalized()).toThrow();
  });
  it("rejects absent authority, unbounded original leases and caller-supplied Provider verdicts", async () => {
    const f = await fixture();
    for (const patch of [
      { originalValidUntil: "2026-10-06T12:00:05.001Z" },
      { originalValidUntil: at },
      { authority: {} },
      { readCurrentProviderSubject: async () => ({ passed: true }) },
    ])
      expect(() =>
        createPostgresCurrentWorkforceAccountSource({ ...f.options, ...patch } as never),
      ).toThrow();
  });
  it("never exposes SDK or database exception details", async () => {
    const f = await fixture();
    sdk.send.mockRejectedValue(new Error("private-provider-secret"));
    await expect(f.source.hold()).rejects.toMatchObject({
      ...denied,
      message: "Workforce account binding is unavailable",
    });
    const db = await fixture();
    db.onQuery(async () => {
      throw new Error("private-row-detail");
    });
    await expect(db.source.hold()).rejects.toMatchObject({
      ...denied,
      message: "Workforce account binding is unavailable",
    });
  });
});
