const mock = vi.hoisted(() => ({ session: vi.fn(), audit: vi.fn() }));
vi.mock("../infrastructure/persistence/dining-closing-fence.js", () => ({
  createPostgresDiningClosingFence: () => mock.session,
}));
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: mock.audit,
}));
import { createPostgresDiningTableReleaseStore } from "../index.js";
import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import { beforeEach, expect, it, vi } from "vitest";
import {
  createDiningTable,
  parseDiningSession,
  releaseClosedDiningSession,
  parseDiningInstant,
} from "../index.js";
const id = (n: number) => "0190fad8-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = parseDiningInstant("2026-09-20T00:00:00.000Z"),
  hashes = {
    hashIntent: (v: string) => "sha256:" + createHash("sha256").update(v).digest("hex"),
    equals: (a: string, b: string) => a === b,
  };
function fixture() {
  const beforeTable = createDiningTable({
    tableReference: id(1),
    tenantReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    stableLabel: "T1",
    areaReference: id(5),
    areaCode: "DINING",
    capacity: 4,
    accessibilityAttributes: [],
    lifecycle: "Published",
    qrStatus: "Active",
    qrVersion: 1,
    operationalState: "Available",
    blockReasonCode: null,
    activeDiningSessionReference: id(6),
    aggregateVersion: 2,
    createdAt: at,
    observedAt: at,
  });
  const session = parseDiningSession({
    diningSessionReference: id(6),
    brandReference: id(3),
    storeReference: id(4),
    tableReference: id(1),
    tableAssignmentVersion: 1,
    phase: "Closed",
    version: 3,
    startedByActorReference: id(7),
    startedAt: at,
    hostParticipantReference: null,
  });
  const command = {
    operationReference: id(8),
    diningSessionReference: id(6),
    tableReference: id(1),
    expectedSessionVersion: 3,
    expectedTableVersion: 2,
    observedAt: at,
  };
  const audit = {
    auditId: id(9),
    brandId: id(3),
    storeId: id(4),
    actor: { type: "User", reference: id(7) },
    actionCode: "DINING_TABLE_RELEASED",
    targetType: "DiningTable",
    targetId: id(1),
    reasonCode: "CUSTOMER_FINISHED",
    correlationId: id(8),
    occurredAt: at,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  };
  return {
    command,
    intentDigest: hashes.hashIntent(
      canonicalizeRfc8785({
        tenantReference: beforeTable.tenantReference,
        brandReference: beforeTable.brandReference,
        storeReference: beforeTable.storeReference,
        ...command,
      }),
    ),
    session,
    beforeTable,
    afterTable: releaseClosedDiningSession(session, beforeTable, at),
    audit,
  };
}

beforeEach(() => vi.resetAllMocks());
function setup() {
  const record = fixture(),
    prior: unknown[] = [];
  mock.session.mockResolvedValue(record.session);
  mock.audit.mockResolvedValue(undefined);
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("SELECT record_json")
      ? prior
      : sql.includes("SELECT table_snapshot")
        ? [{ snapshot: record.beforeTable }]
        : [],
    rowCount: sql.startsWith("UPDATE") || sql.startsWith("INSERT") ? 1 : 0,
  }));
  const authorize = vi.fn(async () => true),
    tx = { query };
  const store = createPostgresDiningTableReleaseStore({
    scope: {
      tenantReference: record.beforeTable.tenantReference,
      brandReference: record.beforeTable.brandReference,
      storeReference: record.beforeTable.storeReference,
    },
    hashes,
    authorize,
  });
  return { record, prior, query, authorize, store, tx, run: () => store.commit(tx, record) };
}
it("writes table, receipt and Audit once then returns exact original receipt", async () => {
  const f = setup();
  expect((await f.run()).status).toBe("Applied");
  expect(mock.audit).toHaveBeenCalledTimes(1);
  f.prior.push({ record: f.record });
  f.query.mockClear();
  mock.audit.mockClear();
  expect((await f.run()).status).toBe("AlreadyApplied");
  expect(mock.audit).not.toHaveBeenCalled();
  expect(
    f.query.mock.calls.some((c) => c[0].startsWith("UPDATE") || c[0].startsWith("INSERT")),
  ).toBe(false);
});
it("denies before any query without current authorization", async () => {
  const f = setup();
  f.authorize.mockResolvedValue(false);
  await expect(f.run()).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
it("rolls back table and receipt when Audit fails", async () => {
  const f = setup();
  mock.audit.mockRejectedValue(new Error("audit"));
  await expect(f.run()).rejects.toThrow();
  expect(
    f.query.mock.calls.some((c) => c[0] === "ROLLBACK TO SAVEPOINT dining_table_release"),
  ).toBe(true);
});
it("rejects changed locked session before table write", async () => {
  const f = setup();
  mock.session.mockResolvedValue({ ...f.record.session, version: 99 });
  await expect(f.run()).rejects.toThrow();
  expect(f.query.mock.calls.some((c) => c[0].startsWith("UPDATE"))).toBe(false);
});
it("rejects changed audit identity under same operation", async () => {
  const f = setup();
  f.prior.push({ record: { ...f.record, audit: { ...f.record.audit, auditId: id(99) } } });
  await expect(f.run()).rejects.toThrow();
  expect(mock.audit).not.toHaveBeenCalled();
});

function receiptQuery(f: ReturnType<typeof setup>) {
  return {
    operationReference: f.record.command.operationReference,
    diningSessionReference: f.record.command.diningSessionReference,
    observedAt: f.record.command.observedAt,
  };
}
it("reads original authorized receipt without current availability claim", async () => {
  const f = setup();
  f.prior.push({ record: f.record });
  expect(await f.store.readReceipt(f.tx, receiptQuery(f), async () => true)).toEqual(f.record);
  expect(mock.audit).not.toHaveBeenCalled();
  expect(mock.session).not.toHaveBeenCalled();
});
it("checks missing lookup authority twice", async () => {
  const f = setup(),
    allow = vi.fn(async () => true);
  expect(await f.store.readReceipt(f.tx, receiptQuery(f), allow)).toBeNull();
  expect(allow).toHaveBeenCalledTimes(2);
});
it("rejects missing lookup when authority revoked", async () => {
  const f = setup(),
    allow = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.store.readReceipt(f.tx, receiptQuery(f), allow)).rejects.toThrow();
});
it("rejects foreign session receipt", async () => {
  const f = setup();
  f.prior.push({ record: f.record });
  await expect(
    f.store.readReceipt(
      f.tx,
      { ...receiptQuery(f), diningSessionReference: id(99) },
      async () => true,
    ),
  ).rejects.toThrow();
});
it("requires record authority as well as lookup authority", async () => {
  const f = setup();
  f.prior.push({ record: f.record });
  f.authorize.mockResolvedValue(false);
  await expect(f.store.readReceipt(f.tx, receiptQuery(f), async () => true)).rejects.toThrow();
});
