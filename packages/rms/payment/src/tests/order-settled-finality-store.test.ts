import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  revision: vi.fn(),
  price: vi.fn(),
  financial: vi.fn(),
  append: vi.fn(),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresOrderRevisionPosition: () => mock.revision,
  createPostgresOrderPricedAmountSource: () => mock.price,
}));
vi.mock("../infrastructure/order-financial-position.js", () => ({
  createPostgresOrderFinancialPosition: () => mock.financial,
}));
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: mock.append,
}));
import { createPostgresOrderSettledFinalityStore } from "../infrastructure/persistence/order-settled-finality-store.js";
import {
  parseOrderSettledFinality,
  type OrderSettledFinality,
} from "../application/order-settled-finality.js";
const id = (n: number) => "0190fad3-0000-7000-8000-" + String(n).padStart(12, "0"),
  digest = "sha256:" + "a".repeat(64),
  at = "2026-09-20T00:00:00.000Z";
beforeEach(() => {
  vi.resetAllMocks();
  mock.append.mockResolvedValue(undefined);
});
function setup() {
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    request = {
      finalityReference: id(4),
      operationReference: id(5),
      orderReference: id(6),
      expectedOrderVersion: 4,
      observedAt: at,
    };
  const common = { ...scope, orderReference: request.orderReference, observedAt: at },
    revision = { ...common, version: 4, checkpoint: id(7), snapshotDigest: digest };
  const price = {
    ...common,
    currencyCode: "CAD",
    pricedTotalMinor: 1000n,
    pendingAmendmentCount: 0,
    snapshotDigest: digest,
  };
  const financial = {
    ...common,
    providerAccountReference: id(8),
    environment: "Test",
    currencyCode: "CAD",
    capturedMinor: 1200n,
    capturedOrderAllocationMinor: 1000n,
    capturedTipMinor: 200n,
    confirmedRefundMinor: 0n,
    pendingRefundMinor: 0n,
    unresolvedAttemptCount: 0,
    snapshotDigest: digest,
  };
  mock.revision.mockResolvedValue(revision);
  mock.price.mockResolvedValue(price);
  mock.financial.mockResolvedValue(financial);
  const prior: Record<string, unknown>[] = [];
  const query = vi.fn().mockImplementation(async (sql: string) => ({
      rows: sql.includes("operation_id=$5") || sql.includes("finality_id=$5") ? prior : [],
      rowCount: sql.startsWith("INSERT") ? 1 : 0,
    })),
    tx = { query };
  const authorize = vi.fn(async () => true),
    audit = vi.fn(async (record: OrderSettledFinality) => ({
      auditId: id(9),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode: "ORDER_FINANCIAL_FINALITY_RECORDED",
      targetType: "Order",
      targetId: record.orderReference,
      afterSummary: { classification: "Settled" },
      reasonCode: "ORDER_SETTLED",
      correlationId: record.operationReference,
      occurredAt: record.decidedAt,
      sourceChannel: "INTERNAL_TEST",
      dataClassification: "Restricted",
      retentionPolicyCode: "PAYMENT_AUDIT",
      retentionPolicyVersion: 1,
    }));
  const store = createPostgresOrderSettledFinalityStore({
    scope,
    providerAccountReference: id(8),
    environment: "Test",
    authorize,
    audit,
  });
  return {
    scope,
    request,
    revision,
    price,
    financial,
    prior,
    query,
    tx,
    authorize,
    audit,
    store,
    run: () => store.commit(tx, request),
  };
}
it("recomputes both owners and saves scoped finality with Audit", async () => {
  const f = setup(),
    result = await f.run();
  expect(result.status).toBe("Committed");
  expect(result.record.classification).toBe("Settled");
  expect(result.record.capturedTipMinor).toBe("200");
  expect(result.record.orderVersion).toBe(4);
  expect(mock.append).toHaveBeenCalledWith(f.tx, expect.any(Object));
  expect(mock.revision.mock.invocationCallOrder[0]).toBeLessThan(
    mock.financial.mock.invocationCallOrder[0] ?? -1,
  );
});
it.each(["balance", "refund", "unknown", "amendment", "version", "scope", "time"])(
  "refuses changed/nonfinal source %s",
  async (kind) => {
    const f = setup();
    if (kind === "balance") f.price.pricedTotalMinor = 1200n;
    if (kind === "refund") f.financial.confirmedRefundMinor = 1n;
    if (kind === "unknown") f.financial.unresolvedAttemptCount = 1;
    if (kind === "amendment") f.price.pendingAmendmentCount = 1;
    if (kind === "version") f.revision.version = 5;
    if (kind === "scope") f.financial.storeReference = id(40);
    if (kind === "time") f.price.observedAt = "2026-09-21T00:00:00.000Z";
    await expect(f.run()).rejects.toThrow("ORDER_SETTLED_FINALITY_UNAVAILABLE");
    expect(mock.append).not.toHaveBeenCalled();
  },
);
it("exact replay preserves original evidence and rejects changed operation intent", async () => {
  const f = setup(),
    first = await f.run();
  f.prior.push(first.record);
  mock.append.mockClear();
  mock.financial.mockClear();
  expect((await f.run()).status).toBe("AlreadyCommitted");
  expect(mock.append).not.toHaveBeenCalled();
  expect(mock.financial).not.toHaveBeenCalled();
  await expect(f.store.commit(f.tx, { ...f.request, orderReference: id(40) })).rejects.toThrow();
});
it("audit failure rolls back financial finality", async () => {
  const f = setup();
  mock.append.mockRejectedValue(new Error("audit"));
  await expect(f.run()).rejects.toThrow();
  expect(f.query.mock.calls.some(([sql]) => String(sql).startsWith("ROLLBACK TO SAVEPOINT"))).toBe(
    true,
  );
});
it("current authority is required immediately before writing", async () => {
  const f = setup();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.run()).rejects.toThrow();
  expect(mock.append).not.toHaveBeenCalled();
});
it("stored fact parser rejects financial components that do not settle", async () => {
  const f = setup(),
    result = await f.run();
  expect(() =>
    parseOrderSettledFinality({ ...result.record, pricedOrderTotalMinor: "1200" }),
  ).toThrow();
  expect(() =>
    parseOrderSettledFinality({ ...result.record, classification: "AuthorizedWriteOff" }),
  ).toThrow();
});

