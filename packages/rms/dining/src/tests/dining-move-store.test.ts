import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createDiningTable,
  moveActiveDiningSession,
  parseDiningSession,
  createPostgresDiningSessionMoveStore,
  type DiningTableTransactionRunner,
} from "../index.js";
import {
  parseDiningMoveCommand,
  parseDiningSessionMoveRecord,
} from "../application/dining-move-record.js";
const id = (n: number) => `01902284-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-09T09:02:00.000Z";
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const hashes = {
  hashIntent: (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`,
  equals: (a: string, b: string) => a === b,
};
function sourceFacts() {
  const table = (ref: string, occupied: boolean) =>
    createDiningTable({
      ...scope,
      tableReference: ref,
      stableLabel: "T",
      areaReference: id(10),
      areaCode: "ROOM",
      capacity: 4,
      accessibilityAttributes: [],
      lifecycle: "Published",
      qrStatus: "Inactive",
      qrVersion: 0,
      operationalState: "Available",
      blockReasonCode: null,
      activeDiningSessionReference: occupied ? id(5) : null,
      aggregateVersion: occupied ? 3 : 2,
      createdAt: at,
      observedAt: at,
    });
  return {
    source: table(id(4), true),
    target: table(id(6), false),
    session: parseDiningSession({
      diningSessionReference: id(5),
      brandReference: id(2),
      storeReference: id(3),
      tableReference: id(4),
      tableAssignmentVersion: 2,
      phase: "Active",
      version: 1,
      startedByActorReference: id(8),
      startedAt: at,
      hostParticipantReference: null,
    }),
  };
}
function record() {
  const { source, target, session } = sourceFacts();
  const command = parseDiningMoveCommand({
    operationReference: id(7),
    diningSessionReference: id(5),
    sourceTableReference: id(4),
    targetTableReference: id(6),
    expectedSessionVersion: 1,
    expectedSourceTableVersion: 3,
    expectedTargetTableVersion: 2,
    partySize: 2,
    observedAt: at,
  });
  return parseDiningSessionMoveRecord(
    {
      command,
      operationReference: id(7),
      intentDigest: hashes.hashIntent(JSON.stringify(command)),
      ...moveActiveDiningSession(session, source, target, 2, command.observedAt),
      audit: {
        auditId: id(11),
        brandId: id(2),
        storeId: id(3),
        actor: { type: "User", reference: id(8) },
        actionCode: "DINING_SESSION_MOVE_TABLE",
        targetType: "DiningSession",
        targetId: id(5),
        reasonCode: "AUTHORIZED_OPERATION",
        correlationId: id(12),
        occurredAt: at,
        sourceChannel: "API",
        dataClassification: "Internal",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      },
      event: {
        eventType: "DiningSessionTableMoved",
        diningSessionReference: id(5),
        sourceTableReference: id(4),
        targetTableReference: id(6),
        aggregateVersion: "2",
        occurredAt: at,
      },
    },
    hashes,
  );
}
function fixture(result: unknown = { rows: [] }) {
  const calls = vi.fn();
  const query = vi.fn<(sql: string, values: readonly unknown[]) => Promise<unknown>>(
    async () => result,
  );
  const runner: DiningTableTransactionRunner = {
    async run<T>(action: Parameters<DiningTableTransactionRunner["run"]>[0]) {
      calls();
      return (await action({ query })) as T;
    },
  };
  return { store: createPostgresDiningSessionMoveStore(runner, scope, hashes), query, calls };
}
const denied = { code: "DINING_TABLE_DEPENDENCY_UNAVAILABLE" };
describe("WP-2284 owning Move transaction", () => {
  it("reads exact scoped immutable complete history", async () => {
    const { store, query } = fixture({ rows: [{ record: record() }] });
    const value = await store.resolveMoveOperation(id(7) as never);
    expect(value).toEqual(record());
    expect(Object.isFrozen(value?.command)).toBe(true);
    expect(query.mock.calls.at(-1)?.[1]).toEqual([id(1), id(2), id(3), id(7)]);
  });
  it("returns no history when absent", async () => {
    expect(await fixture().store.resolveMoveOperation(id(7) as never)).toBeNull();
  });
  it("rejects malformed locators before IO", async () => {
    const state = fixture();
    await expect(state.store.resolveMoveOperation("invalid" as never)).rejects.toMatchObject({
      code: "DINING_TABLE_INPUT_INVALID",
    });
    expect(state.calls).not.toHaveBeenCalled();
  });
  it.each(["operationReference", "intentDigest", "extra"])(
    "denies altered historical %s",
    async (field) => {
      await expect(
        fixture({
          rows: [{ record: { ...record(), [field]: id(99) } }],
        }).store.resolveMoveOperation(id(7) as never),
      ).rejects.toMatchObject(denied);
    },
  );
  it.each(["tenantReference", "brandReference", "storeReference"])(
    "denies foreign bound %s",
    async (field) => {
      const stored = record();
      const store = createPostgresDiningSessionMoveStore(
        { run: async (action) => action({ query: async () => ({ rows: [{ record: stored }] }) }) },
        { ...scope, [field]: id(99) },
        hashes,
      );
      await expect(store.resolveMoveOperation(id(7) as never)).rejects.toMatchObject(denied);
    },
  );
  it("converges to the original Audit on idempotent commit without writing", async () => {
    const original = record();
    const current = { ...original, audit: { ...original.audit, auditId: id(99) } };
    const { store, query } = fixture({ rows: [{ record: original }] });
    expect(await store.commitMove(current)).toEqual({ status: "AlreadyApplied", record: original });
    expect(query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
  });
  it("rejects reuse by a different actor", async () => {
    const original = record();
    const current = {
      ...original,
      audit: { ...original.audit, actor: { type: "User" as const, reference: id(99) } },
    };
    await expect(
      fixture({ rows: [{ record: original }] }).store.commitMove(current),
    ).rejects.toMatchObject({ code: "DINING_TABLE_IDEMPOTENCY_CONFLICT" });
  });
  it("locks Tables in stable order and writes the recomputed result plus Audit", async () => {
    const { source, target, session } = sourceFacts();
    const state = fixture();
    state.query.mockImplementation(async (sql, values) => {
      if (sql.includes("FROM rms_dining.dining_table "))
        return { rows: [{ table: values[3] === id(4) ? source : target }] };
      if (sql.includes("FROM rms_dining.dining_session ")) return { rows: [{ session }] };
      if (sql.includes("FROM platform_audit.audit_chain_head"))
        return { rows: [{ next_sequence: "1", previous_hash: null, recorded_at: at }] };
      if (sql.startsWith("UPDATE platform_audit.audit_chain_head"))
        return { rowCount: 1, rows: [{ next_sequence: "2" }] };
      return { rows: [], rowCount: 1 };
    });
    expect(await state.store.commitMove(record())).toEqual({ status: "Applied", record: record() });
    const locks = state.query.mock.calls
      .filter(([sql]) => sql.includes("pg_advisory_xact_lock"))
      .map(([, values]) => values[0]);
    expect(locks).toEqual([
      `DiningSessionMove:${id(1)}:${id(2)}:${id(3)}:${id(7)}`,
      ...[id(4), id(6)].sort().map((ref) => `DiningTable:${id(1)}:${id(2)}:${id(3)}:${ref}`),
    ]);
    expect(
      state.query.mock.calls.filter(([sql]) => sql.startsWith("UPDATE rms_dining")).length,
    ).toBe(3);
    expect(
      state.query.mock.calls.some(([sql]) =>
        sql.startsWith("INSERT INTO platform_audit.audit_record"),
      ),
    ).toBe(true);
  });
  it("does not invoke query result accessors", async () => {
    const getter = vi.fn();
    const state = fixture(Object.defineProperty({}, "rows", { get: getter }));
    await expect(state.store.resolveMoveOperation(id(7) as never)).rejects.toMatchObject(denied);
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(["phase", "tableReference", "hostParticipantReference"])(
    "rejects incompatible current Session %s before writes",
    async (field) => {
      const facts = sourceFacts();
      const state = fixture();
      state.query.mockImplementation(async (sql, values) =>
        sql.includes("FROM rms_dining.dining_table ")
          ? { rows: [{ table: values[3] === id(4) ? facts.source : facts.target }] }
          : sql.includes("FROM rms_dining.dining_session ")
            ? {
                rows: [
                  {
                    session: { ...facts.session, [field]: field === "phase" ? "Closing" : id(99) },
                  },
                ],
              }
            : { rows: [] },
      );
      await expect(state.store.commitMove(record())).rejects.toMatchObject(denied);
      expect(state.query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
    },
  );
  it("redacts synchronous transaction errors", async () => {
    const store = createPostgresDiningSessionMoveStore(
      {
        run: () => {
          throw new Error("private SQL");
        },
      },
      scope,
      hashes,
    );
    const error = await store.commitMove(record()).catch((value: unknown) => value);
    expect(error).toMatchObject(denied);
    expect(String(error)).not.toContain("private SQL");
  });
});

it("WP-2284 rejects backwards Table observation time before writes", async () => {
  const facts = sourceFacts();
  const state = fixture();
  state.query.mockImplementation(async (sql, values) =>
    sql.includes("FROM rms_dining.dining_table ")
      ? {
          rows: [
            {
              table:
                values[3] === id(4)
                  ? { ...facts.source, observedAt: "2026-09-09T09:03:00.000Z" }
                  : facts.target,
            },
          ],
        }
      : sql.includes("FROM rms_dining.dining_session ")
        ? { rows: [{ session: facts.session }] }
        : { rows: [] },
  );
  await expect(state.store.commitMove(record())).rejects.toMatchObject(denied);
  expect(state.query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
});
