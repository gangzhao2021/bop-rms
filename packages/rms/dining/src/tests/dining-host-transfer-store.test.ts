import { beforeEach, expect, it, vi } from "vitest";
import {
  createPostgresDiningHostTransferStore,
  createPostgresDiningHostTransferSelection,
} from "../infrastructure/persistence/dining-host-transfer-store.js";
import type { DiningTableTransaction } from "../infrastructure/persistence/dining-table-store.js";
const m = vi.hoisted(() => ({ fence: vi.fn(), audit: vi.fn() }));
vi.mock("../infrastructure/persistence/dining-closing-fence.js", () => ({
  createPostgresDiningClosingFence: () => m.fence,
}));
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: m.audit,
}));
const id = (n: number) => "0190fa40-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-21T03:30:00.000Z",
  started = "2026-09-21T01:00:00.000Z";
function facts() {
  return {
    command: {
      operationReference: id(1),
      tenantReference: id(2),
      brandReference: id(3),
      storeReference: id(4),
      diningSessionReference: id(5),
      actorType: "Staff",
      actorReference: id(6),
      targetParticipantReference: id(8),
      expectedSessionVersion: 4,
      expectedHostParticipantReference: id(7),
      purposeCode: "TransferDiningHost",
      permissionCode: "dining.host.transfer",
      reasonCode: "HOST_UNAVAILABLE",
      observedAt: at,
    },
    session: {
      diningSessionReference: id(5),
      brandReference: id(3),
      storeReference: id(4),
      tableReference: id(9),
      tableAssignmentVersion: 2,
      phase: "Active",
      version: 4,
      startedByActorReference: id(10),
      startedAt: started,
      hostParticipantReference: id(7),
    },
    targetParticipant: {
      participantReference: id(8),
      diningSessionReference: id(5),
      status: "Active",
      version: 1,
      joinedAt: "2026-09-21T02:00:00.000Z",
      leftAt: null,
    },
  };
}

