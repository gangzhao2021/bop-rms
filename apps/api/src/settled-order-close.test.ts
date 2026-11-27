import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ payment: vi.fn(), closure: vi.fn(), options: vi.fn() }));
vi.mock("@rms/payment", () => ({
  createPostgresOrderSettledFinalityStore: () => ({ commit: mock.payment }),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresOrderClosureStore: (options: unknown) => {
    mock.options(options);
    return { commit: mock.closure };
  },
}));
import { createSettledOrderClose } from "./settled-order-close.js";
const id = (n: number) => "0190fad0-0000-7000-8000-" + String(n).padStart(12, "0");
beforeEach(() => vi.resetAllMocks());
function fixture() {
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
  const record = {
    ...scope,
    closureReference: id(4),
    operationReference: id(5),
    orderReference: id(6),
    closureVersion: 1,
    orderVersion: 3,
    previousClosureReference: null,
    status: "Closed",
    actorType: "System",
    actorReference: null,
    reasonCode: "ORDER_SETTLED",
    financialFinalityReference: id(7),
    evidenceDigest: "sha256:" + "a".repeat(64),
    occurredAt: "2026-09-20T00:00:00.000Z",
  };
  const fact = {
    ...scope,
    orderReference: id(6),
    orderVersion: 3,
    finalityReference: id(7),
    decidedAt: record.occurredAt,
  };
  const authorize = vi.fn(async () => true),
    evidence = vi.fn(async () => ({})),
    tx = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
  mock.payment.mockResolvedValue({ status: "Committed", record: fact });
  mock.closure.mockResolvedValue({ status: "Committed", record });
  const service = createSettledOrderClose({
    payment: {
      scope,
      providerAccountReference: id(8),
      environment: "Test",
      authorize: async () => true,
      audit: async () => ({}),
    },
    closure: { ...scope, authorize, audit: async () => ({}) },
    closeEvidence: evidence,
  });
  return {
    service,
    tx,
    fact,
    record,
    authorize,
    evidence,
    run: () => service.commit(tx, { closure: record, financial: {} }),
  };
}
it("commits both owner facts under one savepoint", async () => {
  const f = fixture();
  expect((await f.run()).status).toBe("Committed");
  expect(f.tx.query.mock.calls.map((c) => c[0])).toEqual([
    "SAVEPOINT settled_order_close",
    "RELEASE SAVEPOINT settled_order_close",
  ]);
  expect(mock.payment.mock.invocationCallOrder[0]).toBeLessThan(
    mock.closure.mock.invocationCallOrder[0] ?? -1,
  );
  const options = mock.options.mock.calls[0]?.[0];
  await options.closeEvidence(f.tx, f.record);
  expect(f.evidence).toHaveBeenCalledWith(f.tx, f.record, f.fact);
});
it("exact paired replay creates no extra owner facts", async () => {
  const f = fixture();
  mock.payment.mockResolvedValue({ status: "AlreadyCommitted", record: f.fact });
  mock.closure.mockResolvedValue({ status: "AlreadyCommitted", record: f.record });
  expect((await f.run()).status).toBe("AlreadyCommitted");
});
it.each(["payment", "closure"] as const)("rolls both back when %s fails", async (key) => {
  const f = fixture();
  mock[key].mockRejectedValue(new Error("owner failure"));
  await expect(f.run()).rejects.toThrow();
  expect(f.tx.query.mock.calls.map((c) => c[0])).toContain(
    "ROLLBACK TO SAVEPOINT settled_order_close",
  );
});
it.each(["financial", "closure"])("refuses unpaired %s replay", async (key) => {
  const f = fixture();
  if (key === "financial")
    mock.payment.mockResolvedValue({ status: "AlreadyCommitted", record: f.fact });
  else mock.closure.mockResolvedValue({ status: "AlreadyCommitted", record: f.record });
  await expect(f.run()).rejects.toThrow();
  expect(f.tx.query.mock.calls.map((c) => c[0])).toContain(
    "ROLLBACK TO SAVEPOINT settled_order_close",
  );
});
it.each([
  "tenantReference",
  "storeReference",
  "orderReference",
  "orderVersion",
  "decidedAt",
  "finalityReference",
])("rejects mismatched finality %s", async (key) => {
  const f = fixture();
  mock.payment.mockResolvedValue({ status: "Committed", record: { ...f.fact, [key]: "invalid" } });
  await expect(f.run()).rejects.toThrow();
  expect(mock.closure).not.toHaveBeenCalled();
});
it("denies unauthorized writes before savepoint or Payment", async () => {
  const f = fixture();
  f.authorize.mockResolvedValue(false);
  await expect(f.run()).rejects.toThrow();
  expect(f.tx.query).not.toHaveBeenCalled();
  expect(mock.payment).not.toHaveBeenCalled();
});

it("prepares closure only from actual returned owner finality", async () => {
  const f = fixture(),
    prepare = vi.fn(async (fact) => {
      expect(fact).toBe(f.fact);
      return f.record;
    });
  expect(
    (
      await f.service.commitPrepared(f.tx, {
        financial: {},
        authorizeIntent: async () => true,
        prepareClosure: prepare,
      })
    ).status,
  ).toBe("Committed");
  expect(mock.payment.mock.invocationCallOrder[0]).toBeLessThan(
    prepare.mock.invocationCallOrder[0] ?? -1,
  );
});
it("preparation failure rolls back the already computed financial fact", async () => {
  const f = fixture();
  await expect(
    f.service.commitPrepared(f.tx, {
      financial: {},
      authorizeIntent: async () => true,
      prepareClosure: async () => {
        throw new Error("evidence unavailable");
      },
    }),
  ).rejects.toThrow();
  expect(f.tx.query.mock.calls.map((c) => c[0])).toContain(
    "ROLLBACK TO SAVEPOINT settled_order_close",
  );
  expect(mock.closure).not.toHaveBeenCalled();
});
it("denied intent cannot write financial facts", async () => {
  const f = fixture();
  await expect(
    f.service.commitPrepared(f.tx, {
      financial: {},
      authorizeIntent: async () => false,
      prepareClosure: async () => f.record,
    }),
  ).rejects.toThrow();
  expect(mock.payment).not.toHaveBeenCalled();
  expect(f.tx.query).not.toHaveBeenCalled();
});
it("revoked record authority after preparation rolls back", async () => {
  const f = fixture();
  f.authorize.mockResolvedValue(false);
  await expect(
    f.service.commitPrepared(f.tx, {
      financial: {},
      authorizeIntent: async () => true,
      prepareClosure: async () => f.record,
    }),
  ).rejects.toThrow();
  expect(mock.closure).not.toHaveBeenCalled();
  expect(f.tx.query.mock.calls.map((c) => c[0])).toContain(
    "ROLLBACK TO SAVEPOINT settled_order_close",
  );
});
