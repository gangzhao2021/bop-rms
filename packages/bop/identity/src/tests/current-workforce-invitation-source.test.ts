import { describe, expect, it, vi } from "vitest";
import {
  createPostgresCurrentWorkforceInvitationSource,
  type CurrentWorkforceInvitationAuthority,
  type CurrentWorkforceInvitationSourceOptions,
  type CurrentWorkforceInvitationTransaction,
} from "../infrastructure/persistence/current-workforce-invitation-source.js";

const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z";
const deadline = "2026-10-06T12:00:05.000Z";
const denied = { code: "WORKFORCE_SECURITY_DENIED" };

function fixture() {
  // Historical controlled SQL facts: the original invitation's Membership is
  // intentionally independent of any prospective new Brand Membership.
  let row: Record<string, unknown> = {
      invitation_id: id(1),
      actor_id: id(2),
      membership_id: id(3),
      status: "Accepted",
      provider_evidence_id: id(4),
      version: 2,
      created_at: "2026-01-01T12:00:00.000Z",
      expires_at: "2026-01-02T12:00:00.000Z",
      consumed_at: "2026-01-01T13:00:00.000Z",
      precise: true,
    },
    time = at,
    transactionId = "901",
    isolation = "read committed",
    allowed = true,
    until = deadline,
    rows: unknown = undefined,
    queryHook: ((sql: string) => Promise<void>) | undefined,
    authorityHook: (() => Promise<void>) | undefined,
    authorityPatch: Record<string, unknown> = {};
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const tx: CurrentWorkforceInvitationTransaction = {
    async query(sql, values) {
      calls.push({ sql, values });
      await queryHook?.(sql);
      if (sql.includes("AS isolation"))
        return { rows: [{ isolation, transaction_id: transactionId }] };
      if (sql.includes("FROM bop_identity.workforce_invitation"))
        return rows ?? { rows: [{ ...row }] };
      throw new Error("unexpected controlled SQL");
    },
  };
  let guard: (() => Promise<void>) | undefined,
    final: (() => void) | undefined,
    registrations = 0;
  const options = {
    transaction: tx,
    binding: {
      actorReference: id(2),
      invitationReference: id(1),
      purposeCode: "BRAND_INITIAL_PROVISIONING" as const,
    },
    clock: { now: () => time },
    originalObservedAt: at,
    originalValidUntil: deadline,
    authority: {
      hold: vi.fn(
        async (
          actual: CurrentWorkforceInvitationTransaction,
          input: Parameters<CurrentWorkforceInvitationSourceOptions["authority"]["hold"]>[1],
        ): Promise<CurrentWorkforceInvitationAuthority> => {
          expect(actual).toBe(tx);
          await authorityHook?.();
          if (!allowed) throw new Error("controlled private authority failure");
          return {
            ...input.binding,
            observedAt: input.observedAt,
            validUntil: until < input.validUntil ? until : input.validUntil,
            ...authorityPatch,
          };
        },
      ),
    },
    registerBeforeCommit: async (
      actual: CurrentWorkforceInvitationTransaction,
      g: () => Promise<void>,
      f: () => void,
    ) => {
      expect(actual).toBe(tx);
      registrations++;
      guard = g;
      final = f;
    },
  } satisfies CurrentWorkforceInvitationSourceOptions;
  const source = createPostgresCurrentWorkforceInvitationSource(options);
  return {
    source,
    tx,
    options,
    calls,
    registrations: () => registrations,
    setRow: (patch: Record<string, unknown>) => {
      row = { ...row, ...patch };
    },
    setRows: (value: unknown) => {
      rows = value;
    },
    setTime: (value: string) => {
      time = value;
    },
    setTransaction: (value: string) => {
      transactionId = value;
    },
    setIsolation: (value: string) => {
      isolation = value;
    },
    withdraw: () => {
      allowed = false;
    },
    setUntil: (value: string) => {
      until = value;
    },
    patchAuthority: (value: Record<string, unknown>) => {
      authorityPatch = value;
    },
    onQuery: (hook: (sql: string) => Promise<void>) => {
      queryHook = hook;
    },
    onAuthority: (hook: () => Promise<void>) => {
      authorityHook = hook;
    },
    async guard() {
      if (!guard) throw new Error("missing actual host guard");
      await guard();
    },
    final() {
      if (!final) throw new Error("missing actual host final seal");
      final();
    },
  };
}