function setup() {
  const f = facts();
  let receipt: unknown = null,
    version = 4,
    commits = 0,
    rollbacks = 0;
  const query = vi.fn<DiningTableTransaction["query"]>(async (sql, values) => {
    if (sql.includes("set_config") || sql.includes("pg_advisory")) return { rows: [] };
    if (sql.startsWith("SELECT record_json")) return { rows: receipt ? [{ record: receipt }] : [] };
    if (sql.startsWith("SELECT participant_snapshot"))
      return { rows: [{ participant: f.targetParticipant }] };
    if (sql.startsWith("UPDATE rms_dining.dining_session")) {
      version = 5;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO")) {
      receipt = JSON.parse(String(values[8]));
      return { rows: [{ operation_id: f.command.operationReference }] };
    }
    throw new Error("unexpected SQL");
  });
  const tx = { query };
  const authorize = vi.fn(async () => true);
  const now = vi.fn(() => at);
  const audit = vi.fn(() => ({
    auditId: id(20),
    brandId: f.command.brandReference,
    storeId: f.command.storeReference,
    actor: { type: "User", reference: f.command.actorReference },
    actionCode: "DINING_HOST_TRANSFERRED",
    targetType: "DiningSession",
    targetId: f.command.diningSessionReference,
    correlationId: f.command.operationReference,
    reasonCode: f.command.reasonCode,
    occurredAt: at,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  }));
  const store = createPostgresDiningHostTransferStore(
    {
      run: async (work) => {
        const old = receipt,
          v = version;
        try {
          const result = await work(tx);
          commits++;
          return result;
        } catch (error) {
          receipt = old;
          version = v;
          rollbacks++;
          throw error;
        }
      },
    },
    {
      scope: {
        tenantReference: f.command.tenantReference,
        brandReference: f.command.brandReference,
        storeReference: f.command.storeReference,
      },
      now,
      authorize,
      audit,
    },
  );
  m.fence.mockResolvedValue(f.session);
  return {
    f,
    store,
    query,
    tx,
    authorize,
    now,
    audit,
    state: () => ({ receipt, version, commits, rollbacks }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  m.audit.mockResolvedValue(undefined);
});
it("updates session/history/Audit atomically and recovers original operation before current facts", async () => {
  const f = setup();
  const first = await f.store.transfer(f.f.command);
  expect(first.status).toBe("Applied");
  expect(first.record.previousSession.hostParticipantReference).toBe(id(7));
  expect(first.record.session.hostParticipantReference).toBe(id(8));
  expect(m.fence.mock.calls[0]?.[0]).toBe(f.tx);
  expect(m.audit.mock.calls[0]?.[0]).toBe(f.tx);
  f.query.mockClear();
  m.fence.mockClear();
  const retry = await f.store.transfer(f.f.command);
  expect(retry).toEqual({ status: "AlreadyApplied", record: first.record });
  expect(m.fence).not.toHaveBeenCalled();
  expect(m.audit).toHaveBeenCalledTimes(1);
  expect(f.query.mock.calls.some(([sql]) => /^(UPDATE|INSERT)/.test(sql))).toBe(false);
});
it("rejects operation rebinding", async () => {
  const f = setup();
  await f.store.transfer(f.f.command);
  await expect(f.store.transfer({ ...f.f.command, reasonCode: "OTHER" })).rejects.toMatchObject({
    code: "DINING_HOST_TRANSFER_INVALID",
  });
  expect(f.state().version).toBe(5);
  expect(m.audit).toHaveBeenCalledTimes(1);
});
it("refuses authorization before any SQL", async () => {
  const f = setup();
  f.authorize.mockResolvedValue(false);
  await expect(f.store.transfer(f.f.command)).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
it.each(["version", "host", "target", "scope"])(
  "refuses stale or foreign %s before mutation",
  async (kind) => {
    const f = setup();
    let command = f.f.command;
    if (kind === "version") m.fence.mockResolvedValue({ ...f.f.session, version: 5 });
    if (kind === "host")
      m.fence.mockResolvedValue({ ...f.f.session, hostParticipantReference: id(99) });
    if (kind === "target") f.f.targetParticipant.status = "Left";
    if (kind === "scope") command = { ...command, tenantReference: id(99) };
    await expect(f.store.transfer(command)).rejects.toThrow();
    expect(f.query.mock.calls.some(([sql]) => /^(UPDATE|INSERT)/.test(sql))).toBe(false);
  },
);
it("rolls back changed session/history when Audit fails", async () => {
  const f = setup();
  m.audit.mockRejectedValueOnce(new Error("private"));
  await expect(f.store.transfer(f.f.command)).rejects.toThrow();
  expect(f.state()).toEqual({ receipt: null, version: 4, commits: 0, rollbacks: 1 });
});
it("rolls back after permission is revoked at final check", async () => {
  const f = setup();
  m.audit.mockImplementationOnce(async () => {
    f.authorize.mockResolvedValue(false);
  });
  await expect(f.store.transfer(f.f.command)).rejects.toThrow();
  expect(f.state()).toEqual({ receipt: null, version: 4, commits: 0, rollbacks: 1 });
});
it("refuses mismatched Audit actor before mutation", async () => {
  const f = setup();
  const original = f.audit();
  f.audit.mockReturnValue({ ...original, actor: { type: "User", reference: id(99) } });
  await expect(f.store.transfer(f.f.command)).rejects.toThrow();
  expect(f.query.mock.calls.some(([sql]) => /^(UPDATE|INSERT)/.test(sql))).toBe(false);
});

it("returns original receipt when server observation time advances on retry", async () => {
  const f = setup();
  const first = await f.store.transfer(f.f.command);
  const later = "2026-09-21T03:31:00.000Z";
  f.now.mockReturnValue(later);
  const retry = await f.store.transfer({ ...f.f.command, observedAt: later });
  expect(retry).toEqual({ status: "AlreadyApplied", record: first.record });
  expect(retry.record.command.observedAt).toBe(at);
  expect(m.audit).toHaveBeenCalledTimes(1);
});

function selection() {
  const f = facts(),
    authorize = vi.fn(async () => true),
    query = vi.fn<DiningTableTransaction["query"]>(async () => ({
      rows: [{ participant: f.targetParticipant }],
    })),
    tx = { query };
  m.fence.mockResolvedValue(f.session);
  const store = createPostgresDiningHostTransferSelection(
    { run: (work) => work(tx) },
    {
      scope: {
        tenantReference: f.command.tenantReference,
        brandReference: f.command.brandReference,
        storeReference: f.command.storeReference,
      },
      now: () => at,
      authorize,
    },
  );
  return { f, query, authorize, store, tx };
}
it("reads bounded current participants under the shared session fence without writes", async () => {
  const f = selection();
  const result = await f.store.readCurrent({
    diningSessionReference: f.f.command.diningSessionReference,
  });
  expect(result).toMatchObject({
    sessionVersion: 4,
    hostParticipantReference: id(7),
    participants: [{ participantReference: id(8), isHost: false }],
  });
  expect(m.fence.mock.calls[0]?.[0]).toBe(f.tx);
  expect(f.query.mock.calls[0]?.[0]).toContain("LIMIT 101 FOR SHARE");
  expect(result.participants[0]).not.toHaveProperty("diningSessionReference");
});
it.each(["overflow", "duplicate", "foreign", "future", "left"])(
  "refuses incomplete or invalid participant selection %s",
  async (kind) => {
    const f = selection();
    const p = f.f.targetParticipant;
    if (kind === "overflow")
      f.query.mockResolvedValue({ rows: Array.from({ length: 101 }, () => ({ participant: p })) });
    if (kind === "duplicate")
      f.query.mockResolvedValue({ rows: [{ participant: p }, { participant: p }] });
    if (kind === "foreign") p.diningSessionReference = id(99);
    if (kind === "future") p.joinedAt = "2026-09-22T00:00:00.000Z";
    if (kind === "left") p.status = "Left";
    await expect(f.store.readCurrent({ diningSessionReference: id(5) })).rejects.toThrow();
  },
);
it("does not expose selection after authority loss", async () => {
  const f = selection();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.store.readCurrent({ diningSessionReference: id(5) })).rejects.toThrow();
});
