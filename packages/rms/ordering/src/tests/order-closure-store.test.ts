import { beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
const mock = vi.hoisted(() => ({ position: vi.fn(), append: vi.fn() }));
vi.mock("../infrastructure/persistence/order-closure-position.js", () => ({
  createPostgresOrderClosurePosition: () => mock.position,
}));
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: mock.append,
}));
import { createPostgresOrderClosureStore } from "../infrastructure/persistence/order-closure-store.js";
import { parseOrderClosureRecord } from "../domain/order-closure-record.js";
const id = (n: number) => "0190fad2-0000-7000-8000-" + String(n).padStart(12, "0");
const closed = {
  closureReference: id(1),
  operationReference: id(2),
  tenantReference: id(3),
  brandReference: id(4),
  storeReference: id(5),
  orderReference: id(6),
  closureVersion: 1,
  orderVersion: 4,
  previousClosureReference: null,
  status: "Closed",
  actorType: "System",
  actorReference: null,
  reasonCode: "ORDER_COMPLETE",
  financialFinalityReference: id(7),
  evidenceDigest: "sha256:" + "a".repeat(64),
  occurredAt: "2026-09-20T00:01:00.000Z",
};
const reopened = {
  ...closed,
  closureReference: id(8),
  operationReference: id(9),
  closureVersion: 2,
  previousClosureReference: id(1),
  status: "Open",
  actorType: "User",
  actorReference: id(10),
  reasonCode: "MANAGER_CORRECTION",
  financialFinalityReference: null,
  occurredAt: "2026-09-20T00:02:00.000Z",
};

const digest = (value: unknown) =>
  "sha256:" + createHash("sha256").update(canonicalizeRfc8785(value)).digest("hex");
beforeEach(() => {
  vi.resetAllMocks();
  mock.append.mockResolvedValue(undefined);
});
function setup(reopen = false) {
  const closeEvidence = {
    brandReference: closed.brandReference,
    storeReference: closed.storeReference,
    orderReference: closed.orderReference,
    orderVersion: closed.orderVersion,
    observedAt: closed.occurredAt,
    inventoryComplete: true,
    batches: [{ batchReference: id(30), state: "Fulfilled" }],
    items: [{ itemReference: id(31), batchReference: id(30), state: "Fulfilled" }],
    fulfillmentState: "Fulfilled",
    pendingAmendmentCount: 0,
    pendingCancellationCount: 0,
    criticalBlockingTaskCount: 0,
    financialFinality: {
      orderReference: closed.orderReference,
      class: "Settled",
      ownerFinalityReference: closed.financialFinalityReference,
      decidedAt: closed.occurredAt,
    },
  };
  const reopenEvidence = {
    brandReference: closed.brandReference,
    storeReference: closed.storeReference,
    orderReference: closed.orderReference,
    orderVersion: closed.orderVersion,
    observedAt: reopened.occurredAt,
    actorReference: reopened.actorReference,
    managerQualified: true,
    settlementPeriodUnlocked: true,
    accountingPeriodUnlocked: true,
    ownerEvidenceReference: id(32),
  };
  const record = {
    ...(reopen ? reopened : closed),
    evidenceDigest: digest(reopen ? reopenEvidence : closeEvidence),
  };
  const current = {
    orderVersion: 4,
    closureVersion: reopen ? 1 : 0,
    closureReference: reopen ? closed.closureReference : null,
    status: reopen ? "Closed" : "Open",
  };
  mock.position.mockResolvedValue(current);
  const prior: Record<string, unknown>[] = [];
  const query = vi.fn();
  query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("operation_id=$3") ? prior : [],
    rowCount: sql.startsWith("INSERT") ? 1 : 0,
  }));
  const authorize = vi.fn(async () => true),
    tx = { query };
  const closeSource = vi.fn(async () => closeEvidence),
    reopenSource = vi.fn(async () => reopenEvidence);
  const audit = vi.fn(async (input: ReturnType<typeof parseOrderClosureRecord>) => ({
    auditId: id(33),
    brandId: input.brandReference,
    storeId: input.storeReference,
    actor:
      input.actorType === "System"
        ? { type: "System" }
        : { type: "User", reference: input.actorReference },
    actionCode: "ORDER_CLOSURE_RECORDED",
    targetType: "Order",
    targetId: input.orderReference,
    afterSummary: { status: input.status, closureVersion: input.closureVersion },
    reasonCode: input.reasonCode,
    correlationId: input.operationReference,
    occurredAt: input.occurredAt,
    sourceChannel: "INTERNAL_TEST",
    dataClassification: "Restricted",
    retentionPolicyCode: "ORDER_AUDIT",
    retentionPolicyVersion: 1,
  }));
  const store = createPostgresOrderClosureStore({
    tenantReference: closed.tenantReference,
    brandReference: closed.brandReference,
    storeReference: closed.storeReference,
    authorize,
    closeEvidence: closeSource,
    reopenEvidence: reopenSource,
    audit,
  });
  return {
    record,
    current,
    prior,
    query,
    tx,
    authorize,
    closeEvidence,
    reopenEvidence,
    closeSource,
    reopenSource,
    store,
    run: () => store.commit(tx, record),
  };
}
it.each([false, true])(
  "commits closure/reopen=%s with Audit in same transaction",
  async (reopen) => {
    const f = setup(reopen);
    expect((await f.run()).status).toBe("Committed");
    expect(mock.append).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({ targetId: closed.orderReference }),
    );
    expect(f.query.mock.calls.some(([sql]) => String(sql).startsWith("RELEASE SAVEPOINT"))).toBe(
      true,
    );
  },
);
it.each([
  "pendingCancellationCount",
  "pendingAmendmentCount",
  "criticalBlockingTaskCount",
] as const)("enforces full close blocker %s", async (field) => {
  const f = setup();
  f.closeEvidence[field] = 1;
  f.record.evidenceDigest = digest(f.closeEvidence);
  await expect(f.run()).rejects.toThrow();
  expect(mock.append).not.toHaveBeenCalled();
});
it.each(["managerQualified", "settlementPeriodUnlocked", "accountingPeriodUnlocked"] as const)(
  "refuses reopen when %s is false",
  async (field) => {
    const f = setup(true);
    f.reopenEvidence[field] = false;
    f.record.evidenceDigest = digest(f.reopenEvidence);
    await expect(f.run()).rejects.toThrow();
  },
);
it("rejects mismatched financial reference even with otherwise valid evidence", async () => {
  const f = setup();
  f.closeEvidence.financialFinality.ownerFinalityReference = id(40);
  f.record.evidenceDigest = digest(f.closeEvidence);
  await expect(f.run()).rejects.toThrow();
});
it("requires exact current version and evidence digest", async () => {
  const f = setup();
  f.current.orderVersion = 5;
  await expect(f.run()).rejects.toThrow();
  f.current.orderVersion = 4;
  f.record.evidenceDigest = "sha256:" + "f".repeat(64);
  await expect(f.run()).rejects.toThrow();
});
it("replays original operation without duplicate source decision or audit", async () => {
  const f = setup();
  f.prior.push(f.record);
  expect((await f.run()).status).toBe("AlreadyCommitted");
  expect(mock.append).not.toHaveBeenCalled();
  expect(f.closeSource).not.toHaveBeenCalled();
  await expect(f.store.commit(f.tx, { ...f.record, reasonCode: "CHANGED" })).rejects.toThrow();
});
it("rolls back closure insertion when audit append fails", async () => {
  const f = setup();
  mock.append.mockRejectedValue(new Error("audit"));
  await expect(f.run()).rejects.toThrow();
  expect(f.query.mock.calls.some(([sql]) => String(sql).startsWith("ROLLBACK TO SAVEPOINT"))).toBe(
    true,
  );
});
it("rechecks authority immediately before append", async () => {
  const f = setup();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.run()).rejects.toThrow();
  expect(mock.append).not.toHaveBeenCalled();
});

