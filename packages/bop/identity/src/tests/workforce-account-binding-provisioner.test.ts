import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import { AdminGetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { appendPlatformAuditRecordInTransaction } from "@bop/audit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentityActor } from "../contracts/identity-actor.js";
import { parseSelectorHash } from "../contracts/browser-session.js";
import {
  parseWorkforceAccountBindingCommand,
  type WorkforceAccountBinding,
} from "../contracts/workforce-account-binding.js";
import {
  createPostgresWorkforceAccountBindingProvisioner,
  workforceAccountBindingCodec,
  workforceAccountBindingSubjectHash,
  type WorkforceAccountBindingProvisionerOptions,
} from "../infrastructure/persistence/workforce-account-binding-provisioner.js";
import { platformActorDirectorySubjectHash } from "../infrastructure/persistence/platform-actor-directory-store.js";
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
  const command = parseWorkforceAccountBindingCommand({
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
    reasonCode: "APPROVED_BINDING",
  });
  const operator = createIdentityActor({
    actorType: "User",
    actorReference: id(6),
    accountKind: "Platform",
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
              session_principal: "controlled_importer",
              current_principal: "controlled_importer",
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
              created_at: "2026-10-01T12:00:00.000Z",
              expires_at: "2026-10-02T12:00:00.000Z",
              consumed_at: "2026-10-01T13:00:00.000Z",
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
  const options: WorkforceAccountBindingProvisionerOptions = {
    transaction: tx,
    configuration,
    operatorReference: id(6),
    provisioningRoleName: "controlled_importer",
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
  const source = createPostgresWorkforceAccountBindingProvisioner(options);
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
describe("controlled immutable Workforce binding importer", () => {
  it("writes actual encrypted binding and operator Audit, with historical accepted invitation", async () => {
    const f = fixture(),
      b = await f.source.provision(f.command);
    expect(b.actorReference).toBe(id(2));
    expect(workforceAccountBindingCodec.canonicalize(b)).not.toContain(subject);
    expect(f.audits).toEqual([
      expect.objectContaining({
        actorReference: id(6),
        targetReference: id(2),
        purposeCode: "WORKFORCE_ACCOUNT_BINDING",
        actionCode: "WORKFORCE_ACCOUNT_BOUND",
      }),
    ]);
    expect(f.allocated).toBe(1);
    await complete(f);
    expect(f.sql.some((s) => s.includes("workforce_account_binding_import_admit"))).toBe(true);
  });
  it("uses a distinct keyed Workforce hash from Platform identities", () => {
    const f = fixture();
    expect(workforceAccountBindingSubjectHash(f.hasher, f.configuration, subject)).not.toBe(
      platformActorDirectorySubjectHash(f.hasher, f.configuration, subject),
    );
  });
  it("replays exact original without encryption, allocation or Provider/invitation requalification", async () => {
    const f = fixture(),
      b = await f.source.provision(f.command);
    await complete(f);
    const r = fixture();
    r.saved = b;
    r.invitationAccepted = false;
    enabled = false;
    const previous = sdk.send.mock.calls.length;
    expect(await r.source.provision(r.command)).toEqual(b);
    await complete(r);
    expect(r.allocated).toBe(0);
    expect(r.audits).toEqual([]);
    expect(sdk.send.mock.calls.length).toBe(previous);
  });
  it("requires actual current approval on replay", async () => {
    const f = fixture(),
      b = await f.source.provision(f.command),
      r = fixture();
    r.saved = b;
    r.approval = false;
    await expect(r.source.provision(r.command)).rejects.toThrow();
    expect(r.allocated).toBe(0);
  });
  it("refuses same original with changed binding intent", async () => {
    const f = fixture(),
      b = await f.source.provision(f.command),
      r = fixture();
    r.saved = b;
    await expect(r.source.provision({ ...r.command, reasonCode: "OTHER" })).rejects.toMatchObject({
      code: "WORKFORCE_ACCOUNT_BINDING_INTENT_CONFLICT",
    });
    expect(r.allocated).toBe(0);
  });
  it.each(["invitation", "provider", "approval", "principal"] as const)(
    "refuses absent current %s before allocation",
    async (kind) => {
      const f = fixture();
      if (kind === "invitation") f.invitationAccepted = false;
      if (kind === "provider") enabled = false;
      if (kind === "approval") f.approval = false;
      if (kind === "principal") f.principal = false;
      await expect(f.source.provision(f.command)).rejects.toThrow();
      expect(f.allocated).toBe(0);
      await expect(f.guards[0]?.()).rejects.toThrow();
      expect(() => f.finals[0]?.()).toThrow();
    },
  );
  it.each(["invitation", "provider", "approval", "clock", "transaction"] as const)(
    "poisons final guarded %s withdrawal after tentative writes",
    async (kind) => {
      const f = fixture();
      await f.source.provision(f.command);
      if (kind === "invitation") f.invitationAccepted = false;
      if (kind === "provider") enabled = false;
      if (kind === "approval") f.approval = false;
      if (kind === "clock") f.now = until;
      if (kind === "transaction") f.transactionId = "43";
      await expect(f.guards[0]?.()).rejects.toThrow();
      expect(() => f.finals[0]?.()).toThrow();
    },
  );
  it("registers before malformed command, and caught failure still prevents commit", async () => {
    const f = fixture();
    await expect(f.source.provision({ ...f.command, subject: undefined })).rejects.toThrow();
    expect(f.guards).toHaveLength(1);
    expect(f.sql).toEqual([]);
    await expect(f.guards[0]?.()).rejects.toThrow();
  });
  it("rejects query drift without calling the replacement SQL port", async () => {
    const f = fixture();
    await f.source.provision(f.command);
    const replacement = vi.fn(async () => ({ rows: [] }));
    f.tx.query = replacement;
    await expect(f.guards[0]?.()).rejects.toThrow();
    expect(replacement).not.toHaveBeenCalled();
  });
  it("rejects clock rollback and repeat use before final seal", async () => {
    const f = fixture();
    await f.source.provision(f.command);
    f.now = "2026-10-06T11:59:59.999Z";
    await expect(f.source.provision(f.command)).rejects.toThrow();
    await expect(f.guards[0]?.()).rejects.toThrow();
  });
  it("pure postcommit confirmation cannot renew authority, and final is exactly once", async () => {
    const f = fixture();
    await f.source.provision(f.command);
    await complete(f);
    f.now = "2027-01-01T00:00:00.000Z";
    expect(() => f.source.assertFinalized()).not.toThrow();
    expect(() => f.finals[0]?.()).toThrow();
  });
  it("rejects a login-free or Workforce operator rather than confusing the target account with authority", async () => {
    const f = fixture();
    f.options.authority.hold = async () => ({
      operator: createIdentityActor({
        actorType: "User",
        actorReference: id(6),
        accountKind: "Workforce",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "RecentMfa",
        authenticatedAt: at,
        recentMfaAt: at,
      }),
      approvedByReference: id(7),
      approvalEvidenceReference: id(8),
      validUntil: until,
    });
    const source = createPostgresWorkforceAccountBindingProvisioner(f.options);
    await expect(source.provision(f.command)).rejects.toThrow();
    expect(f.allocated).toBe(0);
  });
  it("rejects a historical original from a different configuration", async () => {
    const f = fixture(),
      b = await f.source.provision(f.command),
      r = fixture();
    r.saved = b;
    const source = createPostgresWorkforceAccountBindingProvisioner({
      ...r.options,
      configuration: { ...r.configuration, environment: "other" },
    });
    await expect(source.provision(r.command)).rejects.toThrow();
    expect(r.allocated).toBe(0);
  });
  it("poisons a caught callback reentry before any fresh allocation", async () => {
    const f = fixture(),
      hold = f.options.authority.hold;
    f.options.authority.hold = async (tx, input) => {
      await expect(source.provision(f.command)).rejects.toThrow();
      return hold(tx, input);
    };
    const source = createPostgresWorkforceAccountBindingProvisioner(f.options);
    await expect(source.provision(f.command)).rejects.toThrow();
    expect(f.allocated).toBe(0);
    await expect(f.guards[0]?.()).rejects.toThrow();
  });
  it("refuses accessor rows before invoking their getter", async () => {
    const f = fixture(),
      original = f.tx.query;
    let calls = 0;
    f.tx.query = async (text, values) => {
      if (text.startsWith("SELECT snapshot_text")) {
        const rows: unknown[] = [{}];
        Object.defineProperty(rows, "0", {
          enumerable: true,
          get() {
            calls++;
            return {};
          },
        });
        return { rows };
      }
      return original(text, values);
    };
    const source = createPostgresWorkforceAccountBindingProvisioner(f.options);
    await expect(source.provision(f.command)).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("poisons an early caught final assertion and keeps the original transaction uncommittable", async () => {
    const f = fixture();
    await f.source.provision(f.command);
    expect(() => f.source.assertFinalized()).toThrow();
    await expect(f.guards[0]?.()).rejects.toThrow();
  });

  it.each(["Actor", "subject"] as const)(
    "refuses rebinding an existing %s before allocation",
    async (kind) => {
      const f = fixture(),
        b = await f.source.provision(f.command),
        r = fixture();
      r.saved = b;
      const changed = {
        ...r.command,
        operationReference: id(40),
        ...(kind === "subject" ? { actorReference: id(41) } : {}),
      };
      await expect(r.source.provision(changed)).rejects.toMatchObject({
        code: "WORKFORCE_ACCOUNT_BINDING_CONFLICT",
      });
      expect(r.allocated).toBe(0);
      expect(r.audits).toEqual([]);
    },
  );
});

it("keeps the Platform importer entry closed against invitation acceptance origins", async () => {
  const f = fixture();
  await expect(
    f.source.provision({
      ...f.command,
      profile: "WorkforceAccountBindingAcceptanceV1",
      recordedByReference: f.command.actorReference,
    }),
  ).rejects.toThrow();
  expect(f.allocated).toBe(0);
  expect(f.saved).toBeUndefined();
  for (const guard of f.guards) await expect(guard()).rejects.toThrow();
});
