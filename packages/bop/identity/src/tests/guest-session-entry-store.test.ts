import { describe, expect, it, vi } from "vitest";
import {
  createGuestSessionRecord,
  createPostgresGuestSessionEntryStore,
  createPostgresGuestSessionLegacyInspector,
  type GuestSessionEntryTransactionRunner,
} from "../index.js";

const id = (value: number) => `00000000-0000-7000-8000-${value.toString().padStart(12, "0")}`;
const scope = { brandReference: id(1), storeReference: id(2) };
function fixture(overrides: Record<string, unknown> = {}) {
  return createGuestSessionRecord({
    session: {
      sessionReference: id(3),
      status: "Active",
      version: 1,
      ...scope,
      publicStoreReference: id(4),
      publicTableReference: null,
      channel: "Pickup",
      locale: "en-CA",
      qrReference: id(5),
      qrRevocationVersion: 1,
      diningState: "ContextOnly",
      diningSessionReference: null,
      diningParticipantReference: null,
      createdAt: "2026-01-15T12:00:00.123Z",
      lastSeenAt: "2026-01-15T12:00:00.123Z",
      idleExpiresAt: "2026-01-15T16:00:00.123Z",
      absoluteExpiresAt: "2026-01-16T12:00:00.123Z",
      orderClosedAt: null,
      closureExpiresAt: null,
      rotatedFromGuestSessionReference: null,
      revocationReason: null,
      revokedAt: null,
      ...overrides,
    },
    sessionSelectorHash: "1".repeat(64),
    csrfSelectorHash: "2".repeat(64),
    operationReference: id(6),
    operationIntentHash: "3".repeat(64),
  });
}
function harness(result: unknown = { rows: [{ record: fixture() }] }) {
  const query = vi.fn<(sql: string, values: readonly unknown[]) => Promise<unknown>>(
    async () => result,
  );
  const runner: GuestSessionEntryTransactionRunner = { run: async (action) => action({ query }) };
  return { query, runner, store: createPostgresGuestSessionEntryStore(runner, scope) };
}

describe("WP-2209 PostgreSQL Guest entry persistence", () => {
  it("binds the scope and hashes, round-trips records and exposes no lifecycle stubs", async () => {
    const h = harness();
    const record = fixture();
    expect(await h.store.create({ record })).toEqual(record);
    expect(h.query.mock.calls[0]).toEqual([
      "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
      [scope.brandReference, scope.storeReference],
    ]);
    expect(h.query.mock.calls[1]?.[0]).toContain("ON CONFLICT DO NOTHING");
    expect(h.query.mock.calls[1]?.[0]).not.toContain(record.sessionSelectorHash);
    expect(h.query.mock.calls[1]?.[1]).toContain(record.sessionSelectorHash);
    expect(await h.store.resolve(record.sessionSelectorHash)).toEqual(record);
    expect(h.query.mock.calls[4]?.[0]).toContain("WHERE brand_id = $1 AND store_id = $2");
    expect(await h.store.resolveOperation(record.operationReference)).toEqual(record);
    expect(Object.keys(h.store).sort()).toEqual([
      "create",
      "resolve",
      "resolveOperation",
      "revoke",
      "rotate",
      "touchInteractive",
    ]);
  });

  it.each(["brandReference", "storeReference"])(
    "rejects invalid %s before opening a transaction",
    (field) => {
      const h = harness();
      expect(() =>
        createPostgresGuestSessionEntryStore(h.runner, { ...scope, [field]: "invalid" }),
      ).toThrow();
      expect(h.query).not.toHaveBeenCalled();
    },
  );

  it.each([
    { storeReference: id(88) },
    { brandReference: id(88) },
    { version: 2 },
    { status: "Expired" },
    { rotatedFromGuestSessionReference: id(88) },
    { lastSeenAt: "2026-01-15T12:01:00.123Z", idleExpiresAt: "2026-01-15T16:01:00.123Z" },
    { orderClosedAt: "2026-01-15T13:00:00.123Z", closureExpiresAt: "2026-01-15T15:00:00.123Z" },
  ])("rejects non-entry input before SQL: %j", async (overrides) => {
    const h = harness();
    await expect(h.store.create({ record: fixture(overrides) })).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    expect(h.query).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { rows: [null] },
    { rows: [{ record: {} }] },
    { rows: [{ record: fixture() }, { record: fixture() }] },
    { rows: [{ record: fixture({ storeReference: id(88) }) }] },
  ])("rejects malformed or cross-scope results without detail", async (result) => {
    const h = harness(result);
    const error = await h.store
      .resolve(fixture().sessionSelectorHash)
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    expect(error).not.toHaveProperty("cause");
  });

  it("distinguishes missing reads from insertion conflicts without returning a prior record", async () => {
    const h = harness({ rows: [] });
    expect(await h.store.resolve(fixture().sessionSelectorHash)).toBeNull();
    expect(await h.store.resolveOperation(fixture().operationReference)).toBeNull();
    await expect(h.store.create({ record: fixture() })).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
  });

  it("rejects unexpected result identity and hides a failed commit without retry", async () => {
    const h = harness();
    await expect(
      h.store.resolve("9".repeat(64) as ReturnType<typeof fixture>["sessionSelectorHash"]),
    ).rejects.toThrow();
    await expect(
      h.store.resolveOperation(id(88) as ReturnType<typeof fixture>["operationReference"]),
    ).rejects.toThrow();
    const runner: GuestSessionEntryTransactionRunner = {
      async run(action) {
        await action({ query: h.query });
        throw new Error("private SQL/bind/driver failure");
      },
    };
    const store = createPostgresGuestSessionEntryStore(runner, scope);
    h.query.mockClear();
    const error = await store.create({ record: fixture() }).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain("private SQL");
    expect(h.query).toHaveBeenCalledTimes(3);
  });
});