describe("current Workforce invitation source", () => {
  it("holds minimized historical acceptance with its original Membership and no new authority", async () => {
    const f = fixture(),
      evidence = await f.source.hold();
    expect(evidence).toEqual({
      profile: "CurrentWorkforceInvitationEvidenceV1",
      invitationReference: id(1),
      actorReference: id(2),
      originalMembershipReference: id(3),
      providerEvidenceReference: id(4),
      status: "Accepted",
      version: 2,
      createdAt: "2026-01-01T12:00:00.000Z",
      expiresAt: "2026-01-02T12:00:00.000Z",
      consumedAt: "2026-01-01T13:00:00.000Z",
      observedAt: at,
      validUntil: deadline,
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    const sql = f.calls.find((call) => call.sql.includes("FROM bop_identity.workforce_invitation"));
    expect(sql?.values).toEqual([id(1), id(2)]);
    expect(sql?.sql).toContain("WHERE invitation_id=$1 AND actor_id=$2 FOR SHARE");
    expect(sql?.sql).toContain("date_trunc('milliseconds'");
    expect(sql?.sql).toContain("isfinite(created_at)");
    expect(sql?.sql).toContain("created_at>=TIMESTAMPTZ '0001-01-01");
    expect(sql?.sql).toContain("consumed_at<TIMESTAMPTZ '10000-01-01");
    expect(sql?.sql).not.toMatch(
      /email_digest|selector_hash|store_assignment|inviter_actor|SELECT \*/,
    );
    expect(() => f.source.assertFinalized()).toThrow();
    await f.guard();
    f.final();
    // The actual host has committed: this assertion must not reread time or SQL.
    f.options.clock.now = () => {
      throw new Error("post-COMMIT clock must not be read");
    };
    const queryCount = f.calls.length;
    expect(() => f.source.assertFinalized()).not.toThrow();
    expect(f.calls).toHaveLength(queryCount);
  });

  it("reuses one registration during host checks and never extends a shortened lease", async () => {
    const f = fixture();
    await f.source.hold();
    f.setUntil("2026-10-06T12:00:04.000Z");
    expect((await f.source.hold()).validUntil).toBe("2026-10-06T12:00:04.000Z");
    await f.guard();
    f.setUntil(deadline);
    expect((await f.source.hold()).validUntil).toBe("2026-10-06T12:00:04.000Z");
    expect(f.registrations()).toBe(1);
    f.final();
    f.source.assertFinalized();
  });

  it("accepts consumption at creation and at the original observation", async () => {
    for (const consumed of ["2026-10-05T13:00:00.000Z", at]) {
      const f = fixture();
      f.setRow({
        created_at: "2026-10-05T13:00:00.000Z",
        expires_at: "2026-10-06T13:00:00.000Z",
        consumed_at: consumed,
      });
      expect((await f.source.hold()).consumedAt).toBe(consumed);
      await f.guard();
      f.final();
      f.source.assertFinalized();
    }
  });

  it.each<[string, Record<string, unknown>]>([
    ["wrong invitation", { invitation_id: id(10) }],
    ["wrong Actor", { actor_id: id(10) }],
    ["invalid original Membership", { membership_id: "invalid" }],
    ["missing original Membership", { membership_id: null }],
    ["Pending", { status: "Pending" }],
    ["Revoked", { status: "Revoked" }],
    ["Expired", { status: "Expired" }],
    ["missing Provider evidence", { provider_evidence_id: null }],
    ["invalid Provider evidence", { provider_evidence_id: "invalid" }],
    ["zero version", { version: 0 }],
    ["fractional version", { version: 1.5 }],
    ["string version", { version: "2" }],
    [
      "future creation",
      {
        created_at: "2026-10-07T12:00:00.000Z",
        expires_at: "2026-10-08T12:00:00.000Z",
        consumed_at: "2026-10-07T13:00:00.000Z",
      },
    ],
    [
      "future consumption",
      {
        created_at: "2026-10-06T11:00:00.000Z",
        expires_at: "2026-10-07T11:00:00.000Z",
        consumed_at: "2026-10-06T12:00:00.001Z",
      },
    ],
    ["consumption before creation", { consumed_at: "2026-01-01T11:59:59.999Z" }],
    ["consumption at expiry", { consumed_at: "2026-01-02T12:00:00.000Z" }],
    ["wrong 24-hour window", { expires_at: "2026-01-02T12:00:00.001Z" }],
    ["missing consumption", { consumed_at: null }],
    ["submillisecond database value", { precise: false }],
    ["SQL NULL precision", { precise: null }],
    ["noncanonical creation", { created_at: "2026-01-01T12:00:00Z" }],
    ["infinite expiry", { expires_at: "infinity" }],
    ["submillisecond wire consumption", { consumed_at: "2026-01-01T13:00:00.0001Z" }],
  ])("refuses %s and poisons a caught failure before outer COMMIT", async (_name, patch) => {
    const f = fixture();
    f.setRow(patch);
    await expect(f.source.hold()).rejects.toMatchObject(denied);
    expect(f.registrations()).toBe(1);
    await expect(f.guard()).rejects.toMatchObject(denied);
    expect(() => f.final()).toThrow();
    expect(() => f.source.assertFinalized()).toThrow();
  });

  it.each([
    { membership_id: id(11) },
    { provider_evidence_id: id(12) },
    { version: 3 },
    { status: "Revoked" },
    { consumed_at: "2026-01-01T13:00:00.001Z" },
  ])("pins the immutable original across the late read: %j", async (patch) => {
    const f = fixture();
    await f.source.hold();
    f.setRow(patch);
    await expect(f.guard()).rejects.toMatchObject(denied);
    expect(() => f.final()).toThrow();
  });

  it("refuses missing and malformed whole SQL results without invoking accessors", async () => {
    const getter = vi.fn(() => ({}));
    const sparse = new Array(1);
    const accessor = Object.defineProperty([], "0", { enumerable: true, get: getter });
    for (const rows of [
      { rows: [] },
      { rows: [{}, {}] },
      { rows: sparse },
      { rows: accessor },
      Object.defineProperty({}, "rows", { get: getter }),
    ]) {
      const f = fixture();
      f.setRows(rows);
      await expect(f.source.hold()).rejects.toMatchObject(denied);
      await expect(f.guard()).rejects.toMatchObject(denied);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    { actorReference: id(20) },
    { invitationReference: id(20) },
    { purposeCode: "LOGIN" },
    { observedAt: "2026-10-06T11:59:59.999Z" },
    { validUntil: "2026-10-06T12:00:05.001Z" },
    { validUntil: at },
    { allowed: true },
  ])("requires actual closed current authority bound to this read: %j", async (patch) => {
    const f = fixture();
    f.patchAuthority(patch);
    await expect(f.source.hold()).rejects.toMatchObject(denied);
    expect(f.calls).toHaveLength(0);
    await expect(f.guard()).rejects.toMatchObject(denied);
  });

  it("checks authority again after the held row and during the late host guard", async () => {
    const first = fixture();
    first.onQuery(async (sql) => {
      if (sql.includes("FROM bop_identity")) first.withdraw();
    });
    await expect(first.source.hold()).rejects.toMatchObject(denied);
    expect(first.options.authority.hold).toHaveBeenCalledTimes(2);
    const second = fixture();
    await second.source.hold();
    second.withdraw();
    await expect(second.guard()).rejects.toMatchObject(denied);
    expect(() => second.final()).toThrow();
  });

  it.each(["repeatable read", "serializable"])(
    "refuses %s instead of weakening current reads",
    async (isolation) => {
      const f = fixture();
      f.setIsolation(isolation);
      await expect(f.source.hold()).rejects.toMatchObject(denied);
      expect(f.calls.some((call) => call.sql.includes("FROM bop_identity"))).toBe(false);
    },
  );

  it("rejects physical transaction drift even when the JavaScript transaction is unchanged", async () => {
    const f = fixture();
    await f.source.hold();
    f.setTransaction("902");
    await expect(f.guard()).rejects.toMatchObject(denied);
    const during = fixture();
    during.onQuery(async (sql) => {
      if (sql.includes("FROM bop_identity")) during.setTransaction("903");
    });
    await expect(during.source.hold()).rejects.toMatchObject(denied);
  });

  it("registers a refusal before the first clock check or authority read can fail", async () => {
    const f = fixture();
    f.setTime(deadline);
    await expect(f.source.hold()).rejects.toMatchObject(denied);
    expect(f.registrations()).toBe(1);
    expect(f.calls).toHaveLength(0);
    expect(f.options.authority.hold).not.toHaveBeenCalled();
    await expect(f.guard()).rejects.toMatchObject(denied);
  });

  it.each(["query", "authority", "final"])(
    "refuses the original lease expiring during %s",
    async (stage) => {
      const f = fixture();
      if (stage === "query")
        f.onQuery(async () => {
          f.setTime(deadline);
        });
      if (stage === "authority")
        f.onAuthority(async () => {
          f.setTime(deadline);
        });
      if (stage === "final") {
        await f.source.hold();
        await f.guard();
        f.setTime(deadline);
        expect(() => f.final()).toThrow();
      } else await expect(f.source.hold()).rejects.toMatchObject(denied);
      expect(() => f.source.assertFinalized()).toThrow();
    },
  );

  it("refuses backward and malformed clocks, including the synchronous final seal", async () => {
    for (const time of ["2026-10-06T11:59:59.999Z", "not-an-instant"]) {
      const f = fixture();
      await f.source.hold();
      await f.guard();
      f.setTime(time);
      expect(() => f.final()).toThrow();
      expect(() => f.source.assertFinalized()).toThrow();
    }
  });

  it.each(["query", "authority", "clock", "registration", "binding", "observation", "deadline"])(
    "rejects captured %s replacement",
    async (port) => {
      const f = fixture();
      await f.source.hold();
      const replacement = vi.fn(async () => ({ rows: [] }));
      if (port === "query") f.tx.query = replacement;
      if (port === "authority")
        f.options.authority.hold = vi.fn(async () => {
          throw new Error("replacement invoked");
        });
      if (port === "clock") f.options.clock.now = () => at;
      if (port === "registration") f.options.registerBeforeCommit = async () => undefined;
      if (port === "binding") f.options.binding.actorReference = id(30);
      if (port === "observation") f.options.originalObservedAt = "2026-10-06T12:00:00.001Z";
      if (port === "deadline") f.options.originalValidUntil = "2026-10-06T12:00:04.000Z";
      await expect(f.guard()).rejects.toMatchObject(denied);
      expect(replacement).not.toHaveBeenCalled();
    },
  );

  it.each(["query", "authority"])("poisons caught reentry through %s", async (port) => {
    const f = fixture();
    let entered = false;
    const attempt = async () => {
      if (entered) return;
      entered = true;
      await expect(f.source.hold()).rejects.toMatchObject(denied);
    };
    if (port === "query") f.onQuery(attempt);
    else f.onAuthority(attempt);
    await expect(f.source.hold()).rejects.toMatchObject(denied);
    await expect(f.guard()).rejects.toMatchObject(denied);
  });

  it("keeps actual database and authority error detail out of the public error", async () => {
    const f = fixture();
    f.onQuery(async () => {
      throw new Error("private database detail");
    });
    await expect(f.source.hold()).rejects.toMatchObject({ ...denied, message: "request denied" });
    const other = fixture();
    other.withdraw();
    await expect(other.source.hold()).rejects.toMatchObject({
      ...denied,
      message: "request denied",
    });
  });

  it("requires exactly one host async guard then final seal and refuses use after final", async () => {
    const premature = fixture();
    await premature.source.hold();
    expect(() => premature.final()).toThrow();
    await expect(premature.guard()).rejects.toMatchObject(denied);
    const duplicated = fixture();
    await duplicated.source.hold();
    await duplicated.guard();
    await expect(duplicated.guard()).rejects.toMatchObject(denied);
    expect(() => duplicated.final()).toThrow();
    const finalized = fixture();
    await finalized.source.hold();
    await finalized.guard();
    finalized.final();
    await expect(finalized.source.hold()).rejects.toMatchObject(denied);
    expect(() => finalized.source.assertFinalized()).toThrow();
  });

  it("rejects an absent current authority, open binding and an unbounded original lease", () => {
    const f = fixture();
    expect(() =>
      createPostgresCurrentWorkforceInvitationSource({
        ...f.options,
        originalValidUntil: "2026-10-06T12:00:05.001Z",
      }),
    ).toThrow();
    expect(() =>
      createPostgresCurrentWorkforceInvitationSource({ ...f.options, originalValidUntil: at }),
    ).toThrow();
    expect(() =>
      createPostgresCurrentWorkforceInvitationSource({
        ...f.options,
        binding: { ...f.options.binding, purposeCode: "LOGIN" } as never,
      }),
    ).toThrow();
    expect(() =>
      createPostgresCurrentWorkforceInvitationSource({
        ...f.options,
        binding: { ...f.options.binding, newMembershipReference: id(99) } as never,
      }),
    ).toThrow();
    expect(() =>
      createPostgresCurrentWorkforceInvitationSource({
        ...f.options,
        authority: { hold: undefined } as never,
      }),
    ).toThrow();
  });
});
