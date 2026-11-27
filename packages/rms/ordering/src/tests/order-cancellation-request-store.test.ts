import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingReference } from "../domain/cart.js";
import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ append: vi.fn() }));
vi.mock("@bop/audit", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  appendAuditRecordInTransaction: mock.append,
}));
import { createPostgresOrderCancellationRequestStore } from "../infrastructure/persistence/order-cancellation-request-store.js";
import { parseOrderCancellationRequest } from "../domain/order-cancellation-request.js";
const id = (n: number) => "0190face-0000-7000-8000-" + String(n).padStart(12, "0");
const requested = {
  requestReference: id(1),
  operationReference: id(2),
  intentDigest: "sha256:" + "a".repeat(64),
  tenantReference: id(3),
  brandReference: id(4),
  storeReference: id(5),
  orderReference: id(6),
  version: 1,
  expectedOrderVersion: 2,
  requestedByActorReference: id(7),
  requestedByActorType: "GuestSession",
  requestReasonCode: "CUSTOMER_REQUEST",
  requestedAt: "2026-09-20T00:00:00.000Z",
  status: "Requested",
  decidedByActorReference: null,
  decisionReasonCode: null,
  executionReference: null,
  occurredAt: "2026-09-20T00:00:00.000Z",
};
const approved = {
  ...requested,
  operationReference: id(8),
  version: 2,
  status: "Approved",
  decidedByActorReference: id(9),
  decisionReasonCode: "STAFF_CONFIRMED",
  occurredAt: "2026-09-20T00:01:00.000Z",
};
const executed = {
  ...approved,
  operationReference: id(10),
  version: 3,
  status: "Executed",
  executionReference: id(11),
  occurredAt: "2026-09-20T00:02:00.000Z",
};

beforeEach(() => {
  vi.resetAllMocks();
  mock.append.mockResolvedValue(undefined);
});
function setup() {
  const rows: Record<string, unknown>[] = [];
  const prior: Record<string, unknown>[] = [];
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM rms_ordering.order_header"))
      return {
        rows: [{ order_id: requested.orderReference, created_at: new Date(requested.requestedAt) }],
        rowCount: 1,
      };
    if (sql.includes("operation_id=$3")) return { rows: prior, rowCount: prior.length };
    if (sql.includes("FROM rms_ordering.order_cancellation_request_version"))
      return { rows, rowCount: rows.length };
    return { rows: [], rowCount: sql.startsWith("INSERT") ? 1 : 0 };
  });
  const tx: ConsumerTransaction = {
    async query<Row>(sql: string) {
      const result = await query(sql);
      return { rows: result.rows as readonly Row[], rowCount: result.rowCount };
    },
  };
  const authorize = vi.fn(async () => true),
    validateCurrentSource = vi.fn(async () => true);
  const audit = vi.fn(async (record: ReturnType<typeof parseOrderCancellationRequest>) => ({
    auditId: id(20),
    brandId: record.brandReference,
    storeId: record.storeReference,
    actor:
      record.status === "Requested"
        ? { type: "System" }
        : { type: "User", reference: record.decidedByActorReference },
    actionCode: "ORDER_CANCELLATION_REQUEST_RECORDED",
    targetType: "OrderCancellationRequest",
    targetId: record.requestReference,
    afterSummary: { status: record.status, version: record.version },
    reasonCode: record.decisionReasonCode ?? record.requestReasonCode,
    correlationId: record.operationReference,
    occurredAt: record.occurredAt,
    sourceChannel: "INTERNAL_TEST",
    dataClassification: "Restricted",
    retentionPolicyCode: "ORDER_AUDIT",
    retentionPolicyVersion: 1,
  }));
  const store = createPostgresOrderCancellationRequestStore({
    tenantReference: requested.tenantReference,
    brandReference: requested.brandReference,
    storeReference: requested.storeReference,
    authorize,
    validateCurrentSource,
    audit,
  });
  return {
    rows,
    query,
    prior,
    tx,
    authorize,
    validateCurrentSource,
    audit,
    store,
    load: () =>
      store.loadPosition(tx, {
        orderReference: requested.orderReference,
        observedAt: executed.occurredAt,
      }),
  };
}
it("distinguishes known empty from missing or denied evidence", async () => {
  const f = setup();
  expect((await f.load()).pendingCount).toBe(0);
  f.authorize.mockResolvedValue(false);
  await expect(f.load()).rejects.toThrow("ORDER_CANCELLATION_STORE_UNAVAILABLE");
});
it("retains approved request as pending and terminal history as resolved", async () => {
  const f = setup();
  f.rows.push(requested, approved);
  expect((await f.load()).pendingCount).toBe(1);
  f.rows.push(executed);
  const result = await f.load();
  expect(result.pendingCount).toBe(0);
  expect(Object.isFrozen(result.requests)).toBe(true);
});
it.each(["gap", "scope", "future"])("rejects incomplete/unbound history %s", async (kind) => {
  const f = setup();
  f.rows.push(
    kind === "gap"
      ? approved
      : kind === "scope"
        ? { ...requested, tenantReference: id(40) }
        : {
            ...requested,
            requestedAt: "2026-09-21T00:00:00.000Z",
            occurredAt: "2026-09-21T00:00:00.000Z",
          },
  );
  await expect(f.load()).rejects.toThrow();
});
it("appends owner fact and Audit in the same caller transaction", async () => {
  const f = setup();
  const result = await f.store.commit(f.tx, requested);
  expect(result.status).toBe("Committed");
  expect(mock.append).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({ actor: { type: "System" } }),
  );
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith("RELEASE SAVEPOINT"))).toBe(true);
  expect(f.validateCurrentSource).toHaveBeenCalledOnce();
});
it("rolls back its fact if Audit fails", async () => {
  const f = setup();
  mock.append.mockRejectedValue(new Error("audit failure"));
  await expect(f.store.commit(f.tx, requested)).rejects.toThrow();
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith("ROLLBACK TO SAVEPOINT"))).toBe(true);
});
it("exact operation replay avoids duplicate audit or current-state mutation", async () => {
  const f = setup();
  f.prior.push(requested);
  expect((await f.store.commit(f.tx, requested)).status).toBe("AlreadyCommitted");
  expect(mock.append).not.toHaveBeenCalled();
  expect(f.validateCurrentSource).not.toHaveBeenCalled();
  await expect(
    f.store.commit(f.tx, { ...requested, intentDigest: "sha256:" + "b".repeat(64) }),
  ).rejects.toThrow();
});
it("rejects stale source and a second pending request", async () => {
  const f = setup();
  f.validateCurrentSource.mockResolvedValue(false);
  await expect(f.store.commit(f.tx, requested)).rejects.toThrow();
  expect(mock.append).not.toHaveBeenCalled();
  f.validateCurrentSource.mockResolvedValue(true);
  f.rows.push({ ...requested, requestReference: id(40), operationReference: id(41) });
  await expect(f.store.commit(f.tx, requested)).rejects.toThrow();
});
it("reauthorizes before write and binds decision Audit actor", async () => {
  const f = setup();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.store.commit(f.tx, requested)).rejects.toThrow();
  expect(mock.append).not.toHaveBeenCalled();
  const g = setup();
  g.rows.push(requested);
  const audit = await g.audit(parseOrderCancellationRequest(approved));
  g.audit.mockResolvedValue({
    ...audit,
    actor: { type: "User", reference: parseOrderingReference(id(40)) },
  });
  await expect(g.store.commit(g.tx, approved)).rejects.toThrow();
  expect(mock.append).not.toHaveBeenCalled();
});
