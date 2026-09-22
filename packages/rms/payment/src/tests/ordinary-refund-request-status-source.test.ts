import { beforeEach, expect, it, vi } from "vitest";
import { createPostgresOrdinaryRefundRequestStatusSource } from "../infrastructure/ordinary-refund-request-status-source.js";
import {
  ordinaryRefundRequestFixture,
  refundRequestId as id,
} from "./ordinary-refund-request.fixture.js";
import type { ConsumerTransaction } from "@bop/eventing";
const d = vi.hoisted(() => ({
  context: vi.fn(),
  prepared: vi.fn(),
  outcome: vi.fn(),
  recovery: vi.fn(),
}));
vi.mock("../infrastructure/persistence/ordinary-refund-request-store.js", () => ({
  createPostgresOrdinaryRefundRequestContextSource: () => d.context,
}));
vi.mock("../infrastructure/persistence/ordinary-refund-operation-store.js", () => ({
  createPostgresOrdinaryRefundClaimOutcomeReader: () => d.outcome,
  createPostgresOrdinaryRefundPreparedReader: () => d.prepared,
}));
vi.mock("../infrastructure/ordinary-refund-recovery-source.js", () => ({
  createPostgresOrdinaryRefundRecoverySource: () => d.recovery,
}));
const request = ordinaryRefundRequestFixture();
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const query = {
  orderReference: id(4),
  operationReference: id(6),
  observedAt: "2026-09-20T12:00:00.000Z",
};
const tx = {} as ConsumerTransaction;
const make = (authorize = vi.fn(async () => true)) =>
  createPostgresOrdinaryRefundRequestStatusSource({
    scope,
    providerAccountReference: id(20),
    environment: "Test",
    authorize,
  });
const outcome = (confirmed: boolean) => {
  const value = {
    operation: {
      ...request.payments[0],
      operationReference: id(40),
      amountMinor: 6000n,
      providerAccountReference: id(20),
      environment: "Test",
    },
    position: {
      state: confirmed ? "Confirmed" : "NeedsReconciliation",
      confirmedMinor: confirmed ? 6000n : 0n,
      pendingMinor: confirmed ? 0n : 6000n,
      releasedMinor: 0n,
      providerRefundReference: "private",
    },
  };
  d.prepared.mockResolvedValue(value.operation);
  return value;
};
beforeEach(() => {
  vi.resetAllMocks();
  d.context.mockResolvedValue({ existing: request, history: [request] });
  d.outcome.mockResolvedValue(null);
  d.prepared.mockResolvedValue(null);
});
it("reads a recorded request as not dispatched with its amount still reserved", async () => {
  const result = await make()(tx, query);
  expect(result.payments).toEqual([
    {
      paymentAttemptReference: id(11),
      paymentIntentReference: id(10),
      state: "NotDispatched",
      executionOperationReference: null,
      amountMinor: "6000",
      confirmedMinor: "0",
      pendingMinor: "6000",
    },
  ]);
  expect(d.context).toHaveBeenCalledWith(tx, query);
  expect(d.outcome).toHaveBeenCalledWith(tx, {
    orderReference: id(4),
    requestReference: id(5),
    paymentAttemptReference: id(11),
    observedAt: query.observedAt,
  });
  expect(d.recovery).not.toHaveBeenCalled();
});
it.each([false, true])("reports actual persisted outcome only, confirmed=%s", async (confirmed) => {
  d.outcome.mockResolvedValue(outcome(confirmed));
  const result = await make()(tx, query);
  expect(result.payments[0]?.state).toBe(confirmed ? "Confirmed" : "NeedsReconciliation");
  expect(JSON.stringify(result)).not.toContain("private");
});
it.each([
  "providerAccountReference",
  "environment",
  "paymentIntentReference",
  "firstCaptureReference",
  "amountMinor",
])("denies mismatched operation %s", async (key) => {
  const value = outcome(true);
  Object.assign(value.operation, { [key]: key === "amountMinor" ? 5999n : "wrong" });
  d.outcome.mockResolvedValue(value);
  await expect(make()(tx, query)).rejects.toThrow("ORDINARY_REFUND_STATUS_UNAVAILABLE");
});
it("denies missing request, changed authorization and invalid money coverage", async () => {
  d.context.mockResolvedValueOnce({ existing: null, history: [] });
  await expect(make()(tx, query)).rejects.toThrow();
  const authorize = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(make(authorize)(tx, query)).rejects.toThrow();
  const value = outcome(true);
  value.position.pendingMinor = 1n;
  d.outcome.mockResolvedValue(value);
  await expect(make()(tx, query)).rejects.toThrow();
});
it("rejects extra query fields before owner reads", async () => {
  await expect(make()(tx, { ...query, actorReference: id(99) })).rejects.toThrow();
  expect(d.context).not.toHaveBeenCalled();
});

it("keeps a multi-payment request partially confirmed without promoting its unsent leg", async () => {
  const first = request.payments[0];
  if (!first) throw new Error("fixture missing");
  const second = {
    ...first,
    paymentIntentReference: id(30),
    paymentAttemptReference: id(31),
    paymentTransactionReference: id(32),
    firstCaptureReference: id(33),
  };
  d.context.mockResolvedValue({
    existing: { ...request, amountMinor: 12000n, payments: [first, second] },
    history: [],
  });
  const confirmed = outcome(true);
  d.prepared.mockResolvedValueOnce(confirmed.operation).mockResolvedValueOnce(null);
  d.outcome.mockResolvedValueOnce(confirmed).mockResolvedValueOnce(null);
  const result = await make()(tx, query);
  expect(result.amountMinor).toBe("12000");
  expect(result.payments.map((p) => p.state)).toEqual(["Confirmed", "NotDispatched"]);
  expect(result.payments.map((p) => p.confirmedMinor)).toEqual(["6000", "0"]);
  expect(result.payments.map((p) => p.pendingMinor)).toEqual(["0", "6000"]);
});

it("recovers prepared operation identity without promoting it to dispatch", async () => {
  const prepared = outcome(false).operation;
  d.prepared.mockResolvedValue(prepared);
  const result = await make()(tx, query);
  expect(result.payments[0]?.state).toBe("Prepared");
  expect(result.payments[0]?.executionOperationReference).toBe(id(40));
  expect(result.payments[0]?.pendingMinor).toBe("6000");
});
