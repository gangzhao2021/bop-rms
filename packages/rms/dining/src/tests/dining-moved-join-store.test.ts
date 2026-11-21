import {
  parseDiningJoinCapability,
  reissueDiningJoinCapabilityAfterMove,
} from "@bop/public-capability";
import { movedJoinAssignment } from "../application/dining-moved-join-record.js";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createDiningTable,
  moveActiveDiningSession,
  parseDiningSession,
  createPostgresDiningMovedJoinStore,
  parseDiningReference,
  parseDiningHash,
  type DiningTableTransactionRunner,
} from "../index.js";
import {
  parseDiningMoveCommand,
  parseDiningSessionMoveRecord,
} from "../application/dining-move-record.js";
const id = (n: number) => `01902286-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
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

const issuedAt = "2026-09-09T09:03:00.000Z";
const credentials = {
  hashOperationIntent: (value: string) =>
    parseDiningHash(createHash("sha256").update(value).digest("hex")),
  equals: (a: string, b: string) => a === b,
};
function fixture() {
  const move = record();
  const current = parseDiningJoinCapability({
    capabilityReference: id(20),
    purpose: "DiningJoin",
    kind: "Invitation",
    storeReference: id(3),
    tableReference: id(4),
    diningSessionReference: id(5),
    selectorHash: "a".repeat(64),
    pepperVersion: 1,
    assignmentVersion: 2,
    generation: 1,
    status: "Active",
    version: 1,
    issuedAt: at,
    expiresAt: "2026-09-09T09:17:00.000Z",
    consumedAt: null,
    revokedAt: null,
  });
  const replacement = parseDiningJoinCapability({
    ...current,
    capabilityReference: id(21),
    selectorHash: "b".repeat(64),
    pepperVersion: 2,
    tableReference: id(6),
    assignmentVersion: 3,
    generation: 2,
    issuedAt,
    expiresAt: "2026-09-09T09:18:00.000Z",
  });
  const transition = reissueDiningJoinCapabilityAfterMove({
    previous: current,
    replacement,
    assignment: movedJoinAssignment(move),
    currentPepperVersion: 2,
    observedAt: issuedAt,
  });
  const input = {
    session: move.session,
    move,
    previous: transition.previous,
    replacement,
    expectedCapabilityVersion: 1,
    operationReference: parseDiningReference(id(22)),
    operationIntentHash: credentials.hashOperationIntent(`Regenerate:${id(5)}:${id(6)}:3`),
    currentPepperVersion: 2,
    audit: {
      ...move.audit,
      auditId: id(23),
      actionCode: "DINING_JOIN_CREDENTIAL_REGENERATE",
      targetType: "DiningTable",
      targetId: id(6),
      occurredAt: issuedAt,
    },
  };
  const original = {
    capability: replacement,
    operationReference: input.operationReference,
    operationIntentHash: input.operationIntentHash,
  };
  const query = vi.fn<(sql: string, values: readonly unknown[]) => Promise<unknown>>(
    async (sql) => {
      if (sql.includes("FROM rms_dining.dining_session s"))
        return { rows: [{ session: move.session, capability: current, move }] };
      if (sql.includes("FROM rms_dining.dining_table "))
        return { rows: [{ table: move.targetTable }] };
      if (sql.includes("FROM rms_dining.dining_session "))
        return { rows: [{ session: move.session }] };
      if (sql.includes("FROM rms_dining.dining_join_capability "))
        return { rows: [{ capability: current }] };
      if (sql.includes("FROM rms_dining.dining_session_move_operation "))
        return { rows: [{ record: move }] };
      if (sql.includes("FROM platform_audit.audit_chain_head"))
        return { rows: [{ next_sequence: "1", previous_hash: null, recorded_at: issuedAt }] };
      if (sql.startsWith("UPDATE platform_audit.audit_chain_head"))
        return { rows: [{ next_sequence: "2" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  );
  const run = vi.fn();
  const runner: DiningTableTransactionRunner = {
    run: async (action) => {
      run();
      return action({ query });
    },
  };
  const store = createPostgresDiningMovedJoinStore(runner, scope, credentials, hashes);
  return { store, query, run, runner, move, current, input, original };
}
const denied = { code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE" };
const conflict = { code: "DINING_SESSION_VERSION_CONFLICT" };

describe("Dining Move-backed fresh Join persistence", () => {
  it("reads coherent scoped Session, latest generation and committed Move facts", async () => {
    const x = fixture();
    const result = await x.store.resolveMovedJoinState(parseDiningReference(id(5)));
    expect(result).toEqual({ session: x.move.session, capability: x.current, move: x.move });
    expect(Object.isFrozen(result?.move.command)).toBe(true);
    expect(x.query.mock.calls.at(-1)?.[1]).toEqual([id(1), id(2), id(3), id(5)]);
  });
  it("returns no moved path for missing facts", async () => {
    const x = fixture();
    x.query.mockResolvedValue({ rows: [] });
    expect(await x.store.resolveMovedJoinState(parseDiningReference(id(5)))).toBeNull();
  });
  it("does not replace normal current-assignment generation", async () => {
    const x = fixture();
    x.query.mockResolvedValue({
      rows: [{ session: x.move.session, capability: x.input.replacement, move: x.move }],
    });
    expect(await x.store.resolveMovedJoinState(parseDiningReference(id(5)))).toBeNull();
  });
  it.each(["tenantReference", "brandReference", "storeReference"])(
    "denies foreign bound %s",
    async (field) => {
      const x = fixture();
      const store = createPostgresDiningMovedJoinStore(
        x.runner,
        { ...scope, [field]: id(99) },
        credentials,
        hashes,
      );
      await expect(store.resolveMovedJoinState(parseDiningReference(id(5)))).rejects.toMatchObject(
        denied,
      );
    },
  );
  it("commits the fresh capability, linked original operation and public Audit without changing Session", async () => {
    const x = fixture();
    expect(await x.store.reissueAfterMove(x.input)).toEqual(x.original);
    const sql = x.query.mock.calls.map(([statement]) => statement);
    expect(sql.filter((statement) => statement.startsWith("UPDATE rms_dining"))).toHaveLength(1);
    expect(
      sql.some((statement) => statement.startsWith("INSERT INTO platform_audit.audit_record")),
    ).toBe(true);
    expect(
      x.query.mock.calls
        .find(([statement]) =>
          statement.startsWith("INSERT INTO rms_dining.dining_join_regeneration_operation"),
        )?.[1]
        .at(-1),
    ).toBe(x.move.operationReference);
    const locks = x.query.mock.calls
      .filter(([statement]) => statement.includes("pg_advisory_xact_lock"))
      .map(([, values]) => values[0]);
    expect(locks).toEqual([
      `DiningJoinRegeneration:${id(1)}:${id(2)}:${id(3)}:${id(22)}`,
      `DiningTable:${id(1)}:${id(2)}:${id(3)}:${id(6)}`,
    ]);
  });
  it("converges to original history without another write", async () => {
    const x = fixture();
    x.query.mockResolvedValue({ rows: [{ record: x.original, actorReference: id(8) }] });
    expect(await x.store.reissueAfterMove(x.input)).toEqual(x.original);
    expect(x.query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
  });
  it("denies reuse by another Actor", async () => {
    const x = fixture();
    x.query.mockResolvedValue({ rows: [{ record: x.original, actorReference: id(99) }] });
    await expect(x.store.reissueAfterMove(x.input)).rejects.toMatchObject({
      code: "DINING_SESSION_IDEMPOTENCY_CONFLICT",
    });
  });
  it.each(["session", "capability", "move"])(
    "fences changed current %s before writes",
    async (field) => {
      const x = fixture();
      const handler = x.query.getMockImplementation();
      if (!handler) throw new Error("fixture missing query");
      x.query.mockImplementation(async (sql, values) => {
        if (field === "session" && sql.includes("FROM rms_dining.dining_session "))
          return { rows: [{ session: { ...x.move.session, phase: "Closing", version: 3 } }] };
        if (field === "capability" && sql.includes("FROM rms_dining.dining_join_capability "))
          return { rows: [{ capability: x.input.replacement }] };
        if (field === "move" && sql.includes("FROM rms_dining.dining_session_move_operation "))
          return { rows: [] };
        return handler(sql, values);
      });
      await expect(x.store.reissueAfterMove(x.input)).rejects.toMatchObject(conflict);
      expect(x.query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
    },
  );
  it.each(["previous", "replacement", "move", "root"] as const)(
    "rejects extra %s input before opening a transaction",
    async (field) => {
      const x = fixture();
      const input = structuredClone(x.input);
      Object.defineProperty(field === "root" ? input : input[field], "extra", {
        value: true,
        enumerable: true,
      });
      await expect(x.store.reissueAfterMove(input)).rejects.toMatchObject(denied);
      expect(x.run).not.toHaveBeenCalled();
    },
  );
  it("bounds private query failures", async () => {
    const x = fixture();
    x.query.mockRejectedValue(new Error("synthetic private dependency text"));
    await expect(x.store.reissueAfterMove(x.input)).rejects.toMatchObject(denied);
    await expect(x.store.reissueAfterMove(x.input)).rejects.not.toThrow("synthetic private");
  });
});
