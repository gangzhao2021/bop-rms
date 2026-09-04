import { describe, expect, it, vi } from "vitest";
import {
  createGuestSessionRecord,
  createPostgresGuestSessionEntryStore,
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
    expect(h.query.mock.calls[3]?.[0]).toContain("WHERE brand_id = $1 AND store_id = $2");
    expect(await h.store.resolveOperation(record.operationReference)).toEqual(record);
    expect(Object.keys(h.store).sort()).toEqual(["create", "resolve", "resolveOperation"]);
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
    expect(h.query).toHaveBeenCalledTimes(2);
  });
});