function readRequest(f: ReturnType<typeof setup>) {
  return {
    finalityReference: f.request.finalityReference,
    orderReference: f.request.orderReference,
    expectedOrderVersion: f.request.expectedOrderVersion,
    observedAt: f.request.observedAt,
  };
}
it("reads exact historical finality without new writes or current settlement claims", async () => {
  const f = setup(),
    first = await f.run();
  f.prior.push(first.record);
  mock.append.mockClear();
  mock.financial.mockClear();
  f.audit.mockClear();
  expect(await f.store.readFinality(f.tx, readRequest(f))).toEqual(first.record);
  expect(mock.append).not.toHaveBeenCalled();
  expect(mock.financial).not.toHaveBeenCalled();
  expect(f.audit).not.toHaveBeenCalled();
});
it("authorizes missing lookup before and after, denying revoked authority", async () => {
  const f = setup();
  expect(await f.store.readFinality(f.tx, readRequest(f))).toBeNull();
  expect(f.authorize).toHaveBeenCalledTimes(2);
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.store.readFinality(f.tx, readRequest(f))).rejects.toThrow();
});
it("denies before querying when authority is absent", async () => {
  const f = setup();
  f.authorize.mockResolvedValue(false);
  await expect(f.store.readFinality(f.tx, readRequest(f))).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
it.each([
  "tenantReference",
  "storeReference",
  "orderReference",
  "finalityReference",
  "providerAccountReference",
  "orderVersion",
  "decidedAt",
])("rejects mismatched historical %s", async (key) => {
  const f = setup(),
    first = await f.run();
  f.prior.push({
    ...first.record,
    [key]: key === "orderVersion" ? 5 : key === "decidedAt" ? "2026-09-21T00:00:00.000Z" : id(99),
  });
  await expect(f.store.readFinality(f.tx, readRequest(f))).rejects.toThrow();
});

it("commits gross finality bound to proven ordinary refund allocation", async () => {
  const f = setup();
  mock.financial.mockResolvedValue({
    ...f.financial,
    confirmedRefundMinor: 600n,
    refundAllocation: { orderMinor: 500n, tipMinor: 100n, unallocatedMinor: 0n },
  });
  const result = await f.run();
  expect(result.status).toBe("Committed");
  expect(result.record.capturedMinor).toBe("1200");
  expect(result.record.pricedOrderTotalMinor).toBe("1000");
  expect(result.record.paymentEvidenceDigest).toBe(f.financial.snapshotDigest);
});
it("does not commit finality for unallocated confirmed refund", async () => {
  const f = setup();
  mock.financial.mockResolvedValue({
    ...f.financial,
    confirmedRefundMinor: 600n,
    refundAllocation: { orderMinor: 0n, tipMinor: 0n, unallocatedMinor: 600n },
  });
  await expect(f.run()).rejects.toThrow();
  expect(mock.append).not.toHaveBeenCalled();
});
