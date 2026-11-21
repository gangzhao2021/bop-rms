import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeRfc8785 } from "@bop/audit";
import { createIdentityActor } from "../contracts/identity-actor.js";
import { parseRawBrowserCredential, parseSelectorHash } from "../contracts/browser-session.js";
import {
  createWorkforceInvitation,
  type WorkforceInvitation,
} from "../contracts/workforce-identity-security.js";
import {
  parseWorkforceOnboardingOriginal,
  parseWorkforceOnboardingOperation,
  workforceOnboardingIntent,
  type WorkforceOnboardingOperation,
} from "../contracts/workforce-onboarding-operation.js";
import {
  createPostgresWorkforceOnboardingOperationStore,
  workforceOnboardingCodec,
  type WorkforceOnboardingOperationStoreOptions,
} from "../infrastructure/persistence/workforce-onboarding-operation-store.js";
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  end = "2026-10-07T12:00:00.000Z";
/** SQL, clock and approved authority are controlled protocol boundaries. The
 * owning Audit writer, public validators, HMAC and AES-GCM are real. */
function fixture() {
  let now = at,
    allocated = 100,
    generated = 0,
    creatorCalls = 0,
    granted = true,
    txid = "42",
    txReads = 0,
    autocommit = false,
    invitation: WorkforceInvitation | undefined,
    corrupt = false;
  let nextSequence = 1,
    previousHash: string | null = null;
  const records: WorkforceOnboardingOperation[] = [],
    audits: (readonly unknown[])[] = [],
    sql: string[] = [],
    guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [];
  const key = Buffer.alloc(32, 7),
    secret = parseRawBrowserCredential("A".repeat(43));
  const original = parseWorkforceOnboardingOriginal({
    profile: "WorkforceOnboardingOriginalV1",
    configuration: {
      environment: "controlled",
      issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Controlled",
      clientId: "controlledclient",
    },
    operationReference: id(1),
    operatorReference: id(2),
    actorReference: id(3),
    brandReference: id(4),
    membershipReference: id(5),
    storeAssignmentReferences: [],
    emailDigest: "a".repeat(64),
    approvedByReference: id(6),
    approvalEvidenceReference: id(7),
    relationshipEvidenceReference: id(8),
    approvedPlanDigest: `sha256:${"b".repeat(64)}`,
    reasonCode: "APPROVED_ONBOARDING",
  });
  const tx = {
    async query(text: string, values: readonly unknown[]): Promise<unknown> {
      sql.push(text);
      if (
        text.startsWith("SELECT set_config") ||
        text.includes("workforce_onboarding_operation_admit")
      )
        return { rows: [] };
      if (text.includes("transaction_isolation")) {
        txReads++;
        return {
          rows: [
            { isolation: "read committed", transaction_id: autocommit ? String(txReads) : txid },
          ],
        };
      }
      if (text.startsWith("SELECT snapshot_text")) {
        const saved = [...records]
          .reverse()
          .find(
            (r) =>
              r.original.operatorReference === values[0] &&
              r.original.operationReference === values[1],
          );
        return {
          rows: saved
            ? [
                {
                  snapshot_text: canonicalizeRfc8785(saved),
                  source_digest: corrupt ? `sha256:${"f".repeat(64)}` : saved.sourceDigest,
                },
              ]
            : [],
        };
      }
      if (text.startsWith("SELECT invitation_id")) {
        const i = invitation;
        return {
          rows:
            i && i.invitationReference === values[0]
              ? [
                  {
                    invitation_id: i.invitationReference,
                    actor_id: i.actorReference,
                    inviter_actor_id: i.inviterActorReference,
                    membership_id: i.membershipReference,
                    store_assignment_ids: [...i.storeAssignmentReferences],
                    email_digest: i.emailDigest,
                    selector_hash: i.selectorHash,
                    status: i.status,
                    provider_evidence_id: i.providerEvidenceReference,
                    version: i.version,
                    created_at: i.createdAt,
                    expires_at: i.expiresAt,
                    consumed_at: i.consumedAt,
                    precise: true,
                  },
                ]
              : [],
        };
      }
      if (text.startsWith("INSERT INTO platform_audit.platform_actor_audit_chain_head"))
        return { rows: [] };
      if (text.startsWith("SELECT next_sequence"))
        return {
          rows: [
            { next_sequence: String(nextSequence), previous_hash: previousHash, recorded_at: now },
          ],
        };
      if (text.startsWith("INSERT INTO platform_audit.platform_actor_audit_record")) {
        audits.push(values);
        return { rows: [{ audit_reference: values[0] }] };
      }
      if (text.startsWith("UPDATE platform_audit.platform_actor_audit_chain_head")) {
        const hash = values[2];
        if (!Buffer.isBuffer(hash) || values[3] !== nextSequence)
          throw new Error("controlled Audit mismatch");
        previousHash = hash.toString("hex");
        nextSequence++;
        return { rows: [{ next_sequence: String(nextSequence) }] };
      }
      if (text.startsWith("INSERT INTO bop_identity.workforce_onboarding_operation")) {
        const raw = values[22];
        if (typeof raw !== "string") throw new Error("controlled snapshot missing");
        records.push(parseWorkforceOnboardingOperation(JSON.parse(raw), workforceOnboardingCodec));
        return { rows: [] };
      }
      throw new Error("controlled unhandled SQL");
    },
  };
  function options(): WorkforceOnboardingOperationStoreOptions {
    const observedAt = now,
      validUntil = new Date(Date.parse(now) + 5000).toISOString();
    const operator = createIdentityActor({
      actorType: "User",
      actorReference: original.operatorReference,
      accountKind: "Platform",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "RecentMfa",
      authenticatedAt: observedAt,
      recentMfaAt: observedAt,
    });
    return {
      transaction: tx,
      configuration: original.configuration,
      binding: {
        operatorReference: original.operatorReference,
        actorReference: original.actorReference,
        brandReference: original.brandReference,
        membershipReference: original.membershipReference,
        purposeCode: "WORKFORCE_ONBOARDING",
      },
      clock: { now: () => now },
      originalObservedAt: observedAt,
      originalValidUntil: validUntil,
      authority: {
        async hold(actual, input) {
          expect(actual).toBe(tx);
          if (!granted) throw new Error("controlled approval withdrawn");
          return {
            binding: input.binding,
            action: input.action,
            requestDigest: input.requestDigest,
            operator,
            validUntil: input.validUntil,
          };
        },
      },
      hasher: {
        hash: (value) => parseSelectorHash(createHmac("sha256", key).update(value).digest("hex")),
        equals: (a, b) => a === b,
      },
      envelopes: {
        async encrypt(value, context) {
          const iv = Buffer.alloc(12, 3),
            cipher = createCipheriv("aes-256-gcm", key, iv);
          cipher.setAAD(Buffer.from(context));
          return {
            algorithm: "SYNTHETIC_AES_256_GCM",
            keyReference: "controlled-key",
            ciphertext: Buffer.concat([
              iv,
              cipher.update(value),
              cipher.final(),
              cipher.getAuthTag(),
            ]).toString("base64url"),
            encryptionContext: context,
          };
        },
        async decrypt(e, context) {
          const bytes = Buffer.from(e.ciphertext, "base64url"),
            cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
          cipher.setAAD(Buffer.from(context));
          cipher.setAuthTag(bytes.subarray(-16));
          return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString();
        },
      },
      credentials: {
        generate() {
          generated++;
          return secret;
        },
      },
      nextReference: () => id(allocated++),
      async createInvitation(actual, command) {
        expect(actual).toBe(tx);
        creatorCalls++;
        invitation = createWorkforceInvitation({
          invitationReference: command.invitationReference,
          actorReference: command.actorReference,
          inviterActorReference: command.inviterActorReference,
          membershipReference: command.membershipReference,
          storeAssignmentReferences: command.storeAssignmentReferences,
          emailDigest: command.emailDigest,
          selectorHash: command.selectorHash,
          status: "Pending",
          createdAt: command.observedAt,
          expiresAt: new Date(Date.parse(command.observedAt) + 86400000).toISOString(),
          consumedAt: null,
          providerEvidenceReference: null,
          version: 1,
        });
        return invitation;
      },
      async registerBeforeCommit(actual, guard, final) {
        expect(actual).toBe(tx);
        guards.push(guard);
        finals.push(final);
      },
    };
  }
  function source() {
    return createPostgresWorkforceOnboardingOperationStore(options());
  }
  async function finalize() {
    for (const guard of guards.splice(0)) await guard();
    for (const final of finals.splice(0)) final();
  }
  const request = () => ({
    operationReference: original.operationReference,
    intentDigest: workforceOnboardingIntent(original, workforceOnboardingCodec),
  });
  return {
    original,
    source,
    options,
    tx,
    request,
    finalize,
    records,
    audits,
    sql,
    guards,
    secret,
    counts: () => ({
      allocated,
      generated,
      creatorCalls,
      records: records.length,
      audits: audits.length,
    }),
    setNow: (v: string) => {
      now = v;
    },
    deny: () => {
      granted = false;
    },
    autocommit: () => {
      autocommit = true;
    },
    changeTx: () => {
      txid = "43";
    },
    corrupt: () => {
      corrupt = true;
    },
    removeInvitation: () => {
      invitation = undefined;
    },
    wrongInvitation: () => {
      if (!invitation) throw new Error("fixture missing invitation");
      invitation = createWorkforceInvitation({ ...invitation, emailDigest: "f".repeat(64) });
    },
  };
}
async function prepared(f: ReturnType<typeof fixture>) {
  const s = f.source(),
    r = await s.prepare(f.original);
  await f.finalize();
  s.assertFinalized();
  return r.record;
}
async function claimed(f: ReturnType<typeof fixture>) {
  const p = await prepared(f);
  const s = f.source(),
    r = await s.claimDispatch({ ...f.request(), expectedVersion: p.version });
  await f.finalize();
  s.assertFinalized();
  return r.record;
}
function observation(
  f: ReturnType<typeof fixture>,
  status: "Unknown" | "NotFound" | "Found" | "Mismatch",
  provider: unknown = null,
) {
  return {
    profile: "CognitoWorkforceInvitationObservationV1",
    actorReference: f.original.actorReference,
    creationIntentDigest: f.request().intentDigest,
    emailDigest: f.original.emailDigest,
    observedAt: at,
    validUntil: "2026-10-06T12:00:05.000Z",
    status,
    dispatchAccepted: null,
    provider,
  };
}
describe("actual Workforce onboarding journal composition", () => {
  it("creates actual Pending and public Audit in the captured transaction, secret returned once", async () => {
    const f = fixture(),
      s = f.source(),
      result = await s.prepare(f.original);
    expect(result.deliverySecret).toBe(f.secret);
    expect(result.outcome).toBe("Prepared");
    expect(f.sql.findIndex((x) => x.includes("workforce_onboarding_operation_admit"))).toBeLessThan(
      f.sql.findIndex((x) => x.startsWith("SELECT snapshot_text")),
    );
    expect(f.audits).toHaveLength(1);
    expect(f.audits[0]?.slice(1, 7)).toEqual([
      f.original.operatorReference,
      "WORKFORCE_ONBOARDING",
      "WORKFORCE_ONBOARDING_RECORDED",
      "WorkforceOnboardingOperation",
      f.original.operationReference,
      result.record.phaseOperationReference,
    ]);
    expect(
      f.sql.some((x) => x.startsWith("UPDATE platform_audit.platform_actor_audit_chain_head")),
    ).toBe(true);
    expect(canonicalizeRfc8785(result.record)).not.toContain(f.secret);
    await f.finalize();
    s.assertFinalized();
    f.setNow(end);
    s.assertFinalized();
  });
  it("replays before allocation, with no regenerated or returned delivery credential", async () => {
    const f = fixture(),
      p = await prepared(f),
      before = f.counts(),
      s = f.source(),
      r = await s.prepare(f.original);
    expect(r).toEqual({ record: p, outcome: "Original", deliverySecret: null });
    expect(f.counts()).toEqual(before);
    await f.finalize();
    s.assertFinalized();
  });
  it("claims dispatch once and refuses fresh re-dispatch after uncertainty", async () => {
    const f = fixture(),
      c = await claimed(f),
      s = f.source();
    const u = await s.recordInspection({
      ...f.request(),
      expectedVersion: c.version,
      observation: observation(f, "Unknown"),
    });
    await f.finalize();
    s.assertFinalized();
    const before = f.counts(),
      retry = f.source(),
      r = await retry.claimDispatch({ ...f.request(), expectedVersion: 1 });
    expect(r).toEqual({ record: u, outcome: "Original" });
    expect(f.counts()).toEqual(before);
    await f.finalize();
    retry.assertFinalized();
    expect(new Set(f.records.map((x) => x.phaseOperationReference)).size).toBe(3);
    expect(new Set(f.audits.map((x) => x[6])).size).toBe(3);
  });
  it("records NotFound as uncertainty, never unclaims or reallocates", async () => {
    const f = fixture(),
      c = await claimed(f),
      s = f.source();
    const r = await s.recordInspection({
      ...f.request(),
      expectedVersion: c.version,
      observation: observation(f, "NotFound"),
    });
    expect(r.state).toBe("ProviderUnknown");
    expect(r.expiresAt).toBe(end);
    expect(f.counts().generated).toBe(1);
    await f.finalize();
    s.assertFinalized();
  });
  it("stores enabled Provider facts as encrypted bytes, not accepted/MFA/current-account evidence", async () => {
    const f = fixture(),
      c = await claimed(f),
      s = f.source();
    const subject = "controlled-opaque-sub",
      r = await s.recordInspection({
        ...f.request(),
        expectedVersion: c.version,
        observation: observation(f, "Found", {
          username: `bop_${f.original.actorReference}`,
          subject,
          status: "FORCE_CHANGE_PASSWORD",
          enabled: true,
          createdAt: at,
        }),
      });
    expect(r.state).toBe("ProviderObserved");
    expect(r.provider?.enabled).toBe(true);
    expect(canonicalizeRfc8785(r)).not.toContain(subject);
    expect(r.provider?.encryptedSubject.encryptionContext).toContain(f.original.operationReference);
    await f.finalize();
    s.assertFinalized();
  });
  it("records the original expiry without extending or reissuing its secret", async () => {
    const f = fixture(),
      p = await prepared(f);
    f.setNow(end);
    const s = f.source(),
      r = await s.recordExpired({ ...f.request(), expectedVersion: p.version });
    expect(r.state).toBe("Expired");
    expect(r.createdAt).toBe(at);
    expect(r.expiresAt).toBe(end);
    expect(f.counts().generated).toBe(1);
    await f.finalize();
    s.assertFinalized();
  });
  it("does not create Pending or Audit on an autocommit connection", async () => {
    const f = fixture();
    f.autocommit();
    const s = f.source();
    await expect(s.prepare(f.original)).rejects.toThrow();
    expect(f.counts().creatorCalls).toBe(0);
    expect(f.counts().audits).toBe(0);
    await expect(f.finalize()).rejects.toThrow();
  });
  it("requires actual same-tx Pending, not a callback-only successful artifact", async () => {
    const f = fixture(),
      opts = f.options(),
      create = opts.createInvitation;
    const s = createPostgresWorkforceOnboardingOperationStore({
      ...opts,
      async createInvitation(tx, command) {
        const value = await create(tx, command);
        f.removeInvitation();
        return value;
      },
    });
    await expect(s.prepare(f.original)).rejects.toThrow();
    expect(f.audits).toHaveLength(0);
    await expect(f.finalize()).rejects.toThrow();
  });
  it.each(["wrongInvitation", "removeInvitation", "corrupt", "deny", "changeTx"] as const)(
    "poisons caught late %s before real COMMIT",
    async (failure) => {
      const f = fixture(),
        s = f.source();
      await s.prepare(f.original);
      f[failure]();
      await expect(f.finalize()).rejects.toThrow();
      expect(() => s.assertFinalized()).toThrow();
    },
  );
  it("rejects changed approved intent and cross-operation reuse without another allocation", async () => {
    const f = fixture(),
      s = f.source();
    await s.prepare(f.original);
    const before = f.counts();
    await expect(s.prepare({ ...f.original, operationReference: id(999) })).rejects.toThrow();
    expect(f.counts()).toEqual(before);
    await expect(f.finalize()).rejects.toThrow();
    const fresh = fixture();
    await prepared(fresh);
    const replay = fresh.source();
    await expect(
      replay.prepare({ ...fresh.original, approvedPlanDigest: `sha256:${"f".repeat(64)}` }),
    ).rejects.toThrow();
    expect(fresh.counts().generated).toBe(1);
  });
  it("captures the query this and rejects replacement before a foreign query can run", async () => {
    const f = fixture(),
      s = f.source();
    await s.prepare(f.original);
    let foreign = 0;
    f.tx.query = async () => {
      foreign++;
      return { rows: [] };
    };
    await expect(f.finalize()).rejects.toThrow();
    expect(foreign).toBe(0);
  });
  it("refuses malformed preflight caught by caller through registered owning guards", async () => {
    const f = fixture(),
      s = f.source();
    const badRequest = { ...f.request(), extra: true };
    await expect(s.resolveOriginal(badRequest)).rejects.toThrow();
    expect(f.guards).toHaveLength(1);
    await expect(f.finalize()).rejects.toThrow();
  });
  it("refuses stale CAS and observations bound to another Actor without Audit effects", async () => {
    const f = fixture(),
      c = await claimed(f),
      before = f.counts(),
      s = f.source();
    await expect(
      s.recordInspection({
        ...f.request(),
        expectedVersion: c.version,
        observation: { ...observation(f, "Found"), actorReference: id(999) },
      }),
    ).rejects.toThrow();
    expect(f.counts()).toEqual(before);
    const fresh = fixture(),
      p = await prepared(fresh),
      x = fresh.source();
    await expect(
      x.claimDispatch({ ...fresh.request(), expectedVersion: p.version + 1 }),
    ).rejects.toThrow();
    expect(fresh.records).toHaveLength(1);
  });
  it("can read an expired original without regenerating the hash-only delivery secret", async () => {
    const f = fixture(),
      p = await prepared(f),
      before = f.counts();
    f.setNow(end);
    const s = f.source(),
      r = await s.prepare(f.original);
    expect(r).toEqual({ record: p, outcome: "Original", deliverySecret: null });
    expect(f.counts()).toEqual(before);
    await f.finalize();
    s.assertFinalized();
  });
  it("records expired Unknown as uncertainty without making expired Found current evidence", async () => {
    const f = fixture(),
      c = await claimed(f);
    f.setNow("2026-10-06T12:00:06.000Z");
    const s = f.source();
    const r = await s.recordInspection({
      ...f.request(),
      expectedVersion: c.version,
      observation: observation(f, "Unknown"),
    });
    expect(r.state).toBe("ProviderUnknown");
    await f.finalize();
    s.assertFinalized();
    const fresh = fixture(),
      x = await claimed(fresh);
    fresh.setNow("2026-10-06T12:00:06.000Z");
    const positive = fresh.source();
    await expect(
      positive.recordInspection({
        ...fresh.request(),
        expectedVersion: x.version,
        observation: observation(fresh, "Found", {
          username: `bop_${fresh.original.actorReference}`,
          subject: "controlled-sub",
          status: "CONFIRMED",
          enabled: true,
          createdAt: at,
        }),
      }),
    ).rejects.toThrow();
    expect(fresh.records).toHaveLength(2);
  });
  it("rejects a creator changing the genuine transaction before Audit is appended", async () => {
    const f = fixture(),
      opts = f.options(),
      create = opts.createInvitation;
    const s = createPostgresWorkforceOnboardingOperationStore({
      ...opts,
      async createInvitation(tx, command) {
        const result = await create(tx, command);
        f.changeTx();
        return result;
      },
    });
    await expect(s.prepare(f.original)).rejects.toThrow();
    expect(f.audits).toHaveLength(0);
    await expect(f.finalize()).rejects.toThrow();
  });
  it("binds current approval to the exact action and normalized request digest", async () => {
    const f = fixture(),
      opts = f.options(),
      hold = opts.authority.hold;
    const s = createPostgresWorkforceOnboardingOperationStore({
      ...opts,
      authority: {
        async hold(tx, request) {
          const packet = await hold(tx, request);
          return { ...packet, action: "ClaimDispatch" };
        },
      },
    });
    await expect(s.prepare(f.original)).rejects.toThrow();
    expect(f.counts().generated).toBe(0);
    await expect(f.finalize()).rejects.toThrow();
  });
  it("poisons reentry while current authority is awaited", async () => {
    const f = fixture(),
      opts = f.options(),
      hold = opts.authority.hold;
    const source = createPostgresWorkforceOnboardingOperationStore({
      ...opts,
      authority: {
        async hold(tx, request) {
          await expect(source.resolveOriginal(f.request())).rejects.toThrow();
          return hold(tx, request);
        },
      },
    });
    await expect(source.prepare(f.original)).rejects.toThrow();
    expect(f.records).toHaveLength(0);
    await expect(f.finalize()).rejects.toThrow();
  });
  it("rejects nested Provider accessors before digesting or calling approval", async () => {
    const f = fixture(),
      c = await claimed(f),
      s = f.source();
    let reads = 0;
    const raw: unknown[] = [];
    Object.defineProperty(raw, "0", {
      enumerable: true,
      get() {
        reads++;
        return "forbidden";
      },
    });
    await expect(
      s.recordInspection({
        ...f.request(),
        expectedVersion: c.version,
        observation: observation(f, "Found", raw),
      }),
    ).rejects.toThrow();
    expect(reads).toBe(0);
    expect(f.records).toHaveLength(2);
    await expect(f.finalize()).rejects.toThrow();
  });
  it("does not renew the original five-second holder during final checks", async () => {
    const f = fixture(),
      s = f.source();
    await s.prepare(f.original);
    f.setNow("2026-10-06T12:00:05.000Z");
    await expect(f.finalize()).rejects.toThrow();
  });
});
