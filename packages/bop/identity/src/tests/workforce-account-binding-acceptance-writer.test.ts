import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import { AdminGetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { appendPlatformAuditRecordInTransaction } from "@bop/audit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentityActor } from "../contracts/identity-actor.js";
import { parseSelectorHash } from "../contracts/browser-session.js";
import {
  parseWorkforceAccountBindingAcceptanceCommand,
  type WorkforceAccountBinding,
} from "../contracts/workforce-account-binding.js";
import { workforceAccountBindingCodec } from "../infrastructure/persistence/workforce-account-binding-provisioner.js";
import {
  createPostgresWorkforceAccountBindingAcceptanceWriter,
  type WorkforceAccountBindingAcceptanceWriterOptions,
} from "../infrastructure/persistence/workforce-account-binding-provisioner.js";
import type {
  BrowserCredentialHasherPort,
  SessionEnvelopeCryptoPort,
} from "../application/ports/session-credential-ports.js";
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`,
  at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T12:00:05.000Z",
  subject = "controlled-workforce-sub";
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
let enabled = true;
beforeEach(() => {
  enabled = true;
  sdk.send.mockReset();
  sdk.send.mockImplementation(async (command: unknown) => {
    expect(command).toBeInstanceOf(AdminGetUserCommand);
    return {
      Enabled: enabled,
      UserStatus: "CONFIRMED",
      UserAttributes: [{ Name: "sub", Value: subject }],
    };
  });
});
/** Actual AES-GCM, HMAC, public parsers and concrete SDK source. SQL/approval
 * records are controlled test boundaries, not deployed identity evidence. */
function fixture() {
  let now = at,
    transactionId = "42",
    invitationAccepted = true,
    approval = true,
    principal = true,
    saved: WorkforceAccountBinding | undefined,
    allocated = 0;
  const key = Buffer.alloc(32, 7),
    sql: string[] = [],
    guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [],
    audits: unknown[] = [];
  const hasher: BrowserCredentialHasherPort = {
    hash: (value) => parseSelectorHash(createHmac("sha256", key).update(value).digest("hex")),
    equals: (a, b) => a === b,
  };
  const envelopes: SessionEnvelopeCryptoPort = {
    async encrypt(text, context) {
      const iv = Buffer.alloc(12, 3),
        c = createCipheriv("aes-256-gcm", key, iv);
      c.setAAD(Buffer.from(context));
      return {
        algorithm: "SYNTHETIC_AES_256_GCM",
        keyReference: "controlled-key",
        ciphertext: Buffer.concat([iv, c.update(text), c.final(), c.getAuthTag()]).toString(
          "base64url",
        ),
        encryptionContext: context,
      };
    },
    async decrypt(e, context) {
      const b = Buffer.from(e.ciphertext, "base64url"),
        d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      d.setAAD(Buffer.from(context));
      d.setAuthTag(b.subarray(-16));
      return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString();
    },
  };
  const configuration = {
    environment: "controlled",
    issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Controlled",
    clientIds: ["controlledclient"],
  };
  const command = parseWorkforceAccountBindingAcceptanceCommand({
    profile: "WorkforceAccountBindingAcceptanceV1",
    operationReference: id(1),
    actorReference: id(2),
    subject,
    invitationReference: id(3),
    originalMembershipReference: id(4),
    providerEvidenceReference: id(5),
    recordedByReference: id(2),
    approvedByReference: id(7),
    approvalEvidenceReference: id(8),
    reasonCode: "APPROVED_BINDING",
  });
  const operator = createIdentityActor({
    actorType: "User",
    actorReference: id(2),
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "RecentMfa",
    authenticatedAt: at,
    recentMfaAt: at,
  });
  const tx = {
    async query(text: string, values: readonly unknown[]): Promise<unknown> {
      sql.push(text);
      if (text.startsWith("INSERT INTO platform_audit.platform_actor_audit_chain_head"))
        return { rows: [] };
      if (text.startsWith("SELECT next_sequence"))
        return { rows: [{ next_sequence: "1", previous_hash: null, recorded_at: at }] };
      if (text.startsWith("INSERT INTO platform_audit.platform_actor_audit_record"))
        return { rows: [{ audit_reference: values[0] }] };
      if (text.startsWith("UPDATE platform_audit.platform_actor_audit_chain_head"))
        return { rows: [{ next_sequence: "2" }] };
      if (text.startsWith("SELECT session_user"))
        return {
          rows: [
            {
              session_principal: "controlled_acceptor",
              current_principal: "controlled_acceptor",
              isolation: "read committed",
              transaction_id: transactionId,
              controlled: principal,
            },
          ],
        };
      if (text.startsWith("SELECT snapshot_text"))
        return {
          rows:
            saved &&
            saved.recordedByReference === values[0] &&
            saved.operationReference === values[1]
              ? [
                  {
                    snapshot_text: workforceAccountBindingCodec.canonicalize(saved),
                    source_digest: saved.sourceDigest,
                  },
                ]
              : [],
        };
      if (text.includes("workforce_account_binding_read")) {
        expect((values[0] === null) !== (values[1] === null)).toBe(true);
        return {
          rows:
            saved && (saved.actorReference === values[0] || saved.subjectHash === values[1])
              ? [
                  {
                    snapshot_text: workforceAccountBindingCodec.canonicalize(saved),
                    source_digest: saved.sourceDigest,
                    coherent: true,
                  },
                ]
              : [],
        };
      }
      if (text.includes("workforce_account_invitation_read"))
        return {
          rows: [
            {
              invitation_id: id(3),
              actor_id: id(2),
              membership_id: id(4),
              provider_evidence_id: id(5),
              status: invitationAccepted ? "Accepted" : "Revoked",
              version: 2,
              created_at: "2026-10-06T11:00:00.000Z",
              expires_at: "2026-10-07T11:00:00.000Z",
              consumed_at: at,
              precise: true,
            },
          ],
        };
      if (text.startsWith("INSERT")) {
        saved = JSON.parse(String(values[16])) as WorkforceAccountBinding;
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  const options: WorkforceAccountBindingAcceptanceWriterOptions = {
    transaction: tx,
    configuration,
    operatorReference: id(2),
    provisioningRoleName: "controlled_acceptor",
    clock: { now: () => now },
    hasher,
    envelopes,
    originalObservedAt: at,
    originalValidUntil: until,
    authority: {
      async hold(actual, input) {
        expect(actual).toBe(tx);
        expect(input.command).toEqual(command);
        if (!approval) throw Error("withdrawn");
        return {
          operator,
          approvedByReference: id(7),
          approvalEvidenceReference: id(8),
          validUntil: until,
          authorizationTransactionReference: id(40),
          invitationReference: id(3),
          originalOnboardingIntentDigest: `sha256:${"c".repeat(64)}`,
        };
      },
    },
    nextReference: () => {
      allocated++;
      return id(20);
    },
    appendAudit: async (actual, input) => {
      expect(actual).toBe(tx);
      audits.push(input);
      return appendPlatformAuditRecordInTransaction(actual, input);
    },
    registerBeforeCommit: async (actual, guard, final) => {
      expect(actual).toBe(tx);
      guards.push(guard);
      finals.push(final);
    },
  };
  const source = createPostgresWorkforceAccountBindingAcceptanceWriter(options);
  return {
    source,
    options,
    command,
    tx,
    sql,
    guards,
    finals,
    audits,
    hasher,
    configuration,
    get saved() {
      return saved;
    },
    set saved(value: WorkforceAccountBinding | undefined) {
      saved = value;
    },
    get allocated() {
      return allocated;
    },
    set now(value: string) {
      now = value;
    },
    set transactionId(value: string) {
      transactionId = value;
    },
    set invitationAccepted(value: boolean) {
      invitationAccepted = value;
    },
    set approval(value: boolean) {
      approval = value;
    },
    set principal(value: boolean) {
      principal = value;
    },
  };
}
async function complete(f: ReturnType<typeof fixture>) {
  for (const guard of f.guards) await guard();
  for (const final of f.finals) final();
  f.source.assertFinalized();
}
describe("invitation-bound Workforce account binding acceptance", () => {
  it("records the actual target and independent approval using the dedicated admission and public Audit", async () => {
    const f = fixture(),
      b = await f.source.accept(f.command);
    expect(b.recordedByReference).toBe(id(2));
    expect(b.originalCommand.profile).toBe("WorkforceAccountBindingAcceptanceV1");
    expect(f.audits).toEqual([
      expect.objectContaining({
        actorReference: id(2),
        targetReference: id(2),
        actionCode: "WORKFORCE_ACCOUNT_BOUND",
      }),
    ]);
    expect(f.sql.some((sql) => sql.includes("workforce_account_binding_acceptance_admit"))).toBe(
      true,
    );
    expect(f.sql.some((sql) => sql.includes("workforce_account_binding_import_admit"))).toBe(false);
    await complete(f);
    f.now = "2026-10-06T12:01:00.000Z";
    f.source.assertFinalized();
  });
  it("resolves an immutable original before allocation or new invitation/Provider qualification", async () => {
    const f = fixture(),
      b = await f.source.accept(f.command);
    await complete(f);
    const r = fixture();
    r.saved = b;
    r.invitationAccepted = false;
    enabled = false;
    const calls = sdk.send.mock.calls.length;
    expect(await r.source.accept(r.command)).toEqual(b);
    expect(r.allocated).toBe(0);
    expect(r.audits).toEqual([]);
    expect(sdk.send.mock.calls.length).toBe(calls);
    await complete(r);
  });
  it.each(["Platform", "SingleFactor", "old-proof", "wrong-invitation", "wrong-approval"])(
    "refuses %s callback authority and poisons caught failures",
    async (kind) => {
      const f = fixture(),
        hold = f.options.authority.hold;
      f.options.authority.hold = async (tx, input) => {
        const r = await hold(tx, input);
        if (kind === "wrong-invitation") return { ...r, invitationReference: id(99) };
        if (kind === "wrong-approval") return { ...r, approvalEvidenceReference: id(99) };
        return {
          ...r,
          operator: createIdentityActor({
            ...r.operator,
            ...(kind === "Platform" ? { accountKind: "Platform" } : {}),
            ...(kind === "SingleFactor"
              ? { verificationLevel: "SingleFactor", recentMfaAt: null }
              : {}),
            ...(kind === "old-proof"
              ? {
                  authenticatedAt: "2026-10-06T11:44:59.000Z",
                  recentMfaAt: "2026-10-06T11:44:59.000Z",
                }
              : {}),
          }),
        };
      };
      // Build the source after setting its controlled authority; later replacement itself is separately fenced.
      const source = createPostgresWorkforceAccountBindingAcceptanceWriter(f.options);
      await expect(source.accept(f.command)).rejects.toThrow();
      expect(f.saved).toBeUndefined();
      expect(f.audits).toEqual([]);
      for (const guard of f.guards) await expect(guard()).rejects.toThrow();
    },
  );
  it.each(["transaction", "intent"])(
    "pins the original signed %s through the asynchronous guard",
    async (kind) => {
      const f = fixture(),
        hold = f.options.authority.hold;
      let changed = false;
      f.options.authority.hold = async (tx, input) => ({
        ...(await hold(tx, input)),
        authorizationTransactionReference: changed && kind === "transaction" ? id(41) : id(40),
        originalOnboardingIntentDigest: `sha256:${(changed && kind === "intent" ? "d" : "c").repeat(64)}`,
      });
      const source = createPostgresWorkforceAccountBindingAcceptanceWriter(f.options);
      await source.accept(f.command);
      changed = true;
      for (const guard of f.guards) await expect(guard()).rejects.toThrow();
      expect(() => source.assertFinalized()).toThrow();
    },
  );
  it.each(["invitation", "provider", "approval", "deadline", "transaction"])(
    "refuses late %s withdrawal before finalization",
    async (kind) => {
      const f = fixture();
      await f.source.accept(f.command);
      if (kind === "invitation") f.invitationAccepted = false;
      if (kind === "provider") enabled = false;
      if (kind === "approval") f.approval = false;
      if (kind === "deadline") f.now = until;
      if (kind === "transaction") f.transactionId = "43";
      for (const guard of f.guards) await expect(guard()).rejects.toThrow();
      expect(() => f.source.assertFinalized()).toThrow();
    },
  );
  it("rejects ImportV1 and another recorded Actor at its closed entry", async () => {
    for (const patch of [
      { profile: "WorkforceAccountBindingImportV1" },
      { recordedByReference: id(6) },
    ]) {
      const f = fixture();
      await expect(f.source.accept({ ...f.command, ...patch })).rejects.toThrow();
      expect(f.saved).toBeUndefined();
      expect(f.allocated).toBe(0);
    }
  });
});

it("poisons a caught real Audit append failure before any binding insert", async () => {
  const f = fixture();
  const source = createPostgresWorkforceAccountBindingAcceptanceWriter({
    ...f.options,
    appendAudit: async () => {
      throw new Error("Controlled Audit boundary refusal");
    },
  });
  await expect(source.accept(f.command)).rejects.toThrow();
  expect(f.saved).toBeUndefined();
  for (const guard of f.guards) await expect(guard()).rejects.toThrow();
  expect(() => source.assertFinalized()).toThrow();
});