describe("WP-2213 legacy inspection", () => {
  it.each([
    [{ hasLegacy: false, hasLiveLegacy: false }, "NoLegacyRows"],
    [{ hasLegacy: true, hasLiveLegacy: false }, "InactiveLegacyRowsOnly"],
    [{ hasLegacy: true, hasLiveLegacy: true }, "LiveLegacyRowsPresent"],
  ] as const)("returns only bounded classification for %j", async (row, classification) => {
    const query = vi.fn<(sql: string, values: readonly unknown[]) => Promise<unknown>>(
      async () => ({ rows: [row] }),
    );
    const inspector = createPostgresGuestSessionLegacyInspector(
      { run: async (action) => action({ query }) },
      scope,
    );
    expect(await inspector.inspect(fixture().session.createdAt)).toEqual({
      classification,
      observedAt: fixture().session.createdAt,
    });
    expect(query.mock.calls[1]?.[0]).toContain("s.brand_id = $1 AND s.store_id = $2");
    expect(query.mock.calls[1]?.[0]).toContain("h.operation_intent_hash = s.operation_intent_hash");
    expect(JSON.stringify(await inspector.inspect(fixture().session.createdAt))).not.toContain(
      "hasLegacy",
    );
  });
  it.each([
    { rows: [] },
    { rows: [{ hasLegacy: false, hasLiveLegacy: true }] },
    { rows: [{ count: 1 }] },
  ])("bounds malformed or contradictory results", async ({ rows }) => {
    const inspector = createPostgresGuestSessionLegacyInspector(
      {
        run: async (action) => action({ query: async () => ({ rows }) }),
      },
      scope,
    );
    const error = await inspector.inspect(fixture().session.createdAt).catch((failure) => failure);
    expect(error).toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
    expect(error).not.toHaveProperty("cause");
  });
  it("rejects invalid scope/time without running the inspection query", async () => {
    const run = vi.fn();
    expect(() =>
      createPostgresGuestSessionLegacyInspector({ run } as never, {
        ...scope,
        storeReference: "bad",
      }),
    ).toThrow();
    const inspector = createPostgresGuestSessionLegacyInspector({ run } as never, scope);
    await expect(inspector.inspect("bad")).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("WP-2210 interactive persistence", () => {
  const command = {
    selectorHash: fixture().sessionSelectorHash,
    expectedVersion: 1,
    observedAt: fixture().session.lastSeenAt,
    idleExpiresAt: fixture().session.idleExpiresAt,
  };

  it("binds one atomic scoped update and validates the returned transition", async () => {
    const record = fixture({ version: 2 });
    const h = harness({ rows: [{ record }] });
    expect(await h.store.touchInteractive(command)).toEqual(record);
    expect(h.query).toHaveBeenCalledTimes(2);
    const [sql, values] = h.query.mock.calls[1] ?? ["", []];
    expect(sql).toContain("WHERE brand_id = $1 AND store_id = $2");
    expect(sql).toContain("AND version = $4 AND status = 'Active'");
    expect(sql).toContain("last_seen_at <= $5");
    expect(sql).toContain("idle_expires_at > $5 AND absolute_expires_at > $5");
    expect(sql).toContain("closure_expires_at > $5");
    expect(values).toEqual([
      scope.brandReference,
      scope.storeReference,
      command.selectorHash,
      1,
      command.observedAt,
      command.idleExpiresAt,
    ]);
    expect(sql).not.toContain(command.selectorHash);
  });

  it.each([
    { expectedVersion: 0 },
    { expectedVersion: -1 },
    { expectedVersion: 1.5 },
    { expectedVersion: Number.NaN },
    { expectedVersion: 2_147_483_647 },
    { observedAt: "2026-01-15T12:00:00Z" },
    { idleExpiresAt: "2026-01-15T17:00:00.123Z" },
    { selectorHash: "invalid" },
  ])("rejects invalid input before SQL: %j", async (override) => {
    const h = harness();
    await expect(
      h.store.touchInteractive({ ...command, ...override } as typeof command),
    ).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
    expect(h.query).not.toHaveBeenCalled();
  });

  it.each([
    fixture(),
    fixture({ version: 3 }),
    fixture({ version: 2, status: "Expired" }),
    fixture({ version: 2, storeReference: id(88) }),
    fixture({
      version: 2,
      lastSeenAt: "2026-01-15T12:01:00.123Z",
      idleExpiresAt: "2026-01-15T16:01:00.123Z",
    }),
    { ...fixture({ version: 2 }), sessionSelectorHash: "9".repeat(64) },
    {},
  ])("rejects an unexpected transition result", async (record) => {
    const h = harness({ rows: [{ record }] });
    await expect(h.store.touchInteractive(command)).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
  });

  it("returns null on a denied CAS and never retries an unknown commit", async () => {
    const h = harness({ rows: [] });
    expect(await h.store.touchInteractive(command)).toBeNull();
    const attempted = vi.fn();
    const runner: GuestSessionEntryTransactionRunner = {
      async run(action) {
        attempted();
        await action({ query: h.query });
        throw new Error("private SQL or commit detail");
      },
    };
    const store = createPostgresGuestSessionEntryStore(runner, scope);
    const error = await store.touchInteractive(command).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain("private");
    expect(attempted).toHaveBeenCalledTimes(1);
  });
});

describe("WP-2211 lifecycle persistence", () => {
  const current = fixture();
  const next = createGuestSessionRecord({
    ...current,
    session: {
      ...current.session,
      sessionReference: id(30),
      rotatedFromGuestSessionReference: current.session.sessionReference,
    },
    sessionSelectorHash: "4".repeat(64),
    csrfSelectorHash: "5".repeat(64),
    operationReference: id(31),
  });
  const rotation = {
    currentSelectorHash: current.sessionSelectorHash,
    expectedVersion: 1,
    reason: "Rotated" as const,
    observedAt: current.session.createdAt,
    nextRecord: next,
  };
  const revoke = {
    selectorHash: current.sessionSelectorHash,
    expectedVersion: 1,
    reason: "Logout" as const,
    observedAt: current.session.createdAt,
    operationReference: next.operationReference,
    operationIntentHash: next.operationIntentHash,
  };
  function lifecycleHarness(options: { missingHistory?: boolean; mismatch?: boolean } = {}) {
    const query = vi.fn(async (sql: string) => {
      let result: unknown = current;
      if (sql.startsWith("UPDATE"))
        result = fixture({
          status: "Revoked",
          version: 2,
          revocationReason: "Rotated",
          revokedAt: current.session.createdAt,
        });
      if (sql.startsWith("INSERT")) result = options.mismatch ? current : next;
      if (options.missingHistory && sql.includes("FROM bop_identity.guest_session_operation"))
        return { rows: [] };
      return { rows: [{ record: result }] };
    });
    const runner: GuestSessionEntryTransactionRunner = { run: async (action) => action({ query }) };
    return { query, store: createPostgresGuestSessionEntryStore(runner, scope) };
  }
  it("locks the predecessor and writes the replacement/history in one transaction", async () => {
    const h = lifecycleHarness();
    expect(await h.store.rotate(rotation)).toEqual(next);
    expect(h.query.mock.calls[1]?.[0]).toContain("FOR UPDATE");
    expect(h.query.mock.calls.map(([sql]) => sql.split(" ")[0])).toEqual([
      "SELECT",
      "SELECT",
      "SELECT",
      "UPDATE",
      "INSERT",
      "INSERT",
    ]);
  });
  it("rejects missing legacy history without a terminal update", async () => {
    const h = lifecycleHarness({ missingHistory: true });
    await expect(h.store.rotate(rotation)).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    expect(h.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
    await expect(h.store.revoke(revoke)).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
  });
  it("rejects an unrelated persisted replacement before credential issuance", async () => {
    await expect(lifecycleHarness({ mismatch: true }).store.rotate(rotation)).rejects.toMatchObject(
      { code: "GUEST_SESSION_UNAVAILABLE" },
    );
  });
  it.each([
    { session: { ...next.session, storeReference: id(88) } },
    { session: { ...next.session, rotatedFromGuestSessionReference: id(88) } },
    { session: { ...next.session, sessionReference: current.session.sessionReference } },
    { sessionSelectorHash: current.sessionSelectorHash },
    { csrfSelectorHash: current.csrfSelectorHash },
  ])("rejects invalid replacement identity or credentials", async (override) => {
    await expect(
      lifecycleHarness().store.rotate({
        ...rotation,
        nextRecord: createGuestSessionRecord({ ...next, ...override }),
      }),
    ).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
  });
  it("rejects stale versions and backward time", async () => {
    await expect(
      lifecycleHarness().store.revoke({ ...revoke, expectedVersion: 2 }),
    ).rejects.toMatchObject({ code: "GUEST_SESSION_VERSION_CONFLICT" });
    await expect(
      lifecycleHarness().store.revoke({
        ...revoke,
        observedAt: "2026-01-15T11:59:00.123Z" as typeof revoke.observedAt,
      }),
    ).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
  });
});
