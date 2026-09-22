import type { ConsumerTransaction } from "@bop/eventing";
import { expect, it, vi } from "vitest";
import { createDiningBatchCancellationDispatcher } from "./dining-batch-cancellation-dispatcher.js";
const id = (n: number) => `0190ee34-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const at = "2026-09-21T01:00:00.000Z";
function expiry(n = 20) {
  return {
    ...scope,
    orderReference: id(4),
    orderBatchReference: id(n + 1),
    submissionReference: id(n + 2),
    paymentOperationReference: id(n + 3),
    commitmentReference: id(n + 4),
    recordReference: id(n),
    previousRecordReference: null,
    version: 1,
    paymentRequestedAt: "2026-09-21T00:00:00.000Z",
    capacityExpiresAt: "2026-09-21T00:30:00.000Z",
    observedAt: "2026-09-21T00:31:00.000Z",
    evidenceDigest: "sha256:" + "a".repeat(64),
    status: "PaymentFailed",
    paymentEvidence: {
      paymentIntentReference: id(n + 5),
      paymentAttemptReference: id(n + 6),
      paymentEventReference: id(n + 7),
      outcome: "Failed",
      occurredAt: "2026-09-21T00:10:00.000Z",
    },
  };
}
function receipt(e = expiry()) {
  return {
    status: "Created",
    record: {
      ...scope,
      orderReference: e.orderReference,
      orderBatchReference: e.orderBatchReference,
      submissionReference: e.submissionReference,
      paymentOperationReference: e.paymentOperationReference,
      operationReference: e.recordReference,
      cancellationReference: id(100),
      expiryRecordReference: e.recordReference,
      expiryEvidenceDigest: e.evidenceDigest,
      expectedOrderVersion: 7,
      cancelledOrderVersion: 8,
      expectedSourceCheckpoint: id(101),
      workflowVersionReference: id(102),
      transitionReference: id(103),
      orderItemReferences: [id(104)],
      cancelledAt: at,
      phase: "Cancelled",
      reasonCode: "CHECKOUT_DEADLINE_REACHED",
    },
  };
}
function fixture() {
  let scanning = false;
  const discover = vi.fn().mockResolvedValue([expiry()]);
  const cancel = vi.fn().mockImplementation(async ({ expiry: e }) => {
    expect(scanning).toBe(false);
    return receipt(e);
  });
  const options = {
    scope,
    pageSize: 2,
    now: () => at,
    transactions: {
      async run<T>(work: (tx: ConsumerTransaction) => Promise<T>) {
        scanning = true;
        try {
          return await work({ query: async () => ({ rows: [], rowCount: 0 }) });
        } finally {
          scanning = false;
        }
      },
    },
    discover,
    cancel,
  };
  return {
    options,
    discover,
    cancel,
    dispatcher: createDiningBatchCancellationDispatcher(options),
  };
}
it("reuses the same immutable operation after response loss and process restart", async () => {
  const f = fixture();
  f.cancel.mockRejectedValueOnce(new Error("RESPONSE_LOST"));
  await expect(f.dispatcher.runOnce()).rejects.toThrow("RESPONSE_LOST");
  expect(await f.dispatcher.runOnce()).toBe(1);
  const restarted = createDiningBatchCancellationDispatcher(f.options);
  expect(await restarted.runOnce()).toBe(1);
  expect(f.cancel.mock.calls.map(([input]) => input.operationReference)).toEqual([
    id(20),
    id(20),
    id(20),
  ]);
  expect(f.discover.mock.calls.map(([, query]) => query.after)).toEqual([null, null, null]);
});
it("advances a full page only after bound receipts and wraps after a short page", async () => {
  const f = fixture();
  f.discover.mockResolvedValueOnce([expiry(20), expiry(40)]).mockResolvedValueOnce([]);
  expect(await f.dispatcher.runOnce()).toBe(2);
  expect(await f.dispatcher.runOnce()).toBe(0);
  await f.dispatcher.runOnce();
  expect(f.discover.mock.calls.map(([, query]) => query.after)).toEqual([null, id(40), null]);
});
it.each(["scope", "paid", "unknown", "future", "order", "duplicate", "overflow"])(
  "rejects an invalid whole page (%s) before any cancellation",
  async (kind) => {
    const f = fixture();
    const a = expiry(),
      b = expiry(40);
    let page: unknown[] = [a, b];
    if (kind === "scope") b.storeReference = id(999);
    if (kind === "paid") {
      b.status = "PaidBeforeDeadline";
      b.paymentEvidence.outcome = "Succeeded";
    }
    if (kind === "unknown")
      page = [a, { ...b, status: "AwaitingPaymentResolution", paymentEvidence: null }];
    if (kind === "future") b.observedAt = "2026-09-21T02:00:00.000Z";
    if (kind === "order") page = [b, a];
    if (kind === "duplicate") b.orderBatchReference = a.orderBatchReference;
    if (kind === "overflow") page = [a, b, expiry(60)];
    f.discover.mockResolvedValue(page);
    await expect(f.dispatcher.runOnce()).rejects.toThrow();
    expect(f.cancel).not.toHaveBeenCalled();
  },
);
it("retains the cursor when a receipt belongs to another operation", async () => {
  const f = fixture();
  f.cancel.mockResolvedValueOnce({
    ...receipt(),
    record: { ...receipt().record, operationReference: id(777) },
  });
  await expect(f.dispatcher.runOnce()).rejects.toThrow();
  expect(await f.dispatcher.runOnce()).toBe(1);
  expect(f.cancel.mock.calls[0]?.[0]).toEqual(f.cancel.mock.calls[1]?.[0]);
});
it("coalesces polls and drains only the already started command", async () => {
  const f = fixture();
  f.discover.mockResolvedValue([expiry(), expiry(40)]);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  f.cancel.mockImplementation(async () => {
    entered();
    await held;
    return receipt();
  });
  const first = f.dispatcher.runOnce();
  expect(f.dispatcher.runOnce()).toBe(first);
  await started;
  const stopping = f.dispatcher.stop();
  release();
  expect(await first).toBe(1);
  expect(await stopping).toBe("drained");
  expect(f.cancel).toHaveBeenCalledTimes(1);
  expect(await f.dispatcher.runOnce()).toBe(0);
});
it.each([0, 101, 1.5])("refuses invalid page bound %s", (pageSize) => {
  const f = fixture();
  expect(() => createDiningBatchCancellationDispatcher({ ...f.options, pageSize })).toThrow();
});
