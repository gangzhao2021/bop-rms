import { describe, expect, it, vi } from "vitest";
import { createIdentityActor, parseCanonicalInstant } from "../contracts/identity-actor.js";
import {
  createWorkforceInvitation,
  type WorkforceInvitation,
} from "../contracts/workforce-identity-security.js";
import {
  createPostgresWorkforceInvitationStore,
  type WorkforceInvitationBinding,
  type WorkforceInvitationStoreOptions,
  type WorkforceInvitationTransaction,
} from "../infrastructure/persistence/workforce-invitation-store.js";
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const origin = "2026-10-06T12:00:00.000Z",
  end = "2026-10-06T12:00:05.000Z";
const denied = { code: "WORKFORCE_SECURITY_DENIED" };
function fixture(action: WorkforceInvitationBinding["action"] = "IssueInvitation") {
  const binding: WorkforceInvitationBinding = {
    operatorReference: action === "AcceptInvitation" ? id(2) : id(3),
    actorReference: id(2),
    membershipReference: id(4),
    purposeCode: "WORKFORCE_ONBOARDING",
    action,
    operationReference: id(5),
    correlationReference: id(6),
  };
  const invitation = createWorkforceInvitation({
    invitationReference: id(1),
    actorReference: id(2),
    inviterActorReference: id(3),
    membershipReference: id(4),
    storeAssignmentReferences: [id(7)],
    emailDigest: "a".repeat(64),
    selectorHash: "b".repeat(64),
    status: "Pending",
    createdAt: origin,
    expiresAt: "2026-10-07T12:00:00.000Z",
    consumedAt: null,
    providerEvidenceReference: null,
    version: 1,
  });
  let fact: WorkforceInvitation | null = action === "AcceptInvitation" ? invitation : null,
    time = origin,
    allowed = true,
    until = end,
    isolation = "read committed",
    txid = "501",
    override: unknown = undefined;
  let patch: Record<string, unknown> = {},
    queryHook: ((sql: string) => Promise<void>) | undefined;
  const calls: { sql: string; values: readonly unknown[] }[] = [],
    authorities: string[] = [];
  const encode = (saved: WorkforceInvitation) => ({
    invitation_id: saved.invitationReference,
    actor_id: saved.actorReference,
    inviter_actor_id: saved.inviterActorReference,
    membership_id: saved.membershipReference,
    store_assignment_ids: saved.storeAssignmentReferences,
    email_digest: saved.emailDigest,
    selector_hash: saved.selectorHash,
    status: saved.status,
    created_at: saved.createdAt,
    expires_at: saved.expiresAt,
    consumed_at: saved.consumedAt,
    provider_evidence_id: saved.providerEvidenceReference,
    version: saved.version,
    precise: true,
  });
  // Controlled owning SQL/authority/Audit boundaries, actual public parsers.
  // No external approved onboarding or deployed transaction evidence asserted.
  const tx: WorkforceInvitationTransaction = {
    async query(sql, values) {
      calls.push({ sql, values });
      await queryHook?.(sql);
      if (sql.includes("AS isolation")) return { rows: [{ isolation, transaction_id: txid }] };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.startsWith("INSERT INTO")) {
        if (fact) throw new Error("controlled duplicate");
        fact = invitation;
      }
      if (sql.startsWith("UPDATE")) {
        if (!fact || fact.status !== "Pending" || values[3] !== fact.version) return { rows: [] };
        fact = createWorkforceInvitation({
          ...fact,
          status: "Accepted",
          consumedAt: values[4],
          providerEvidenceReference: values[5],
          version: fact.version + 1,
        });
      }
      if (sql.includes("bop_identity.workforce_invitation"))
        return override ?? { rows: fact ? [{ ...encode(fact), ...patch }] : [] };
      throw new Error("unexpected controlled SQL");
    },
  };
  let guard: (() => Promise<void>) | undefined, final: (() => void) | undefined;
  const audit = vi.fn(async () => undefined);
  const register = vi.fn(
    async (actual: WorkforceInvitationTransaction, g: () => Promise<void>, f: () => void) => {
      expect(actual).toBe(tx);
      guard = g;
      final = f;
    },
  );
  const operator = createIdentityActor({
    actorType: "User",
    actorReference: binding.operatorReference,
    accountKind: action === "AcceptInvitation" ? "Workforce" : "Platform",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "RecentMfa",
    authenticatedAt: origin,
    recentMfaAt: origin,
  });
  const options: WorkforceInvitationStoreOptions = {
    transaction: tx,
    binding,
    clock: { now: () => time },
    originalObservedAt: origin,
    originalValidUntil: end,
    authority: {
      async hold(actual, input) {
        expect(actual).toBe(tx);
        if (!allowed) throw new Error("controlled current authority denied");
        authorities.push(input.requestDigest);
        return {
          binding: input.binding,
          requestDigest: input.requestDigest,
          operator,
          validUntil: until < input.validUntil ? until : input.validUntil,
        };
      },
    },
    appendAudit: audit,
    registerBeforeCommit: register,
  };
  const source = createPostgresWorkforceInvitationStore(options);
  const issue = {
    invitationReference: invitation.invitationReference,
    actorReference: invitation.actorReference,
    inviterActorReference: invitation.inviterActorReference,
    membershipReference: invitation.membershipReference,
    storeAssignmentReferences: invitation.storeAssignmentReferences,
    emailDigest: invitation.emailDigest,
    selectorHash: invitation.selectorHash,
    observedAt: parseCanonicalInstant(origin),
  };
  const pending = {
    selectorHash: invitation.selectorHash,
    emailDigest: invitation.emailDigest,
    actorReference: invitation.actorReference,
    membershipReference: invitation.membershipReference,
  };
  const consume = {
    ...pending,
    invitationReference: invitation.invitationReference,
    expectedVersion: 1,
    providerEvidenceReference: id(8),
    observedAt: origin,
  };
  return {
    source,
    options,
    tx,
    issue,
    pending,
    consume,
    invitation,
    calls,
    authorities,
    audit,
    register,
    async guard() {
      if (!guard) throw new Error("missing owning guard");
      await guard();
    },
    final() {
      if (!final) throw new Error("missing final seal");
      final();
    },
    time(v: string) {
      time = v;
    },
    allow(v: boolean) {
      allowed = v;
    },
    until(v: string) {
      until = v;
    },
    patch(v: Record<string, unknown>) {
      patch = v;
    },
    row(v: unknown) {
      override = v;
    },
    fact(v: WorkforceInvitation | null) {
      fact = v;
    },
    txid(v: string) {
      txid = v;
    },
    isolation(v: string) {
      isolation = v;
    },
    hook(v: (sql: string) => Promise<void>) {
      queryHook = v;
    },
    current: () => fact,
  };
}
describe("borrowed workforce invitation writer", () => {
  it("creates only caller-supplied Pending invitation, exact 24h, captured tx Audit and final proof", async () => {
    const f = fixture(),
      result = await f.source.createInvitation(f.issue);
    expect(result).toEqual(f.invitation);
    expect(f.register).toHaveBeenCalledTimes(1);
    expect(f.audit).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        operation: "InvitationIssued",
        actorReference: id(3),
        targetActorReference: id(2),
        idempotencyKey: id(5),
        purposeCode: "WORKFORCE_ONBOARDING",
      }),
    );
    const admission = f.calls.find((c) => c.sql.includes("pg_advisory_xact_lock"));
    expect(admission?.values).toEqual([id(2), id(4)]);
    expect(f.calls.findIndex((c) => c.sql.includes("pg_advisory_xact_lock"))).toBeLessThan(
      f.calls.findIndex((c) => c.sql.startsWith("INSERT")),
    );
    expect(f.calls.some((c) => c.sql.startsWith("LOCK TABLE"))).toBe(false);
    expect(new Set(f.authorities).size).toBe(1);
    expect(f.authorities[0]).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(result).not.toHaveProperty("selector");
    expect(result).not.toHaveProperty("corporateEmail");
    await f.guard();
    f.final();
    f.time("2026-10-07T12:00:00.000Z");
    f.source.assertFinalized();
  });
  it("reads exact Pending then accepts same Actor/Member/email/version once, pins updated fact", async () => {
    const f = fixture("AcceptInvitation");
    expect(await f.source.readPending(f.pending)).toEqual(f.invitation);
    const accepted = await f.source.consumeInvitation(f.consume);
    expect(accepted).toMatchObject({
      status: "Accepted",
      version: 2,
      consumedAt: origin,
      providerEvidenceReference: id(8),
    });
    expect(f.register).toHaveBeenCalledTimes(1);
    expect(f.audit).toHaveBeenCalledTimes(1);
    expect(f.audit).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        operation: "InvitationAccepted",
        actorReference: id(2),
        targetActorReference: id(2),
      }),
    );
    await f.guard();
    f.final();
    f.source.assertFinalized();
  });
  it("keeps actual absence null without claiming Abandoned or accepted", async () => {
    const f = fixture();
    expect(await f.source.readPending(f.pending)).toBeNull();
    expect(f.audit).not.toHaveBeenCalled();
    await f.guard();
    f.final();
    f.source.assertFinalized();
  });
  it.each(["actor", "member", "inviter", "time", "rawEmail", "action"])(
    "refuses wrong %s before write and poisons caught failure",
    async (kind) => {
      const f = fixture(kind === "action" ? "AcceptInvitation" : "IssueInvitation"),
        foreign = createWorkforceInvitation({
          ...f.invitation,
          actorReference: id(90),
          membershipReference: id(90),
          inviterActorReference: id(90),
        }),
        request = {
          ...f.issue,
          ...(kind === "actor"
            ? { actorReference: foreign.actorReference }
            : kind === "member"
              ? { membershipReference: foreign.membershipReference }
              : kind === "inviter"
                ? { inviterActorReference: foreign.inviterActorReference }
                : kind === "time"
                  ? { observedAt: parseCanonicalInstant("2026-10-06T12:00:00.001Z") }
                  : kind === "rawEmail"
                    ? { corporateEmail: "forbidden" }
                    : {}),
        };
      await expect(f.source.createInvitation(request)).rejects.toMatchObject(denied);
      expect(f.calls.some((c) => c.sql.startsWith("INSERT"))).toBe(false);
      expect(f.audit).not.toHaveBeenCalled();
      await expect(f.guard()).rejects.toMatchObject(denied);
      expect(() => f.final()).toThrow();
    },
  );
  it.each(["version", "selector", "email", "accepted", "expired", "provider"])(
    "refuses consume %s mismatch with no mutation/Audit",
    async (kind) => {
      const f = fixture("AcceptInvitation");
      if (kind === "accepted")
        f.fact(
          createWorkforceInvitation({
            ...f.invitation,
            status: "Accepted",
            version: 2,
            consumedAt: origin,
            providerEvidenceReference: id(8),
          }),
        );
      if (kind === "expired")
        f.fact(
          createWorkforceInvitation({
            ...f.invitation,
            createdAt: "2026-10-05T12:00:00.000Z",
            expiresAt: origin,
          }),
        );
      const request = {
        ...f.consume,
        ...(kind === "version"
          ? { expectedVersion: 2 }
          : kind === "selector"
            ? { selectorHash: "c".repeat(64) }
            : kind === "email"
              ? { emailDigest: "c".repeat(64) }
              : kind === "provider"
                ? { providerEvidenceReference: "invalid" }
                : {}),
      };
      await expect(f.source.consumeInvitation(request)).rejects.toMatchObject(denied);
      expect(f.calls.some((c) => c.sql.startsWith("UPDATE"))).toBe(false);
      expect(f.audit).not.toHaveBeenCalled();
      await expect(f.guard()).rejects.toMatchObject(denied);
    },
  );
  it("never invokes an array getter, and registers guard before a malformed request", async () => {
    const f = fixture(),
      getter = vi.fn(() => id(7)),
      array: (typeof f.issue)["storeAssignmentReferences"] = [];
    Object.defineProperty(array, "0", { enumerable: true, get: getter });
    await expect(
      f.source.createInvitation({ ...f.issue, storeAssignmentReferences: array }),
    ).rejects.toMatchObject(denied);
    expect(getter).not.toHaveBeenCalled();
    expect(f.register).toHaveBeenCalledTimes(1);
    await expect(f.guard()).rejects.toMatchObject(denied);
  });
  it.each(["precision", "extra", "rowgetter", "sparse", "status"])(
    "rejects corrupt actual %s row",
    async (kind) => {
      const f = fixture("AcceptInvitation");
      if (kind === "precision") f.patch({ precise: false });
      if (kind === "extra") f.patch({ unexpected: true });
      if (kind === "status") f.patch({ provider_evidence_id: id(8) });
      const getter = vi.fn(() => ({}));
      if (kind === "rowgetter") {
        const rows: unknown[] = [];
        Object.defineProperty(rows, "0", { enumerable: true, get: getter });
        f.row({ rows });
      }
      if (kind === "sparse") f.row({ rows: new Array(1) });
      await expect(f.source.readPending(f.pending)).rejects.toMatchObject(denied);
      expect(getter).not.toHaveBeenCalled();
      await expect(f.guard()).rejects.toMatchObject(denied);
    },
  );
  it("rejects changed authority request digest and cannot use generic approval", async () => {
    const f = fixture(),
      original = f.options.authority.hold;
    f.options.authority.hold = async (tx, input) => ({
      ...(await original(tx, input)),
      requestDigest: `sha256:${"0".repeat(64)}`,
    });
    // Port replacement is also forbidden; construct a fresh holder capturing it.
    const source = createPostgresWorkforceInvitationStore(f.options);
    await expect(source.createInvitation(f.issue)).rejects.toMatchObject(denied);
    expect(f.audit).not.toHaveBeenCalled();
  });
  it("final async withdrawal after real leaf writes still refuses caught commit", async () => {
    const f = fixture();
    await f.source.createInvitation(f.issue);
    expect(f.current()).not.toBeNull();
    f.allow(false);
    await expect(f.guard()).rejects.toMatchObject(denied);
    f.allow(true);
    expect(() => f.final()).toThrow();
  });
  it("poisons a caught final clock exception even when clock is subsequently repaired", async () => {
    const f = fixture();
    await f.source.createInvitation(f.issue);
    await f.guard();
    f.time("not-an-instant");
    expect(() => f.final()).toThrow();
    f.time(origin);
    expect(() => f.final()).toThrow();
  });
  it("uses shortest authority deadline and rejects expired final without lease renewal", async () => {
    const f = fixture();
    f.until("2026-10-06T12:00:00.100Z");
    await f.source.createInvitation(f.issue);
    await f.guard();
    f.time("2026-10-06T12:00:00.100Z");
    expect(() => f.final()).toThrow();
  });
  it("Pending expiry is a business boundary independent of the original 5s authority", async () => {
    const f = fixture("AcceptInvitation");
    f.fact(
      createWorkforceInvitation({
        ...f.invitation,
        createdAt: "2026-10-05T12:00:00.250Z",
        expiresAt: "2026-10-06T12:00:00.250Z",
      }),
    );
    await f.source.readPending(f.pending);
    await f.guard();
    f.time("2026-10-06T12:00:00.250Z");
    expect(() => f.final()).toThrow();
  });
  it("rejects post-write malformed returned row and catches cannot commit prior owner effects", async () => {
    const f = fixture();
    f.hook(async (sql) => {
      if (sql.startsWith("INSERT")) f.patch({ precise: false });
    });
    await expect(f.source.createInvitation(f.issue)).rejects.toMatchObject(denied);
    expect(f.current()).not.toBeNull();
    expect(f.audit).not.toHaveBeenCalled();
    await expect(f.guard()).rejects.toMatchObject(denied);
  });
  it("Audit failure poisons actual same transaction despite successful owner insert", async () => {
    const f = fixture();
    f.audit.mockRejectedValue(new Error("controlled audit failure"));
    await expect(f.source.createInvitation(f.issue)).rejects.toMatchObject(denied);
    expect(f.current()).not.toBeNull();
    await expect(f.guard()).rejects.toMatchObject(denied);
    expect(() => f.final()).toThrow();
  });
  it.each(["actor", "membership", "action", "mfa"])(
    "exact current %s authority cannot change request qualification",
    async (kind) => {
      const f = fixture(),
        hold = f.options.authority.hold;
      f.options.authority.hold = async (tx, input) => {
        const result = await hold(tx, input);
        return {
          ...result,
          ...(kind === "mfa"
            ? {
                operator: createIdentityActor({
                  ...result.operator,
                  verificationLevel: "SingleFactor",
                  recentMfaAt: null,
                }),
              }
            : {
                binding: {
                  ...result.binding,
                  ...(kind === "actor"
                    ? { actorReference: id(90) }
                    : kind === "membership"
                      ? { membershipReference: id(90) }
                      : { action: "AcceptInvitation" as const }),
                },
              }),
        };
      };
      const source = createPostgresWorkforceInvitationStore(f.options);
      await expect(source.createInvitation(f.issue)).rejects.toMatchObject(denied);
      expect(f.calls.some((c) => c.sql.startsWith("INSERT"))).toBe(false);
      await expect(f.guard()).rejects.toMatchObject(denied);
    },
  );
  it("rejects a duplicate Pending database insert without generating another invitation", async () => {
    const f = fixture();
    f.fact(f.invitation);
    await expect(f.source.createInvitation(f.issue)).rejects.toMatchObject(denied);
    expect(f.audit).not.toHaveBeenCalled();
    expect(f.calls.filter((c) => c.sql.startsWith("INSERT"))).toHaveLength(1);
    await expect(f.guard()).rejects.toMatchObject(denied);
  });
  it("rejects autocommit transaction drift before any owner mutation", async () => {
    const f = fixture();
    let statements = 0;
    f.hook(async (sql) => {
      if (sql.includes("AS isolation")) f.txid(String(501 + statements++));
    });
    await expect(f.source.createInvitation(f.issue)).rejects.toMatchObject(denied);
    expect(f.calls.some((call) => call.sql.startsWith("INSERT"))).toBe(false);
    expect(f.audit).not.toHaveBeenCalled();
    await expect(f.guard()).rejects.toMatchObject(denied);
  });
  it.each(["tx", "isolation", "query"])("refuses %s drift on awaited boundary", async (kind) => {
    const f = fixture();
    await f.source.createInvitation(f.issue);
    if (kind === "tx") f.txid("502");
    if (kind === "isolation") f.isolation("repeatable read");
    const foreign = vi.fn(async () => ({ rows: [] }));
    if (kind === "query")
      f.hook(async (sql) => {
        if (sql.includes("AS isolation")) f.tx.query = foreign;
      });
    await expect(f.guard()).rejects.toMatchObject(denied);
    expect(foreign).not.toHaveBeenCalled();
  });
  it("refuses duplicate write, reentry and early pure assertion permanently", async () => {
    const f = fixture();
    await f.source.createInvitation(f.issue);
    await expect(f.source.createInvitation(f.issue)).rejects.toMatchObject(denied);
    await expect(f.guard()).rejects.toMatchObject(denied);
    const g = fixture();
    g.hook(async (sql) => {
      if (sql.includes("pg_advisory_xact_lock"))
        await expect(g.source.readPending(g.pending)).rejects.toMatchObject(denied);
    });
    await expect(g.source.createInvitation(g.issue)).rejects.toMatchObject(denied);
    const h = fixture();
    await h.source.createInvitation(h.issue);
    expect(() => h.source.assertFinalized()).toThrow();
    await expect(h.guard()).rejects.toMatchObject(denied);
  });
});
