import { expect, it, vi } from "vitest";
import { createAuthenticationSession, createIdentityActor } from "@bop/identity";
import {
  createPostgresMembershipBrandDiscoverySource,
  type MembershipBrandDiscoverySourceOptions,
} from "../infrastructure/persistence/brand-discovery-store.js";
import type { MembershipReadTransaction } from "../infrastructure/persistence/current-membership-store.js";
const id = (n: number) => `01903100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T12:00:05.000Z";
function session(actorReference = id(1), verifiedAt = at) {
  const actor = createIdentityActor({
    actorType: "User",
    actorReference,
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "RecentMfa",
    authenticatedAt: verifiedAt,
    recentMfaAt: verifiedAt,
  });
  return createAuthenticationSession({
    sessionReference: id(20),
    actor,
    status: "Active",
    policyCode: "WorkforceStandard",
    maxActiveSessions: 5,
    idleTimeoutMinutes: 30,
    absoluteTimeoutMinutes: 720,
    version: 1,
    authenticatedAt: verifiedAt,
    createdAt: verifiedAt,
    lastSeenAt: verifiedAt,
    idleExpiresAt: new Date(Date.parse(verifiedAt) + 1800000).toISOString(),
    absoluteExpiresAt: new Date(Date.parse(verifiedAt) + 43200000).toISOString(),
    rotatedFromSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  });
}
/** Controlled SQL/current-Session protocol boundaries only. Real RLS/table
 * fences and current-account/session producers require the owning native case. */
function fixture() {
  const state = {
    now: at,
    ids: [id(2), id(3), id(4)],
    transition: null as string | null,
    until,
    session: session(),
    allowed: true,
    malformed: false,
    onNow: () => undefined,
  };
  const log: string[] = [];
  const query = vi.fn(async (sql: string, _values: readonly unknown[]): Promise<unknown> => {
    void _values;
    log.push(sql);
    if (sql.includes("transaction_isolation")) return { rows: [{ isolation: "read committed" }] };
    if (sql.includes("membership_brand_discovery_read"))
      return state.malformed
        ? { rows: [{ brand_references: [id(3), id(2)], transition_at: null }] }
        : { rows: [{ brand_references: state.ids, transition_at: state.transition }] };
    return { rows: [] };
  });
  const tx: MembershipReadTransaction = { query };
  let guard: () => Promise<void> = async () => {
      throw new Error("unregistered guard");
    },
    final: () => void = () => {
      throw new Error("unregistered final");
    };
  const hold = vi.fn(
    async (
      actual: MembershipReadTransaction,
      request: {
        actorReference: string;
        purposeCode: string;
        observedAt: string;
        validUntil: string;
      },
    ) => {
      expect(actual).toBe(tx);
      expect(request.actorReference).toBe(id(1));
      expect(request.purposeCode).toBe("BRAND_DISCOVERY");
      if (!state.allowed) throw new Error("controlled Session withdrawal");
      return { session: state.session, validUntil: state.until };
    },
  );
  const register = vi.fn(
    (actual: MembershipReadTransaction, g: () => Promise<void>, f: () => void) => {
      expect(actual).toBe(tx);
      guard = g;
      final = f;
    },
  );
  const options: MembershipBrandDiscoverySourceOptions = {
    transaction: tx,
    actorReference: id(1),
    clock: {
      now: () => {
        state.onNow();
        return state.now;
      },
    },
    originalObservedAt: at,
    originalValidUntil: until,
    authority: { holdUntilTransactionCompletes: hold },
    registerBeforeCommit: register,
  };
  const source = createPostgresMembershipBrandDiscoverySource(options);
  return {
    state,
    source,
    options,
    query,
    tx,
    log,
    hold,
    register,
    guard: () => guard(),
    final: () => final(),
    async finish() {
      await guard();
      final();
      source.assertFinalized();
    },
  };
}
it("holds sorted distinct scanned IDs and original cursor in the actual transaction before COMMIT", async () => {
  const f = fixture(),
    page = await f.source.holdPage({ afterBrandReference: null, limit: 2 });
  expect(page.brandReferences).toEqual([id(2), id(3)]);
  expect(page.hasMore).toBe(true);
  expect(page.nextAfterBrandReference).toBe(id(3));
  await f.finish();
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(f.hold).toHaveBeenCalledTimes(2);
  expect(f.log.filter((q) => q.includes("membership_brand_discovery_read"))).toHaveLength(2);
  expect(f.log.some((q) => q.includes("INSERT") || q.includes("UPDATE"))).toBe(false);
  f.state.now = until;
  f.source.assertFinalized();
});
it("protects genuinely empty pages and rejects an absent-to-present phantom at the final reread", async () => {
  const empty = fixture();
  empty.state.ids = [];
  expect((await empty.source.holdPage({ afterBrandReference: id(8), limit: 20 })).hasMore).toBe(
    false,
  );
  await empty.finish();
  const changed = fixture();
  changed.state.ids = [];
  await changed.source.holdPage({ afterBrandReference: null, limit: 20 });
  changed.state.ids = [id(2)];
  await expect(changed.guard()).rejects.toThrow();
  expect(changed.final).toThrow();
});
it("shortens the held lease for actual Membership activation or expiration boundaries without renewing it", async () => {
  const f = fixture();
  f.state.transition = "2026-10-06T12:00:02.000Z";
  const page = await f.source.holdPage({ afterBrandReference: null, limit: 2 });
  expect(page.validUntil).toBe(f.state.transition);
  f.state.now = "2026-10-06T12:00:01.000Z";
  await f.guard();
  f.state.now = f.state.transition;
  expect(f.final).toThrow();
});
it.each(["Session", "Actor", "Mfa", "clock", "query", "row"])(
  "poisons caught late %s refusal and cannot finalize",
  async (mode) => {
    const f = fixture();
    await f.source.holdPage({ afterBrandReference: null, limit: 2 });
    if (mode === "Session") f.state.allowed = false;
    if (mode === "Actor") f.state.session = session(id(9));
    if (mode === "Mfa") f.state.session = session(id(1), "2026-10-06T11:45:00.000Z");
    if (mode === "clock") f.state.now = "2026-10-06T11:59:59.999Z";
    if (mode === "query") f.tx.query = vi.fn(async () => ({ rows: [] }));
    if (mode === "row") f.state.malformed = true;
    await expect(f.guard()).rejects.toThrow();
    expect(f.final).toThrow();
    expect(() => f.source.assertFinalized()).toThrow();
  },
);
it("registers the poison guard before invalid input and prevents caught failure reuse", async () => {
  const f = fixture();
  await expect(f.source.holdPage({ afterBrandReference: null, limit: 21 })).rejects.toThrow();
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(f.query).not.toHaveBeenCalled();
  await expect(f.guard()).rejects.toThrow();
  expect(f.final).toThrow();
  await expect(f.source.holdPage({ afterBrandReference: null, limit: 2 })).rejects.toThrow();
});
it("refuses repeated page calls and early final assertions permanently", async () => {
  const f = fixture();
  await f.source.holdPage({ afterBrandReference: null, limit: 2 });
  await expect(f.source.holdPage({ afterBrandReference: null, limit: 2 })).rejects.toThrow();
  await expect(f.guard()).rejects.toThrow();
  const early = fixture();
  expect(() => early.source.assertFinalized()).toThrow();
  await expect(early.source.holdPage({ afterBrandReference: null, limit: 2 })).rejects.toThrow();
});
it("never invokes a replacement query installed by the clock port", async () => {
  const f = fixture(),
    foreign = vi.fn(async () => ({ rows: [] }));
  f.state.onNow = () => {
    f.tx.query = foreign;
    return undefined;
  };
  await expect(f.source.holdPage({ afterBrandReference: null, limit: 2 })).rejects.toThrow();
  expect(foreign).not.toHaveBeenCalled();
  expect(f.query).not.toHaveBeenCalled();
});
it("refuses already expired same-session MFA before owning Membership reads", async () => {
  const f = fixture();
  f.state.session = session(id(1), "2026-10-06T11:45:00.000Z");
  await expect(f.source.holdPage({ afterBrandReference: null, limit: 2 })).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
  await expect(f.guard()).rejects.toThrow();
});
it("retains the original shortest Session authority lease even when a later hold offers a longer deadline", async () => {
  const f = fixture();
  f.state.until = "2026-10-06T12:00:02.000Z";
  expect((await f.source.holdPage({ afterBrandReference: null, limit: 2 })).validUntil).toBe(
    f.state.until,
  );
  f.state.until = until;
  f.state.now = "2026-10-06T12:00:01.000Z";
  await f.guard();
  f.state.now = "2026-10-06T12:00:02.000Z";
  expect(f.final).toThrow();
});
it("poisons caught callback reentry and never evaluates SQL array getters", async () => {
  const reentry = fixture();
  reentry.hold.mockImplementation(async () => {
    await expect(
      reentry.source.holdPage({ afterBrandReference: null, limit: 2 }),
    ).rejects.toThrow();
    return { session: reentry.state.session, validUntil: until };
  });
  await expect(reentry.source.holdPage({ afterBrandReference: null, limit: 2 })).rejects.toThrow();
  expect(reentry.query).not.toHaveBeenCalled();
  await expect(reentry.guard()).rejects.toThrow();
  const getter = fixture();
  let reads = 0;
  Object.defineProperty(getter.state.ids, "0", {
    enumerable: true,
    get() {
      reads++;
      return id(2);
    },
  });
  await expect(getter.source.holdPage({ afterBrandReference: null, limit: 2 })).rejects.toThrow();
  expect(reads).toBe(0);
  await expect(getter.guard()).rejects.toThrow();
});

it("revalidates the normalized Session policy without accepting extra fields or invoking accessors", async () => {
  const extra = fixture();
  extra.hold.mockImplementation(async () => ({
    session: Object.freeze({ ...extra.state.session, unexpected: true }),
    validUntil: until,
  }));
  await expect(extra.source.holdPage({ afterBrandReference: null, limit: 2 })).rejects.toThrow();
  expect(extra.query).not.toHaveBeenCalled();
  await expect(extra.guard()).rejects.toThrow();

  const getter = fixture();
  let reads = 0;
  const policy = { ...getter.state.session.policy };
  Object.defineProperty(policy, "code", {
    enumerable: true,
    get() {
      reads++;
      return "WorkforceStandard";
    },
  });
  getter.hold.mockImplementation(async () => ({
    session: Object.freeze({ ...getter.state.session, policy }),
    validUntil: until,
  }));
  await expect(getter.source.holdPage({ afterBrandReference: null, limit: 2 })).rejects.toThrow();
  expect(reads).toBe(0);
  expect(getter.query).not.toHaveBeenCalled();
  await expect(getter.guard()).rejects.toThrow();
});