function operationQuery() {
  return {
    orderReference: closed.orderReference,
    operationReference: closed.operationReference,
    observedAt: closed.occurredAt,
  };
}
it("reads exact historical receipt without new evidence or writes", async () => {
  const f = setup();
  f.prior.push({ ...f.record, occurredAt: new Date(f.record.occurredAt) });
  const lookup = vi.fn(async () => true);
  expect(await f.store.readOperation(f.tx, operationQuery(), lookup)).toEqual(
    parseOrderClosureRecord(f.record),
  );
  expect(lookup).toHaveBeenCalledTimes(2);
  expect(mock.position).not.toHaveBeenCalled();
  expect(mock.append).not.toHaveBeenCalled();
});
it("authorized missing operation returns null under writer fences", async () => {
  const f = setup();
  expect(await f.store.readOperation(f.tx, operationQuery(), async () => true)).toBeNull();
  expect(
    f.query.mock.calls.filter(([sql]) => String(sql).includes("pg_advisory_xact_lock")),
  ).toHaveLength(2);
});
it.each([
  { orderReference: id(99) },
  { tenantReference: id(99) },
  { operationReference: id(99) },
  { occurredAt: "2026-09-21T00:00:00.000Z" },
])("refuses foreign/future historical receipt %#", async (change) => {
  const f = setup();
  f.prior.push({ ...f.record, ...change });
  await expect(f.store.readOperation(f.tx, operationQuery(), async () => true)).rejects.toThrow();
});
it("lookup and record authorization are independently current", async () => {
  const f = setup(),
    lookup = vi.fn(async () => false);
  await expect(f.store.readOperation(f.tx, operationQuery(), lookup)).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
  f.prior.push(f.record);
  f.authorize.mockResolvedValue(false);
  await expect(f.store.readOperation(f.tx, operationQuery(), async () => true)).rejects.toThrow();
});
it("revoked lookup cannot reveal an absent operation", async () => {
  const f = setup(),
    lookup = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.store.readOperation(f.tx, operationQuery(), lookup)).rejects.toThrow();
});
